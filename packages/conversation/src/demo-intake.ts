import { mapStrings } from "../../security/src/index.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Store } from "../../../apps/server/src/store.ts";
import { SyncroReadClient } from "../../syncro/src/read-client.ts";
const text = z.string().min(1).max(1500),
  id = z.string().regex(/^\d+$/);
const schemas = {
  find_clinic: z.object({ name: text }).strict(),
  confirm_clinic: z
    .object({ clinicId: id, callerConfirmed: z.boolean() })
    .strict(),
  find_contact: z
    .object({ clinicId: id, name: z.string().max(150).optional() })
    .strict(),
  find_related_tickets: z.object({ clinicId: id }).strict(),
  prepare_ticket: z
    .object({
      clinicId: id,
      contactId: id.optional(),
      callerName: text,
      callbackNumber: text,
      summary: text,
      details: text,
    })
    .strict(),
  submit_ticket: z
    .object({ draftId: z.uuid(), callerConfirmed: z.boolean() })
    .strict(),
  transfer_to_support: z.object({ reason: text }).strict(),
};
const descriptions = {
  find_clinic:
    "Look up up to five Syncro clinic/customer candidates by name; ask caller to confirm a match.",
  confirm_clinic:
    "Bind a clinic from returned candidates only after caller confirms.",
  find_contact:
    "Look up contacts within the confirmed clinic; results are a bounded first-page preview.",
  find_related_tickets:
    "Read up to five open-ticket candidates for the confirmed clinic; results are not exhaustive.",
  prepare_ticket:
    "Prepare a dry-run ticket draft. Read spokenSummary to the caller and ask for explicit confirmation.",
  submit_ticket:
    "Submit the confirmed draft using the server-selected preview or live-test mode. Only state a real ticket number after outcome created.",
  transfer_to_support:
    "Simulate a human-support request; browser demos cannot connect a technician.",
};
export const demoToolDefinitions = Object.entries(schemas).map(
  ([name, schema]) => ({
    type: "function",
    name,
    description: descriptions[name as keyof typeof descriptions],
    parameters: z.toJSONSchema(schema),
  }),
);
export class DemoIntake {
  private clinics = new Map<string, string>();
  private contacts = new Set<string>();
  private clinicId = "";
  private draft: { id: string; turn: number } | null = null;
  private latestTurn = -1;
  private latestCommitted = -1;
  private latestText = "";
  constructor(
    private sessionId: string,
    private store: Store,
    private syncro: SyncroReadClient,
    private sanitize: (text: string) => string,
    private event: (type: string, text: string) => void,
    private mode: "preview" | "live_test" = "preview",
  ) {}
  callerCommitted(index: number) {
    this.latestCommitted = index;
  }
  callerTurn(index: number, text: string) {
    if (index < 0 || index < this.latestTurn) return;
    this.latestTurn = index;
    this.latestText = text;
  }
  hasNewCallerTurn() {
    return !!this.draft && this.latestTurn > this.draft.turn;
  }

  private bound(id: string) {
    if (!this.clinicId || id !== this.clinicId)
      throw new Error("CLINIC_NOT_CONFIRMED");
  }
  async execute(name: string, raw: unknown): Promise<unknown> {
    if (!(name in schemas)) throw new Error("TOOL_NOT_ALLOWED");
    const args: any = schemas[name as keyof typeof schemas].parse(raw);
    switch (name) {
      case "find_clinic": {
        const matches = await this.syncro.clinics(this.sanitize(args.name));
        for (const m of matches) this.clinics.set(m.id, this.sanitize(m.name));
        return {
          matches: matches.map((m) => ({ ...m, name: this.sanitize(m.name) })),
          needsConfirmation: true,
          limitedResults: true,
        };
      }
      case "confirm_clinic": {
        if (!args.callerConfirmed || !this.clinics.has(args.clinicId))
          throw new Error("CLINIC_CONFIRMATION_REQUIRED");
        if (this.draft && this.clinicId !== args.clinicId)
          throw new Error("DRAFT_CLINIC_IMMUTABLE");
        this.clinicId = args.clinicId;
        this.contacts.clear();
        this.store.db
          .prepare("UPDATE sessions SET clinic_name=? WHERE id=?")
          .run(this.clinics.get(this.clinicId)!, this.sessionId);
        this.event(
          "clinic.matched",
          "Caller-confirmed clinic candidate bound to this demo session",
        );
        return { clinicId: this.clinicId, confirmed: true };
      }
      case "find_contact": {
        this.bound(args.clinicId);
        const matches = await this.syncro.contacts(
          this.clinicId,
          args.name ?? "",
        );
        for (const c of matches) this.contacts.add(c.id);
        return {
          matches: matches.map((c) => ({
            ...c,
            displayName: this.sanitize(c.displayName),
          })),
          needsConfirmation: true,
          limitedResults: true,
        };
      }
      case "find_related_tickets": {
        this.bound(args.clinicId);
        const candidates = await this.syncro.tickets(this.clinicId);
        return {
          candidates: candidates.map((t) => ({
            ...t,
            title: this.sanitize(t.title),
          })),
          canAppend: false,
          limitedResults: true,
        };
      }
      case "prepare_ticket": {
        this.bound(args.clinicId);
        if (args.contactId && !this.contacts.has(args.contactId))
          throw new Error("CONTACT_NOT_BOUND");
        const draftId = randomUUID(),
          content = {
            clinic: this.clinics.get(this.clinicId),
            ...args,
            source: "ChinookIT Browser Demo",
            writeMode: this.mode,
          };
        const contentJson = JSON.stringify(mapStrings(content, this.sanitize));
        if (this.draft) {
          const old = this.store.db
            .prepare("SELECT content_json,status FROM ticket_drafts WHERE id=?")
            .get(this.draft.id)!;
          if (old.status !== "preview" || old.content_json === contentJson)
            return this.preview();
          this.store.db
            .prepare("UPDATE ticket_drafts SET status='superseded' WHERE id=?")
            .run(this.draft.id);
        }
        this.store.db
          .prepare("INSERT INTO ticket_drafts VALUES(?,?,?,?,?,?)")
          .run(
            draftId,
            this.sessionId,
            contentJson,
            null,
            `${this.sessionId}:${draftId}`,
            "preview",
          );
        this.draft = { id: draftId, turn: this.latestCommitted };
        this.store.db
          .prepare("UPDATE sessions SET state=?,summary=? WHERE id=?")
          .run("confirming", this.sanitize(args.summary), this.sessionId);
        this.event(
          "ticket.draft",
          "Dry-run draft prepared; awaiting a new explicit caller confirmation",
        );
        return this.preview();
      }
      case "submit_ticket": {
        if (
          !this.draft ||
          args.draftId !== this.draft.id ||
          !args.callerConfirmed
        )
          throw new Error("DRAFT_CONFIRMATION_REQUIRED");
        const row = this.store.db
          .prepare(
            "SELECT status FROM ticket_drafts WHERE id=? AND session_id=?",
          )
          .get(args.draftId, this.sessionId);
        if (row?.status === "created") {
          const result = this.store.db
            .prepare(
              "SELECT ticket_id,ticket_number FROM demo_ticket_results WHERE draft_id=?",
            )
            .get(args.draftId)!;
          return {
            outcome: "created",
            ticketId: result.ticket_id,
            ticketNumber: result.ticket_number,
          };
        }
        if (
          ["submitting", "unknown_outcome", "failed"].includes(
            String(row?.status),
          )
        )
          return {
            outcome: row?.status === "failed" ? "failed" : "unknown_outcome",
            message:
              "Do not retry. Review this test draft in Syncro before any further write.",
          };
        if (row?.status === "preview_confirmed")
          return {
            outcome: "previewed",
            message:
              "The preview is already confirmed. No Syncro ticket was created.",
          };
        if (
          this.latestTurn <= this.draft.turn ||
          !/^(?:yes|yeah|yep|correct|that(?:\x27s| is) correct|confirmed|go ahead|please submit|please create)\b/i.test(
            this.latestText.trim(),
          ) ||
          /\b(?:but|except|not|change|don\x27t)\b/i.test(this.latestText)
        )
          throw new Error("NEW_EXPLICIT_CALLER_CONFIRMATION_REQUIRED");
        if (this.mode === "live_test") {
          const draft = this.preview()!.content;
          this.store.transaction(() => {
            this.store.db
              .prepare(
                "UPDATE ticket_drafts SET caller_confirmed_at=?,status=? WHERE id=?",
              )
              .run(new Date().toISOString(), "submitting", args.draftId);
            this.store.db
              .prepare(
                "INSERT INTO ticket_jobs(id,draft_id,state,attempt_count) VALUES(?,?,?,1)",
              )
              .run(randomUUID(), args.draftId, "submitting");
          });
          this.event(
            "ticket.submitted",
            "One explicitly enabled real test-ticket submission started",
          );
          try {
            const result = await this.syncro.createTestTicket(
              this.clinicId,
              draft.contactId,
              draft.summary,
              `${draft.callerName} / ${draft.callbackNumber}\n${draft.details}\nSource: ChinookIT Browser Demo\nInternal call reference: ${this.sessionId}`,
            );
            this.store.transaction(() => {
              this.store.db
                .prepare("UPDATE ticket_drafts SET status=? WHERE id=?")
                .run("created", args.draftId);
              this.store.db
                .prepare(
                  "UPDATE ticket_jobs SET state=?,syncro_ticket_id=?,attempt_count=1 WHERE draft_id=?",
                )
                .run("created", result.ticketId, args.draftId);
              this.store.db
                .prepare("INSERT INTO demo_ticket_results VALUES(?,?,?)")
                .run(args.draftId, result.ticketId, result.ticketNumber);
              this.store.db
                .prepare("UPDATE sessions SET outcome=?,ticket_id=? WHERE id=?")
                .run("completed", result.ticketId, this.sessionId);
            });
            this.event(
              "ticket.created",
              `Syncro confirmed real test ticket ${result.ticketNumber}`,
            );
            return { outcome: "created", ...result };
          } catch (e) {
            const unknown = (e as Error).message === "TICKET_OUTCOME_UNKNOWN",
              state = unknown ? "unknown_outcome" : "failed";
            this.store.db
              .prepare("UPDATE ticket_drafts SET status=? WHERE id=?")
              .run(state, args.draftId);
            this.store.db
              .prepare(
                "UPDATE ticket_jobs SET state=?,last_error_code=?,attempt_count=1 WHERE draft_id=?",
              )
              .run(
                state,
                unknown ? "UNKNOWN_OUTCOME" : "WRITE_REJECTED",
                args.draftId,
              );
            this.store.db
              .prepare("UPDATE sessions SET outcome='failed' WHERE id=?")
              .run(this.sessionId);
            this.event(
              unknown ? "ticket.unknown_outcome" : "ticket.failed",
              unknown
                ? "Syncro write outcome unknown; manual reconciliation required, no retry"
                : "Syncro rejected the real test-ticket request",
            );
            return {
              outcome: state,
              message: unknown
                ? "Ticket outcome is unknown. Do not claim success or retry. Review Syncro using the internal call reference."
                : "Ticket could not be created. No successful ticket number is available.",
            };
          }
        }
        this.store.db
          .prepare(
            "UPDATE ticket_drafts SET caller_confirmed_at=?,status=? WHERE id=?",
          )
          .run(new Date().toISOString(), "preview_confirmed", args.draftId);
        this.store.db
          .prepare("UPDATE sessions SET outcome=? WHERE id=?")
          .run("completed", this.sessionId);
        this.event(
          "ticket.preview_confirmed",
          "Caller confirmed the draft. No Syncro ticket write was performed.",
        );
        return {
          outcome: "previewed",
          message:
            "Your ticket preview is recorded. This test did not create a Syncro ticket.",
        };
      }
      case "transfer_to_support":
        this.event(
          "call.transfer_simulated",
          "Human support requested in browser demo; no PBX transfer performed",
        );
        return {
          outcome: "unavailable",
          message:
            "This browser test cannot connect a technician. A real call would use the approved PBX support route.",
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
    const content = JSON.parse(String(row.content_json));
    return {
      draftId: this.draft.id,
      status: row.status,
      content,
      spokenSummary: `Clinic: ${content.clinic}. Caller: ${content.callerName}. Callback: ${content.callbackNumber}. Issue: ${content.summary}. Details: ${content.details}. Is that accurate?`,
      writeMode: this.mode,
    };
  }
}
