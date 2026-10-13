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
    "After reading back these fields and receiving a new explicit yes, confirm them. Never confirm from silence, uncertain speech, or a yes spoken before the update.",
  prepare_ticket:
    "Validate saved confirmed fields and prepare an immutable ticket. Ask the short spokenSummary question and wait for a new explicit yes. Returns no technician-facing description.",
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
};
export class DemoIntake {
  private draft: { id: string; turn: number } | null = null;
  private latestTurn = -1;
  private latestCommitted = -1;
  private latestText = "";
  private evidence: string[] = [];
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
    if (index < 0 || index < this.latestTurn) return;
    this.latestTurn = index;
    this.latestText = text;
    this.evidence.push(text);
    if (this.evidence.length > 30) this.evidence.shift();
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
  async execute(name: string, raw: unknown): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) throw new Error("TOOL_NOT_ALLOWED");
    const args: any = schemas[name as keyof typeof schemas].parse(raw);
    switch (name) {
      case "match_clinic": {
        if (this.immutable()) return { status: "submission_locked" };
        if (args.confirm) {
          if (
            !this.state.clinic ||
            normalizeClinic(args.name) !==
              normalizeClinic(this.state.clinic.name) ||
            !this.yesAfter(this.state.clinicTurn)
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
            normalizeClinic(t).includes(normalizeClinic(args.name)),
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
        const problems: { field: string; question: string }[] = [];
        for (const [field, rawValue] of Object.entries(
          args.fields as Record<string, string>,
        )) {
          const value = this.sanitize(rawValue);
          if (this.state.fields[field] === value) continue;
          const guarded = fieldNames.includes(field as Field);
          if (guarded && value) {
            const evidence = this.latestText;
            const observed =
              field === "callbackNumber"
                ? callbackDigits(evidence).includes(callbackDigits(value)) &&
                  callbackDigits(value).length >= 7
                : hasSpokenValue(
                    evidence,
                    value,
                    !["firstName", "lastName", "deviceLocation"].includes(
                      field,
                    ),
                  );
            if (!observed) {
              problems.push({
                field,
                question: `Please repeat or spell the ${field}.`,
              });
              continue;
            }
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
            this.state.updatedTurns[field as Field] = this.latestCommitted;
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
        this.persist();
        this.event(
          "intake.updated",
          "Caller facts updated; confirmation cleared only for changed fields",
        );
        return {
          ...this.view(),
          ...(problems.length
            ? { status: "clarification_required", ...problems[0] }
            : { status: "saved" }),
        };
      }
      case "confirm_intake": {
        for (const field of args.fields as Field[]) {
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
          if (
            !this.yesAfter(
              this.state.updatedTurns[field] ?? this.latestCommitted,
            )
          )
            return this.clarification(
              field,
              `Please confirm the ${field} just read back.`,
            );
        }
        for (const field of args.fields as Field[])
          this.state.confirmed[field] = true;
        this.persist();
        return { status: "confirmed", ...this.view() };
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
          if (!s.fields[field] || !s.confirmed[field])
            return this.clarification(
              field,
              field === "callbackNumber"
                ? (s.callback?.reason ??
                    "Could you confirm your complete callback number?")
                : `Could you confirm your ${field === "firstName" ? "first name" : "last name"}?`,
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
          (!s.fields[requiredDevice] || !s.confirmed[requiredDevice])
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
          (!s.fields.deviceLocation || !s.confirmed.deviceLocation)
        )
          return this.clarification(
            "deviceLocation",
            "Which room or desk is the computer in?",
          );
        for (const field of fieldNames)
          if (s.fields[field] && !s.confirmed[field])
            return this.clarification(field, `Could you confirm the ${field}?`);
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
    return {
      draftId: draft.draftId,
      status: "confirmation_required",
      spokenSummary: `${String(draft.content.summary).split(/\s+/).slice(0, 19).join(" ")}. Is that right?`,
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
    if (!this.yesAfter(this.draft.turn))
      return this.clarification(
        "confirmation",
        "Please confirm the request summary after it is read back.",
      );
    const draft = this.preview()!.content;
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
      const body = `Confirmed caller: ${draft.callerName}\nCallback (authoritative): ${draft.callbackNumber}\nOriginally captured: ${draft.callbackOriginal}\nWorkstation: ${draft.workstationNumber ?? "Not provided"}\nPrinter: ${draft.printerIdentifier ?? "Not provided"}\nExtension: ${draft.phoneExtension ?? "Not provided"}\nLocation: ${draft.deviceLocation ?? "Not provided"}\nUnavailable fields: ${draft.unavailableFields.join(", ")}\nIssue: ${draft.summary}\nCaller-reported context (not a diagnosis): ${draft.details ?? ""}\nSource: ChinookIT Browser Demo\nInternal call reference: ${this.sessionId}`;
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
