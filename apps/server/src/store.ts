import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultAgent } from "../../../packages/shared/src/config.ts";
import { redact } from "../../../packages/security/src/index.ts";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);",
    );
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=1").get()
    ) {
      this.transaction(() => {
        this.db.exec(
          readFileSync(
            new URL(
              "../../../db/migrations/001-foundation.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.db.exec("INSERT INTO migrations VALUES(1)");
      });
    }
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=2").get()
    ) {
      this.transaction(() => {
        this.db.exec(
          readFileSync(
            new URL(
              "../../../db/migrations/002-browser-calls.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.db.exec("INSERT INTO migrations VALUES(2)");
      });
    }
    if (!this.db.prepare("SELECT id FROM prompt_versions LIMIT 1").get()) {
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO prompt_versions VALUES(?,?,?,NULL)")
        .run(id, JSON.stringify(defaultAgent), new Date().toISOString());
      this.setting("active_prompt", id);
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting(key: string, value?: unknown): any {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET safe_json_value=excluded.safe_json_value",
        )
        .run(key, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT safe_json_value FROM app_settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.safe_json_value)) : null;
  }
  audit(actor: string | null, operation: string, target: string) {
    this.db
      .prepare("INSERT INTO audit_events VALUES(?,?,?,?,?)")
      .run(randomUUID(), actor, operation, target, new Date().toISOString());
  }
  agent() {
    return JSON.parse(
      String(
        this.db
          .prepare("SELECT content_json FROM prompt_versions WHERE id=?")
          .get(this.setting("active_prompt"))!.content_json,
      ),
    );
  }
  seed() {
    if (this.db.prepare("SELECT id FROM sessions LIMIT 1").get()) return;
    this.transaction(() => {
      for (let i = 0; i < 75; i++) {
        const id = randomUUID(),
          date = new Date(Date.now() - i * 3600000).toISOString(),
          outcome = [
            "completed",
            "transferred",
            "abandoned",
            "failed",
            "no_ticket",
          ][i % 5],
          clinic = [
            "Demo North Clinic",
            "Demo River Clinic",
            "Demo West Clinic",
          ][i % 3];
        this.db
          .prepare(
            "INSERT INTO sessions(id,started_at,ended_at,state,outcome,clinic_name,caller_number_masked,summary,prompt_version_id,transcript_status,ticket_id,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            date,
            new Date(new Date(date).getTime() + 180000).toISOString(),
            outcome,
            outcome,
            clinic,
            "***-***-0100",
            [
              "Printer cannot scan",
              "Clinic-wide EMR outage",
              "Caller ended before confirmation",
            ][i % 3],
            this.setting("active_prompt"),
            outcome === "abandoned" ? "partial" : "available",
            outcome === "completed" ? `DEMO-${1000 + i}` : null,
            1,
          );
        const turns = [
          ["assistant", defaultAgent.greeting],
          [
            "caller",
            `I am calling from ${clinic}. Our printer says destination unavailable when scanning.`,
          ],
          [
            "assistant",
            "Does printing still work, and how many people are affected?",
          ],
          [
            "caller",
            "Printing works. Two staff are affected. My password is synthetic-secret.",
          ],
          [
            "assistant",
            outcome === "completed"
              ? "This demonstration has recorded your confirmed request. No real Syncro ticket has been created."
              : "I can help record this or connect you with support.",
          ],
        ];
        turns.forEach(([speaker, text], n) =>
          this.db
            .prepare("INSERT INTO conversation_turns VALUES(?,?,?,?,?,?,?)")
            .run(randomUUID(), id, n, speaker, redact(text), 0, "available"),
        );
        [
          "call.received",
          "call.accepted",
          "transcript.user.final",
          outcome === "completed"
            ? "ticket.demo_recorded"
            : outcome === "transferred"
              ? "call.transferred"
              : outcome === "failed"
                ? "provider.error"
                : "call.ended",
        ].forEach((type, n) =>
          this.db
            .prepare("INSERT INTO call_events VALUES(?,?,?,?,?,?,?,?,?)")
            .run(
              randomUUID(),
              id,
              n,
              type,
              new Date(new Date(date).getTime() + n * 30000).toISOString(),
              type.startsWith("transcript") ? "caller" : "system",
              type === "provider.error" ? "error" : "info",
              1,
              type === "ticket.demo_recorded"
                ? "Synthetic confirmed intake; no external ticket write"
                : type === "provider.error"
                  ? "Synthetic provider disconnect"
                  : type,
            ),
        );
      }
    });
  }
  close() {
    this.db.close();
  }
}
