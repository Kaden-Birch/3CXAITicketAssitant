import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Store } from "../../../apps/server/src/store.ts";
import { SyncroReadClient } from "../../syncro/src/read-client.ts";
import { normalizeClinic, selectClinic } from "../../syncro/src/matching.ts";
import {
  callbackDigits,
  explicitYes,
  validateCallback,
  hasSpokenValue,
  capturedIdentifier,
  spelledName,
  fullNameAnswer,
} from "./fields.ts";
const short = z.string().max(150);
const fieldSchema = z
  .object({
    firstName: short,
    lastName: short,
    callbackNumber: short,
    workstationNumber: short,
    printerIdentifier: short,
    phoneExtension: short,
    deviceLocation: short,
    issueType: z.enum(["computer", "printer", "phone", "other"]),
    summary: z.string().max(180),
    details: z.string().max(1500),
  })
  .partial()
  .strict();
const fieldNames = [
  "firstName",
  "lastName",
  "callbackNumber",
  "workstationNumber",
  "printerIdentifier",
  "phoneExtension",
  "deviceLocation",
] as const;
const confirmable = z.enum(fieldNames);
const schemas = {
  match_clinic: z
    .object({
      name: short.min(5),
      confirm: z.boolean().optional(),
      unmatched: z.boolean().optional(),
    })
    .strict(),
  update_intake: z
    .object({
      fields: fieldSchema,
      unavailable: z.array(confirmable).max(7).optional(),
    })
    .strict(),
  confirm_intake: z
    .object({ fields: z.array(confirmable).min(1).max(7) })
    .strict(),
  prepare_ticket: z.object({}).strict(),
  create_ticket: z.object({ draftId: z.uuid() }).strict(),
  transfer_to_support: z
    .object({ reason: z.string().min(1).max(300) })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  match_clinic:
    "Match only a clinic name already spoken by this caller; returns at most one similar name without IDs. Use confirm after a new explicit yes to bind that same suggestion. Use unmatched only when the caller cannot resolve the clinic.",
  update_intake:
    "Save caller-provided facts as they arrive or are corrected. Partial updates preserve other fields and clear confirmation only for changed fields. Store exact devices and original callback digits. Mark unavailable only after caller says they cannot provide a field.",
  confirm_intake:
    "Normally unnecessary: yes replies to spoken readbacks are recognized automatically. Already confirmed fields stay confirmed. Do not use this as a checklist or repeat name/device questions; those fields are included in the final summary.",
  prepare_ticket:
    "Prepare the short final summary after collecting the facts. Names do not need confirmation. Devices can be included in this summary, not checked separately. Speak spokenSummary once; after a fresh yes immediately call create_ticket. Do not ask whether the caller is ready or ask them to write the summary.",
  create_ticket:
    "Submit the prepared ticket once after a new explicit yes. Only report a real ticket number if success is true. Never retry an unknown submission outcome.",
  transfer_to_support:
    "Request the authorized support fallback. Browser tests cannot connect a technician; never claim a connection.",
};
export const demoToolDefinitions = Object.entries(schemas).map(
  ([name, schema]) => ({
    type: "function",
    name,
    description: descriptions[name as keyof typeof schemas],
    parameters: z.toJSONSchema(schema),
  }),
);
type Field = (typeof fieldNames)[number];
type IntakeState = {
  fields: Record<string, string>;
  confirmed: Partial<Record<Field, boolean>>;
  updatedTurns: Partial<Record<Field, number>>;
  unavailable: Field[];
  callback: ReturnType<typeof validateCallback> | null;
  clinic: { id: string; name: string } | null;
  clinicConfirmed: boolean;
  clinicTurn: number;
  unmatched: boolean;
  correctionPending?: string[];
  evidenceTurns?: Partial<Record<Field, number>>;
  evidencePositions?: Partial<Record<Field, number>>;
};
export class DemoIntake {
  private draft: { id: string; turn: number } | null = null;
  private latestTurn = -1;
  private latestCommitted = -1;
  private latestText = "";
  private evidence: { index: number; text: string }[] = [];
  private readbacks: {
    turn: number;
    item: string;
    text: string;
    confirmation: boolean;
    fields: Partial<Record<Field, string>>;
    clinic: boolean;
    draftId: string | null;
  }[] = [];
  private confirmedByReadback = new Map<Field, string>();
  private finalReadback: { draftId: string; turn: number } | null = null;
  private matchingAttempts = 0;
  private state: IntakeState;
  constructor(
    private sessionId: string,
    private store: Store,
    private syncro: SyncroReadClient,
    private sanitize: (text: string) => string,
    private event: (type: string, text: string) => void,
    private mode: "preview" | "live_test" = "preview",
  ) {
    const stored = store.db
      .prepare("SELECT content_json FROM intake_state WHERE session_id=?")
      .get(sessionId);
    this.state = stored
      ? JSON.parse(String(stored.content_json))
      : {
          fields: {},
          confirmed: {},
          updatedTurns: {},
          unavailable: [],
          callback: null,
          clinic: null,
          clinicConfirmed: false,
          clinicTurn: -1,
          unmatched: false,
        };
    this.persist();
  }
  private persist() {
    this.store.db
      .prepare(
        "INSERT INTO intake_state VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET content_json=excluded.content_json,updated_at=excluded.updated_at",
      )
      .run(
        this.sessionId,
        JSON.stringify(this.state),
        new Date().toISOString(),
      );
  }
  callerCommitted(index: number) {
    this.latestCommitted = index;
  }
  callerTurn(index: number, text: string) {
    if (index < 0) return;
    this.evidence = this.evidence.filter((e) => e.index !== index);
    this.evidence.push({ index, text });
    this.evidence.sort((a, b) => a.index - b.index);
    if (this.evidence.length > 30) this.evidence.shift();
    if (index >= this.latestTurn) {
      this.latestTurn = index;
      this.latestText = text;
    }
    const readback = this.readbacks.filter((r) => r.turn < index).at(-1);
    const capturedName = /\bfull name\b|\bfirst and last\b/i.test(
      readback?.text ?? "",
    )
      ? fullNameAnswer(text)
      : null;
    if (capturedName && !this.immutable()) {
      for (const [key, value] of Object.entries(capturedName)) {
        const field = key as Field;
        if (
          index <
            (this.state.evidenceTurns?.[field] ??
              this.state.updatedTurns[field] ??
              -1) ||
          this.state.fields[field] === value
        )
          continue;
        this.invalidateDraft();
        this.state.fields[field] = value;
        this.state.confirmed[field] = false;
        this.state.updatedTurns[field] = index;
        this.state.evidenceTurns ??= {};
        this.state.evidenceTurns[field] = index;
        this.state.evidencePositions ??= {};
        this.state.evidencePositions[field] = text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "")
          .lastIndexOf(value.toLowerCase());
      }
      this.state.correctionPending = (
        this.state.correctionPending ?? []
      ).filter((f) => f !== "name");
      this.persist();
    }
    const nameFields = /\bfirst name\b/i.test(readback?.text ?? "")
      ? (["firstName"] as Field[])
      : /\b(?:last name|surname)\b/i.test(readback?.text ?? "")
        ? (["lastName"] as Field[])
        : (Object.keys(readback?.fields ?? {}).filter(
            (f) => f === "firstName" || f === "lastName",
          ) as Field[]);
    const correctedName = /^no\b/i.test(text.trim()) ? spelledName(text) : null;
    if (correctedName && nameFields.length === 1 && !this.immutable()) {
      const field = nameFields[0];
      if (
        index >=
        (this.state.evidenceTurns?.[field] ??
          this.state.updatedTurns[field] ??
          -1)
      ) {
        this.invalidateDraft();
        this.state.fields[field] = correctedName;
        this.state.confirmed[field] = false;
        this.state.updatedTurns[field] = index;
        this.state.evidenceTurns ??= {};
        this.state.evidenceTurns[field] = index;
        this.state.evidencePositions ??= {};
        this.state.evidencePositions[field] = text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "")
          .lastIndexOf(correctedName.toLowerCase());
        this.state.correctionPending = (
          this.state.correctionPending ?? []
        ).filter((f) => f !== "name");
        this.persist();
      }
    }
    this.recognizeConfirmation();
    if (
      /\b(?:actually|correction|correct my|change|wrong|incorrect|my name is not|that's not)\b/i.test(
        text,
      )
    ) {
      const groups = [
        "name",
        "callback",
        "workstation",
        "printer",
        "extension",
        "location",
        "clinic",
      ].filter((group) => new RegExp(`\\b${group}\\b`, "i").test(text));
      if (!groups.length && /\bnumber\b/i.test(text)) groups.push("callback");
      this.state.correctionPending = [
        ...new Set([
          ...(this.state.correctionPending ?? []),
          ...(groups.length ? groups : ["detail"]),
        ]),
      ];
      this.invalidateDraft();
      this.persist();
    }
  }
  assistantTurn(text: string, turn = this.latestCommitted, item = "") {
    if (
      !text.includes("?") &&
      !/\b(?:is that right|is that correct|can you confirm)\b/i.test(text)
    )
      return;
    const confirmationQuestion =
      /\b(?:confirm|correct|right|accurate|did you mean|is your|is it|is that|is this)\b|\bis\b.*\b(?:callback|number|spelled|name)\b/i.test(
        text,
      );
    const fields = confirmationQuestion
      ? this.matchingReadbackFields(text)
      : {};
    const clinic =
      confirmationQuestion &&
      !!this.state.clinic &&
      normalizeClinic(text).includes(normalizeClinic(this.state.clinic.name));
    const draft = this.preview();
    const final =
      confirmationQuestion &&
      draft &&
      turn >= this.draft!.turn &&
      hasSpokenValue(
        text,
        draft.content.summary.split(/\s+/).slice(0, 12).join(" "),
      ) &&
      (draft.content.confirmationFields as Field[]).every(
        (f) => fields[f] === this.state.fields[f],
      );
    this.readbacks.push({
      turn,
      item,
      text,
      confirmation: confirmationQuestion,
      fields,
      clinic,
      draftId: final ? draft!.draftId : null,
    });
    this.readbacks.sort((a, b) => a.turn - b.turn);
    if (this.readbacks.length > 30) this.readbacks.shift();
    if (/\bfull name\b|\bfirst and last\b/i.test(text)) {
      const answer = this.evidence.find((e) => e.index === turn + 1);
      if (answer) this.callerTurn(answer.index, answer.text);
    }
    if (final) this.finalReadback = { draftId: draft!.draftId, turn };
    this.recognizeConfirmation();
  }
  assistantInterrupted(item: string) {
    const removed = this.readbacks.filter((r) => r.item === item);
    this.readbacks = this.readbacks.filter((r) => r.item !== item);
    if (removed.some((r) => r.draftId === this.finalReadback?.draftId))
      this.finalReadback = null;
    for (const [field, source] of this.confirmedByReadback)
      if (source === item) {
        this.state.confirmed[field] = false;
        this.confirmedByReadback.delete(field);
      }
    this.persist();
  }
  private matchingReadbackFields(text: string) {
    const fields: Partial<Record<Field, string>> = {};
    for (const field of fieldNames) {
      const value = this.state.fields[field];
      if (!value) continue;
      const matched =
        field === "callbackNumber"
          ? !!this.state.callback?.e164 &&
            callbackDigits(text).includes(this.state.callback.e164.slice(2))
          : ["workstationNumber", "printerIdentifier"].includes(field)
            ? capturedIdentifier(text, value)?.toLowerCase() ===
              value.toLowerCase()
            : hasSpokenValue(
                text,
                value,
                !["firstName", "lastName", "deviceLocation"].includes(field),
              );
      if (matched) fields[field] = value;
    }
    return fields;
  }
  private recognizeConfirmation() {
    if (
      this.latestTurn !== this.latestCommitted ||
      !explicitYes(this.latestText)
    )
      return;
    const readback = this.readbacks
      .filter((r) => r.turn < this.latestTurn)
      .at(-1);
    if (!readback) return;
    for (const [field, value] of Object.entries(
      readback.confirmation ? this.matchingReadbackFields(readback.text) : {},
    )) {
      if (
        !this.state.confirmed[field as Field] &&
        this.state.fields[field] === value &&
        readback.turn >= (this.state.updatedTurns[field as Field] ?? -1) &&
        this.latestTurn > (this.state.updatedTurns[field as Field] ?? -1)
      ) {
        this.state.confirmed[field as Field] = true;
        this.confirmedByReadback.set(field as Field, readback.item);
      }
    }
    if (
      readback.clinic &&
      readback.turn >= this.state.clinicTurn &&
      this.state.clinic &&
      normalizeClinic(readback.text).includes(
        normalizeClinic(this.state.clinic.name),
      ) &&
      this.latestTurn > this.state.clinicTurn
    ) {
      this.state.clinicConfirmed = true;
      this.store.db
        .prepare("UPDATE sessions SET clinic_name=? WHERE id=?")
        .run(this.state.clinic!.name, this.sessionId);
    }
    this.persist();
  }
  hasNewCallerTurn() {
    return !!this.draft && this.latestTurn > this.draft.turn;
  }
  transcriptCurrent() {
    return this.latestTurn === this.latestCommitted;
  }
  private yesAfter(turn: number) {
    return (
      this.latestTurn === this.latestCommitted &&
      this.latestTurn > turn &&
      explicitYes(this.latestText)
    );
  }
  private view() {
    return {
      fields: this.state.fields,
      confirmed: this.state.confirmed,
      unavailable: this.state.unavailable,
      callbackValid: !!this.state.callback?.e164,
      clinicConfirmed: this.state.clinicConfirmed,
      unmatchedClinic: this.state.unmatched,
    };
  }
  private immutable() {
    return !!this.store.db
      .prepare(
        "SELECT id FROM ticket_drafts WHERE session_id=? AND status IN ('submitting','created','unknown_outcome','failed','preview_confirmed') LIMIT 1",
      )
      .get(this.sessionId);
  }
  private invalidateDraft() {
    this.finalReadback = null;
    if (this.draft) {
      this.store.db
        .prepare(
          "UPDATE ticket_drafts SET status='superseded' WHERE id=? AND status='preview'",
        )
        .run(this.draft.id);
      this.draft = null;
    }
  }
  private clarification(field: string, question: string) {
    return { status: "clarification_required", field, question };
  }
  private supportingValue(field: Field, value: string) {
    const floor =
      this.state.evidenceTurns?.[field] ?? this.state.updatedTurns[field] ?? -1;
    for (const evidence of [...this.evidence].reverse()) {
      if (evidence.index < floor) continue;
      let captured: string | null = null;
      if (field === "callbackNumber") {
        if (
          callbackDigits(value).length >= 7 &&
          callbackDigits(evidence.text).includes(callbackDigits(value))
        )
          captured = value;
      } else if (["workstationNumber", "printerIdentifier"].includes(field)) {
        captured = capturedIdentifier(evidence.text, value);
      } else if (
        hasSpokenValue(
          evidence.text,
          value,
          !["firstName", "lastName", "deviceLocation"].includes(field),
        )
      )
        captured = value;
      if (!captured) continue;
      const compact = (v: string) =>
        field === "callbackNumber"
          ? callbackDigits(v)
          : v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const position = compact(evidence.text).lastIndexOf(compact(captured));
      if (
        captured !== this.state.fields[field] &&
        evidence.index === floor &&
        position <= (this.state.evidencePositions?.[field] ?? -1)
      )
        continue;
      return { value: captured, turn: evidence.index, position };
    }
    return null;
  }
  async execute(name: string, raw: unknown): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) throw new Error("TOOL_NOT_ALLOWED");
    const args: any = schemas[name as keyof typeof schemas].parse(raw);
    switch (name) {
      case "match_clinic": {
        if (this.immutable()) return { status: "submission_locked" };
        if (
          this.state.clinicConfirmed &&
          this.state.clinic &&
          selectClinic(args.name, [this.state.clinic]) &&
          !(this.state.correctionPending ?? []).includes("clinic")
        )
          return { status: "confirmed" };
        if (args.confirm) {
          if (
            !this.state.clinic ||
            normalizeClinic(args.name) !==
              normalizeClinic(this.state.clinic.name) ||
            !this.yesAfter(this.state.clinicTurn) ||
            !this.readbacks.filter((r) => r.turn < this.latestTurn).at(-1)
              ?.clinic
          )
            return this.clarification(
              "clinic",
              "Please confirm the suggested clinic name.",
            );
          this.state.clinicConfirmed = true;
          this.state.unmatched = false;
          this.persist();
          this.store.db
            .prepare(
              "UPDATE sessions SET clinic_name=?,state='collecting' WHERE id=?",
            )
            .run(this.state.clinic.name, this.sessionId);
          this.event(
            "clinic.matched",
            "One caller-confirmed clinic bound server-side",
          );
          return { status: "confirmed" };
        }
        if (
          !this.evidence.some((t) =>
            normalizeClinic(t.text).includes(normalizeClinic(args.name)),
          )
        )
          return this.clarification("clinic", "What is the clinic name?");
        if (args.unmatched) {
          this.invalidateDraft();
          this.state.clinic = null;
          this.state.clinicConfirmed = false;
          this.state.unmatched = true;
          this.persist();
          this.store.db
            .prepare("UPDATE sessions SET clinic_name=? WHERE id=?")
            .run(this.sanitize(args.name), this.sessionId);
          return {
            status: "unmatched",
            instruction:
              "Continue collecting caller facts; real submission needs human review.",
          };
        }
        if (++this.matchingAttempts > 5)
          return {
            status: "unmatched",
            instruction:
              "Matching limit reached; ask for spelling or human support. Do not enumerate clinics.",
          };
        this.invalidateDraft();
        this.state.clinicConfirmed = false;
        this.state.correctionPending = (
          this.state.correctionPending ?? []
        ).filter((f) => f !== "clinic");
        this.state.clinic = selectClinic(
          args.name,
          await this.syncro.clinics(this.sanitize(args.name)),
        );
        this.state.clinicTurn = this.latestCommitted;
        this.persist();
        this.store.db
          .prepare(
            "UPDATE sessions SET state='awaiting_clinic_confirmation' WHERE id=?",
          )
          .run(this.sessionId);
        return this.state.clinic
          ? {
              status: "confirmation_required",
              suggested_clinic_name: this.sanitize(this.state.clinic.name),
            }
          : this.clarification("clinic", "Could you spell the clinic name?");
      }
      case "update_intake": {
        if (this.immutable())
          return {
            status: "submission_locked",
            instruction:
              "The recorded submission cannot be changed or retried. Offer human review.",
          };
        const problems: {
          field: string;
          question: string;
          repair?: boolean;
        }[] = [];
        for (const [field, rawValue] of Object.entries(
          args.fields as Record<string, string>,
        )) {
          let value = this.sanitize(rawValue);
          if (this.state.fields[field] === value) continue;
          if (
            field === "callbackNumber" &&
            this.state.callback?.e164 &&
            validateCallback(value).e164 === this.state.callback.e164
          )
            continue;
          const guarded = fieldNames.includes(field as Field);
          let sourceTurn = this.latestCommitted;
          let sourcePosition = -1;
          if (guarded && value) {
            const supported = this.supportingValue(field as Field, value);
            if (!supported) {
              problems.push({
                field,
                repair: !!this.state.fields[field],
                question: this.state.fields[field]
                  ? `Use the captured ${field}: ${this.state.fields[field]}. Do not substitute another value or repeat a question already answered clearly.`
                  : `Please repeat or spell the ${field}.`,
              });
              continue;
            }
            value = supported.value;
            sourceTurn = supported.turn;
            sourcePosition = supported.position;
            if (this.state.fields[field] === value) continue;
          }
          this.invalidateDraft();
          this.state.fields[field] = value;
          const group =
            field === "firstName" || field === "lastName"
              ? "name"
              : field === "callbackNumber"
                ? "callback"
                : field === "workstationNumber"
                  ? "workstation"
                  : field === "printerIdentifier"
                    ? "printer"
                    : field === "phoneExtension"
                      ? "extension"
                      : field === "deviceLocation"
                        ? "location"
                        : "detail";
          this.state.correctionPending = (
            this.state.correctionPending ?? []
          ).filter((f) => f !== group && f !== "detail");
          if (guarded) {
            this.state.confirmed[field as Field] = false;
            this.state.updatedTurns[field as Field] = sourceTurn;
            this.state.evidenceTurns ??= {};
            this.state.evidenceTurns[field as Field] = sourceTurn;
            this.state.evidencePositions ??= {};
            this.state.evidencePositions[field as Field] = sourcePosition;
            this.confirmedByReadback.delete(field as Field);
            this.state.unavailable = this.state.unavailable.filter(
              (f) => f !== field,
            );
          }
          if (field === "callbackNumber") {
            this.state.callback = validateCallback(value);
            this.store.db
              .prepare("UPDATE sessions SET caller_number_masked=? WHERE id=?")
              .run(
                this.state.callback.e164
                  ? `***-***-${this.state.callback.e164.slice(-4)}`
                  : "Unverified",
                this.sessionId,
              );
            if (!this.state.callback.e164)
              problems.push({ field, question: this.state.callback.reason! });
          }
        }
        for (const field of args.unavailable ?? []) {
          if (
            !/\b(?:can't|cannot|don't have|do not have|don't know|do not know|unavailable|no label|no number)\b/i.test(
              this.latestText,
            )
          ) {
            problems.push({ field, question: `Can you provide the ${field}?` });
            continue;
          }
          this.invalidateDraft();
          this.state.unavailable = [
            ...new Set([...this.state.unavailable, field]),
          ] as Field[];
          this.state.fields[field] = "";
          this.state.confirmed[field as Field] = false;
          if (field === "callbackNumber") this.state.callback = null;
        }
        this.recognizeConfirmation();
        this.persist();
        this.event(
          "intake.updated",
          "Caller facts updated; confirmation cleared only for changed fields",
        );
        return {
          ...this.view(),
          instruction:
            "Do not narrate these internal results. Keep captured facts; ask only the next unknown detail. Names need no confirmation. Use the final summary for the issue and device.",
          ...(problems.length
            ? problems[0].repair
              ? {
                  status: "retry_update",
                  field: problems[0].field,
                  instruction: problems[0].question,
                }
              : { status: "clarification_required", ...problems[0] }
            : { status: "saved" }),
        };
      }
      case "confirm_intake": {
        for (const field of args.fields as Field[]) {
          if (
            (field === "firstName" || field === "lastName") &&
            this.state.fields[field]
          )
            continue;
          if (this.state.confirmed[field]) continue;
          if (
            !this.state.fields[field] ||
            (field === "callbackNumber" && !this.state.callback?.e164)
          )
            return this.clarification(
              field,
              field === "callbackNumber"
                ? (this.state.callback?.reason ??
                    "What is your complete callback number?")
                : `What is your ${field}?`,
            );
          return this.clarification(
            field,
            field === "callbackNumber"
              ? `Is ${this.state.fields.callbackNumber} the callback number you want me to use?`
              : `Is ${this.state.fields[field]} correct?`,
          );
        }
        this.persist();
        return {
          status: args.fields.every(
            (f: string) => f === "firstName" || f === "lastName",
          )
            ? "captured"
            : "confirmed",
          ...this.view(),
          instruction:
            "Do not ask for name confirmation. Continue with the next missing fact.",
        };
      }
      case "prepare_ticket": {
        if (this.immutable()) return { status: "submission_locked" };
        const s = this.state;
        if (
          this.mode === "live_test" &&
          ["firstName", "lastName", "callbackNumber"].some((field) =>
            s.unavailable.includes(field as Field),
          )
        ) {
          this.store.db
            .prepare("UPDATE sessions SET state='escalated' WHERE id=?")
            .run(this.sessionId);
          return {
            outcome: "escalated",
            success: false,
            instruction:
              "A reliable caller identity and callback could not be captured. Offer human support; do not create a real ticket.",
          };
        }
        if (s.correctionPending?.length)
          return this.clarification(
            s.correctionPending[0],
            "Could you repeat the corrected detail?",
          );
        if (!s.clinicConfirmed && !s.unmatched)
          return this.clarification(
            "clinic",
            "Could you confirm the clinic name?",
          );
        for (const field of [
          "firstName",
          "lastName",
          "callbackNumber",
        ] as Field[]) {
          if (s.unavailable.includes(field)) continue;
          if (
            !s.fields[field] ||
            (field === "callbackNumber" &&
              (!s.callback?.e164 || !s.confirmed[field]))
          )
            return this.clarification(
              field,
              field === "callbackNumber"
                ? (s.callback?.reason ??
                    `Is ${s.fields.callbackNumber} the callback number you want me to use?`)
                : `What is your ${field === "firstName" ? "first name" : "last name"}?`,
            );
        }
        const requiredDevice =
          s.fields.issueType === "computer"
            ? "workstationNumber"
            : s.fields.issueType === "phone"
              ? "phoneExtension"
              : s.fields.issueType === "printer"
                ? "printerIdentifier"
                : null;
        if (
          requiredDevice &&
          !s.unavailable.includes(requiredDevice) &&
          !s.fields[requiredDevice]
        )
          return this.clarification(
            requiredDevice,
            requiredDevice === "workstationNumber"
              ? "What is the workstation number on the label on the front of the PC?"
              : `What is the ${requiredDevice === "phoneExtension" ? "phone extension" : "printer identifier"}?`,
          );
        if (
          s.fields.issueType === "computer" &&
          s.unavailable.includes("workstationNumber") &&
          !s.unavailable.includes("deviceLocation") &&
          !s.fields.deviceLocation
        )
          return this.clarification(
            "deviceLocation",
            "Which room or desk is the computer in?",
          );
        if (!s.fields.summary)
          return this.clarification(
            "summary",
            "What issue do you need help with?",
          );
        if (this.draft) return this.prepared();
        const draftId = randomUUID();
        const content = {
          ...s.fields,
          clinic: s.clinic?.name ?? "Unmatched clinic",
          clinicId: s.clinic?.id ?? null,
          callerName: [s.fields.firstName, s.fields.lastName]
            .filter(Boolean)
            .join(" "),
          callbackNumber: s.callback?.e164 ?? "Unverified / unavailable",
          callbackOriginal: s.callback?.original ?? "",
          confirmedFields: s.confirmed,
          unavailableFields: s.unavailable,
          source: "ChinookIT Browser Demo",
          writeMode: this.mode,
          confirmationFields: fieldNames.filter(
            (f) =>
              f !== "firstName" &&
              f !== "lastName" &&
              s.fields[f] &&
              !s.confirmed[f],
          ),
        };
        this.store.db
          .prepare("INSERT INTO ticket_drafts VALUES(?,?,?,?,?,?)")
          .run(
            draftId,
            this.sessionId,
            JSON.stringify(content),
            null,
            `${this.sessionId}:${draftId}`,
            "preview",
          );
        this.draft = { id: draftId, turn: this.latestCommitted };
        this.store.db
          .prepare(
            "UPDATE sessions SET state='awaiting_caller_confirmation',summary=? WHERE id=?",
          )
          .run(s.fields.summary, this.sessionId);
        this.event(
          "ticket.draft",
          "Immutable structured ticket prepared; awaiting fresh final confirmation",
        );
        return this.prepared();
      }
      case "create_ticket":
        return this.submit(args.draftId);
      case "transfer_to_support":
        this.store.db
          .prepare("UPDATE sessions SET state='escalated' WHERE id=?")
          .run(this.sessionId);
        this.event(
          "call.transfer_simulated",
          "Support requested; browser has no authorized PBX transfer",
        );
        return {
          status: "unavailable",
          instruction:
            "This browser call cannot connect a technician. Offer the caller's usual support contact route.",
        };
    }
  }
  private prepared() {
    const draft = this.preview()!;
    const content = draft.content;
    const fields = content.confirmationFields as Field[];
    const identity = fields.some((f) => f === "firstName" || f === "lastName")
      ? `${content.callerName}, `
      : "";
    const devices = fields
      .filter((f) => !["firstName", "lastName", "callbackNumber"].includes(f))
      .map((f) => content[f]);
    return {
      draftId: draft.draftId,
      status: "confirmation_required",
      spokenSummary: `${identity}${String(content.summary)
        .split(/\s+/)
        .slice(0, 12)
        .join(" ")
        .replace(
          /[?.!]+$/g,
          "",
        )}${devices.length ? ` on ${devices.join(" / ")}` : ""}. Is that right?`,
    };
  }
  private async submit(draftId: string) {
    if (!this.draft || draftId !== this.draft.id)
      return this.clarification(
        "confirmation",
        "Please confirm the current request summary.",
      );
    const row = this.store.db
      .prepare("SELECT status FROM ticket_drafts WHERE id=? AND session_id=?")
      .get(draftId, this.sessionId)!;
    if (row.status === "created") {
      const result = this.store.db
        .prepare(
          "SELECT ticket_number FROM demo_ticket_results WHERE draft_id=?",
        )
        .get(draftId)!;
      return {
        outcome: "created",
        success: true,
        ticket_number: result.ticket_number,
      };
    }
    if (
      ["submitting", "unknown_outcome", "failed"].includes(String(row.status))
    )
      return {
        outcome: row.status === "failed" ? "failed" : "unknown_outcome",
        success: false,
        instruction: "Do not retry; offer human review.",
      };
    if (row.status === "preview_confirmed")
      return {
        outcome: "previewed",
        success: false,
        instruction:
          "The test request is recorded. No real ticket was created.",
      };
    if (
      !this.yesAfter(this.draft.turn) ||
      this.finalReadback?.draftId !== draftId ||
      !this.yesAfter(this.finalReadback.turn) ||
      this.readbacks.filter((r) => r.turn < this.latestTurn).at(-1)?.draftId !==
        draftId
    )
      return this.clarification(
        "confirmation",
        "Please confirm the request summary after it is read back.",
      );
    const draft = this.preview()!.content;
    for (const field of draft.confirmationFields as Field[])
      this.state.confirmed[field] = true;
    draft.confirmedFields = { ...this.state.confirmed };
    this.persist();
    this.store.db
      .prepare("UPDATE ticket_drafts SET content_json=? WHERE id=?")
      .run(JSON.stringify(draft), draftId);
    if (this.mode === "preview") {
      this.store.db
        .prepare(
          "UPDATE ticket_drafts SET caller_confirmed_at=?,status='preview_confirmed' WHERE id=?",
        )
        .run(new Date().toISOString(), draftId);
      this.store.db
        .prepare(
          "UPDATE sessions SET outcome='completed',state='submitted' WHERE id=?",
        )
        .run(this.sessionId);
      this.event(
        "ticket.preview_confirmed",
        "Confirmed local preview; no Syncro write",
      );
      return {
        outcome: "previewed",
        success: false,
        instruction:
          "The test request is recorded. No real Syncro ticket was created.",
      };
    }
    if (!draft.clinicId || !this.state.clinicConfirmed)
      return {
        outcome: "escalated",
        success: false,
        instruction:
          "Unmatched clinic needs human review; do not create a real ticket.",
      };
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE ticket_drafts SET caller_confirmed_at=?,status='submitting' WHERE id=?",
        )
        .run(new Date().toISOString(), draftId);
      this.store.db
        .prepare(
          "INSERT INTO ticket_jobs(id,draft_id,state,attempt_count) VALUES(?,?,?,1)",
        )
        .run(randomUUID(), draftId, "submitting");
      this.store.db
        .prepare("UPDATE sessions SET state='submitting' WHERE id=?")
        .run(this.sessionId);
    });
    this.event(
      "ticket.submitted",
      "One confirmed real test submission started",
    );
    try {
      const body = `Caller: ${draft.callerName}\nCallback (authoritative): ${draft.callbackNumber}\nOriginally captured: ${draft.callbackOriginal}\nWorkstation: ${draft.workstationNumber ?? "Not provided"}\nPrinter: ${draft.printerIdentifier ?? "Not provided"}\nExtension: ${draft.phoneExtension ?? "Not provided"}\nLocation: ${draft.deviceLocation ?? "Not provided"}\nUnavailable fields: ${draft.unavailableFields.join(", ")}\nIssue: ${draft.summary}\nCaller-reported context (not a diagnosis): ${draft.details ?? ""}\nSource: ChinookIT Browser Demo\nInternal call reference: ${this.sessionId}`;
      const result = await this.syncro.createTestTicket(
        draft.clinicId,
        undefined,
        draft.summary,
        body,
      );
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE ticket_drafts SET status='created' WHERE id=?")
          .run(draftId);
        this.store.db
          .prepare(
            "UPDATE ticket_jobs SET state='created',syncro_ticket_id=? WHERE draft_id=?",
          )
          .run(result.ticketId, draftId);
        this.store.db
          .prepare("INSERT INTO demo_ticket_results VALUES(?,?,?)")
          .run(draftId, result.ticketId, result.ticketNumber);
        this.store.db
          .prepare(
            "UPDATE sessions SET outcome='completed',state='submitted',ticket_id=? WHERE id=?",
          )
          .run(result.ticketId, this.sessionId);
      });
      this.event(
        "ticket.created",
        `Syncro confirmed test ticket ${result.ticketNumber}`,
      );
      return {
        outcome: "created",
        success: true,
        ticket_number: result.ticketNumber,
      };
    } catch (e) {
      const unknown = (e as Error).message === "TICKET_OUTCOME_UNKNOWN",
        state = unknown ? "unknown_outcome" : "failed";
      this.store.db
        .prepare("UPDATE ticket_drafts SET status=? WHERE id=?")
        .run(state, draftId);
      this.store.db
        .prepare(
          "UPDATE ticket_jobs SET state=?,last_error_code=? WHERE draft_id=?",
        )
        .run(state, unknown ? "UNKNOWN_OUTCOME" : "WRITE_REJECTED", draftId);
      this.store.db
        .prepare("UPDATE sessions SET outcome='failed',state=? WHERE id=?")
        .run(state, this.sessionId);
      this.event(
        `ticket.${state}`,
        unknown
          ? "Write outcome unknown; reconciliation required, no retry"
          : "Ticket write rejected; retained for human review",
      );
      return {
        outcome: state,
        success: false,
        instruction:
          "I'm having trouble submitting your request. Offer human support. Do not claim success or retry.",
      };
    }
  }
  preview() {
    if (!this.draft) return null;
    const row = this.store.db
      .prepare(
        "SELECT content_json,status FROM ticket_drafts WHERE id=? AND session_id=?",
      )
      .get(this.draft.id, this.sessionId)!;
    return {
      draftId: this.draft.id,
      status: row.status,
      content: JSON.parse(String(row.content_json)),
      writeMode: this.mode,
    };
  }
}
