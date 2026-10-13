import { randomUUID } from "node:crypto";
import { z } from "zod";
import WebSocket from "ws";
import { Store } from "./store.ts";
import {
  decrypt,
  redact,
  digest,
  mapStrings,
} from "../../../packages/security/src/index.ts";
import { SyncroReadClient } from "../../../packages/syncro/src/read-client.ts";
import {
  conversationPolicy,
  semanticTurnDetection,
} from "../../../packages/conversation/src/policy.ts";
import { agentSchema } from "../../../packages/shared/src/config.ts";
import {
  DemoIntake,
  demoToolDefinitions,
} from "../../../packages/conversation/src/demo-intake.ts";
export interface ControlSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}
export async function connectControl(
  callId: string,
  key: string,
): Promise<ControlSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        handshakeTimeout: 10000,
        maxPayload: 1_000_000,
      },
    );
    let opened = false;
    ws.on("error", () => {
      if (!opened) reject(new Error("REALTIME_CONTROL_FAILED"));
    });
    ws.once("open", () => {
      opened = true;
      resolve({
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: () => ws.close(),
        onMessage: (handler) =>
          ws.on("message", (data) => handler(data.toString())),
        onClose: (handler) => ws.on("close", handler),
      });
    });
  });
}
const startSchema = z
  .object({
    sdp: z
      .string()
      .min(20)
      .max(18000)
      .refine(
        (s) => s.startsWith("v=0") && s.includes("m=audio"),
        "Expected an audio SDP offer",
      ),
    writeMode: z.enum(["preview", "live_test"]).default("preview"),
    testCustomerId: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
export class DemoError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
  ) {
    super(code);
  }
}
function reject(code: string, status = 400): never {
  throw new DemoError(code, status);
}
type Active = {
  owner: string;
  key: string;
  callId: string | null;
  socket: ControlSocket | null;
  intake: DemoIntake;
  activated: boolean;
  events: number;
  chain: Promise<void>;
  pending: any[];
  completedCalls: Set<string>;
  responseStatus: Map<string, string>;
  committed: Map<string, number>;
  commitOrder: number;
  lastSeen: number;
  startedAt: number;
  speaking?: boolean;
  responseId?: string;
  generation?: number;
  truncatedItems?: Set<string>;
};
export type DemoOptions = {
  store: Store;
  key: Buffer;
  enabled: boolean;
  fetcher?: typeof fetch;
  connect?: typeof connectControl;
};
export class DemoCalls {
  private active = new Map<string, Active>();
  private reservations = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private fetcher: typeof fetch;
  private recovery: Promise<void> = Promise.resolve();
  private lastRetentionRun = 0;
  constructor(private o: DemoOptions) {
    this.fetcher = o.fetcher ?? fetch;
    const stale = o.store.db
      .prepare(
        "SELECT session_id,provider_call_id FROM browser_calls WHERE status IN ('connecting','active')",
      )
      .all();
    for (const r of stale) {
      o.store.db
        .prepare("UPDATE browser_calls SET status='failed' WHERE session_id=?")
        .run(String(r.session_id));
      o.store.db
        .prepare(
          "UPDATE sessions SET state='failed',outcome='failed',ended_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), String(r.session_id));
      this.event(
        String(r.session_id),
        "call.recovered",
        "Browser call interrupted by application restart",
      );
    }
    this.recovery = Promise.allSettled(
      stale
        .filter((r) => r.provider_call_id)
        .map(async (r) => {
          try {
            const response = await this.fetcher(
              `https://api.openai.com/v1/realtime/calls/${r.provider_call_id}/hangup`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${this.credential("openai")}`,
                },
                redirect: "error",
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!response.ok && response.status !== 404)
              this.event(
                String(r.session_id),
                "provider.cleanup_failed",
                "Restart cleanup could not confirm provider hangup",
              );
          } catch {
            this.event(
              String(r.session_id),
              "provider.cleanup_failed",
              "Restart cleanup could not confirm provider hangup",
            );
          }
        }),
    ).then(() => {});
    // Ambiguous writes must never be repeated after a crash.
    o.store.db.exec(
      "UPDATE ticket_jobs SET state='unknown_outcome',last_error_code='PROCESS_RESTART' WHERE state='submitting' AND draft_id IN (SELECT id FROM ticket_drafts WHERE session_id IN (SELECT session_id FROM browser_calls)); UPDATE ticket_drafts SET status='unknown_outcome' WHERE status='submitting' AND session_id IN (SELECT session_id FROM browser_calls);",
    );
    this.timer = setInterval(() => {
      if (Date.now() - this.lastRetentionRun > 3600000) {
        this.o.store.expireConversations();
        this.lastRetentionRun = Date.now();
      }
      for (const [id, a] of this.active)
        if (
          (a.socket !== null && Date.now() - a.lastSeen > 30000) ||
          Date.now() - a.startedAt > 300000
        )
          void this.end(a.owner, id, "timeout");
    }, 5000);
    this.timer.unref();
  }
  private credential(provider: string) {
    const row = this.o.store.db
      .prepare("SELECT encrypted_blob FROM credentials WHERE provider=?")
      .get(provider);
    if (!row) reject("SAVE_OPENAI_AND_SYNCRO_CREDENTIALS_FIRST");
    return decrypt(String(row.encrypted_blob), this.o.key, provider);
  }
  private sanitize(text: string) {
    const secrets = this.o.store.db
      .prepare("SELECT provider,encrypted_blob FROM credentials")
      .all()
      .map((r) =>
        decrypt(String(r.encrypted_blob), this.o.key, String(r.provider)),
      );
    return redact(text, secrets).slice(0, 10000);
  }
  private event(id: string, type: string, summary: string, eventId?: string) {
    if (
      !this.o.store.agent().diagnosticLogging &&
      ["tool.requested", "tool.completed", "caller.speech_started"].includes(
        type,
      )
    )
      return;
    const d = this.o.store.db;
    const sequence = Number(
      d
        .prepare(
          "SELECT COALESCE(max(sequence),-1)+1 n FROM call_events WHERE session_id=?",
        )
        .get(id)!.n,
    );
    d.prepare(
      "INSERT OR IGNORE INTO call_events VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      eventId ? digest(id + eventId) : randomUUID(),
      id,
      sequence,
      type,
      new Date().toISOString(),
      "system",
      type.includes("failed") || type.includes("error") ? "error" : "info",
      1,
      this.sanitize(summary),
    );
  }
  status() {
    const d = this.o.store.db,
      settings = this.o.store.setting("connection:openai"),
      syncro = this.o.store.setting("connection:syncro");
    const configured = (p: string) =>
      !!d.prepare("SELECT provider FROM credentials WHERE provider=?").get(p);
    return {
      enabled: this.o.enabled,
      ready:
        this.o.enabled &&
        configured("openai") &&
        configured("syncro") &&
        !!settings?.model &&
        !!settings?.voice &&
        !!syncro?.tenant,
      openaiConfigured: configured("openai"),
      syncroConfigured: configured("syncro"),
      model: settings?.model ?? "",
      voice: settings?.voice ?? "",
      agentName: this.o.store.agent().name,
      maxDurationSeconds: 300,
      defaultWriteMode: "preview",
      ticketCreationEnabled: this.o.store.agent().ticketCreationEnabled,
    };
  }
  async start(owner: string, raw: unknown) {
    await this.recovery;
    if (!this.o.enabled) reject("BROWSER_DEMOS_DISABLED", 403);
    const input = startSchema.parse(raw);
    if (!this.status().ready)
      reject("CONFIGURE_KEYS_MODEL_VOICE_AND_SYNCRO_TENANT");
    if (
      this.reservations.has(owner) ||
      [...this.active.values()].some((a) => a.owner === owner)
    )
      reject("DEMO_CALL_ALREADY_ACTIVE", 409);
    if (this.active.size + this.reservations.size >= 5)
      reject("DEMO_CAPACITY_REACHED", 429);
    if (input.writeMode === "live_test" && !input.testCustomerId)
      reject("REAL_TEST_REQUIRES_CUSTOMER_ID");
    if (
      input.writeMode === "live_test" &&
      !this.o.store.agent().ticketCreationEnabled
    )
      reject("REAL_TICKET_CREATION_DISABLED");
    const d = this.o.store.db,
      id = randomUUID(),
      date = new Date().toISOString();
    const key = this.credential("openai"),
      syncroKey = this.credential("syncro"),
      config = this.o.store.setting("connection:openai"),
      syncroConfig = this.o.store.setting("connection:syncro"),
      agent = this.o.store.agent();
    this.reservations.add(owner);
    d.prepare(
      "INSERT INTO sessions(id,started_at,state,outcome,clinic_name,caller_number_masked,summary,prompt_version_id,transcript_status,is_demo,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      date,
      "ringing",
      "no_ticket",
      "Not identified",
      "Browser microphone",
      "Browser demo call",
      this.o.store.setting("active_prompt"),
      "pending",
      1,
      "browser_demo",
    );
    d.prepare("INSERT INTO browser_calls VALUES(?,?,NULL,?,?,?,?)").run(
      id,
      owner,
      "connecting",
      config.model,
      config.voice,
      Date.now(),
    );
    this.o.store.audit(owner, "browser_demo.started", id);
    this.event(
      id,
      "call.received",
      `Browser demo started in ${input.writeMode} mode`,
    );
    const syncro = new SyncroReadClient(
      syncroConfig.tenant,
      syncroKey,
      this.fetcher,
      input.writeMode === "live_test" ? input.testCustomerId : undefined,
    );
    const intake = new DemoIntake(
      id,
      this.o.store,
      syncro,
      (text) => this.sanitize(text),
      (type, text) => this.event(id, type, text),
      input.writeMode,
    );
    const active: Active = {
      owner,
      key,
      callId: null,
      socket: null,
      intake,
      activated: false,
      events: 0,
      chain: Promise.resolve(),
      pending: [],
      completedCalls: new Set(),
      responseStatus: new Map(),
      committed: new Map(),
      commitOrder: -1,
      lastSeen: Date.now(),
      startedAt: Date.now(),
    };
    this.active.set(id, active);
    this.reservations.delete(owner);
    try {
      await syncro.check();
      if (!this.active.has(id)) reject("DEMO_CALL_ENDED", 409);
      const form = new FormData();
      form.set("sdp", input.sdp);
      const modeInstruction =
        input.writeMode === "preview"
          ? "Ticket submission is a PREVIEW ONLY. Never say a Syncro ticket was created or invent a ticket number."
          : "Real TEST ticket creation is explicitly enabled for one server-selected organization. Never claim success until create_ticket returns success=true.";
      const instructions =
        agent.prompt +
        `\nThe following mandatory policy takes precedence over any conflicting custom instructions:\n${conversationPolicy}\nYou are in a browser demo call. ${modeInstruction} Match and confirm the clinic with match_clinic. Save and confirm caller fields before prepare_ticket. Wait for a new caller answer before create_ticket. Transfers are unavailable; never claim a technician is connected. Aim for ${agent.maxQuestions} intake questions, but always resolve incomplete or ambiguous required facts. Never expose internal identifiers.`;
      form.set(
        "session",
        JSON.stringify({
          type: "realtime",
          model: config.model,
          instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              transcription: { model: "gpt-4o-transcribe", language: "en" },
              turn_detection: semanticTurnDetection(agent, false),
            },
            output: { voice: config.voice },
          },
          tools: demoToolDefinitions,
          tool_choice: "auto",
        }),
      );
      const response = await this.fetcher(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "OpenAI-Safety-Identifier": digest(owner),
          },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) reject("OPENAI_SESSION_REJECTED", 502);
      const location = response.headers.get("location") ?? "",
        callId = location.split("/").pop() ?? "";
      if (!/^rtc_[a-zA-Z0-9_-]+$/.test(callId))
        reject("INVALID_REALTIME_CALL_ID", 502);
      active.callId = callId;
      d.prepare(
        "UPDATE browser_calls SET provider_call_id=? WHERE session_id=?",
      ).run(callId, id);
      const sdp = await response.text();
      if (
        !sdp.startsWith("v=0") ||
        sdp.length > 18000 ||
        sdp.includes(key) ||
        sdp.includes(syncroKey)
      )
        reject("INVALID_REALTIME_ANSWER", 502);
      if (!this.active.has(id)) {
        await this.hangup(callId, key, id);
        reject("DEMO_CALL_ENDED", 409);
      }
      active.socket = await (this.o.connect ?? connectControl)(callId, key);
      if (!this.active.has(id)) {
        active.socket.close();
        await this.hangup(callId, key, id);
        reject("DEMO_CALL_ENDED", 409);
      }

      active.socket.onMessage((text) => {
        try {
          const e = JSON.parse(text);
          this.ingest(id, active, e);
        } catch {
          this.event(id, "provider.error", "Unusable provider event discarded");
        }
      });
      active.socket.onClose(() => {
        if (this.active.has(id))
          void this.end(owner, id, "provider_disconnect");
      });
      this.event(
        id,
        "call.accepted",
        "OpenAI browser audio session and server controls established",
      );
      return {
        id,
        sdp,
        writeMode: input.writeMode,
        agentName: agent.name,
        promptVersion: d
          .prepare("SELECT prompt_version_id FROM sessions WHERE id=?")
          .get(id)!.prompt_version_id,
        maxDurationSeconds: 300,
      };
    } catch (e) {
      await this.end(owner, id, "setup_failed");
      if (e instanceof DemoError) throw e;
      reject("BROWSER_CALL_SETUP_FAILED", 502);
    } finally {
      this.reservations.delete(owner);
    }
  }
  private owned(owner: string, id: string) {
    z.uuid().parse(id);
    const row = this.o.store.db
      .prepare("SELECT * FROM browser_calls WHERE session_id=? AND owner_id=?")
      .get(id, owner);
    if (!row) reject("DEMO_CALL_NOT_FOUND", 404);
    return row;
  }
  activate(owner: string, id: string) {
    this.owned(owner, id);
    const a = this.active.get(id);
    if (!a) reject("DEMO_CALL_ENDED", 409);
    if (a.activated) return { ok: true };
    a.activated = true;
    const row = this.o.store.db
      .prepare("SELECT prompt_version_id FROM sessions WHERE id=?")
      .get(id)!;
    const agent = agentSchema.parse(
      JSON.parse(
        String(
          this.o.store.db
            .prepare("SELECT content_json FROM prompt_versions WHERE id=?")
            .get(String(row.prompt_version_id))!.content_json,
        ),
      ),
    );
    a.socket!.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              turn_detection: semanticTurnDetection(agent),
            },
          },
        },
      }),
    );
    a.socket!.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: `This is the ONLY introduction in this call. Say this greeting once, then wait for the caller: ${agent.greeting}`,
          tool_choice: "none",
        },
      }),
    );
    this.o.store.db
      .prepare("UPDATE browser_calls SET status='active' WHERE session_id=?")
      .run(id);
    this.o.store.db
      .prepare("UPDATE sessions SET state='greeting' WHERE id=?")
      .run(id);
    a.lastSeen = Date.now();
    return { ok: true };
  }
  heartbeat(owner: string, id: string) {
    this.owned(owner, id);
    const a = this.active.get(id);
    if (a) {
      a.lastSeen = Date.now();
      this.o.store.db
        .prepare("UPDATE browser_calls SET last_seen=? WHERE session_id=?")
        .run(a.lastSeen, id);
    }
    return this.snapshot(owner, id);
  }
  snapshot(owner: string, id: string) {
    const call = this.owned(owner, id),
      d = this.o.store.db;
    const session = d.prepare("SELECT * FROM sessions WHERE id=?").get(id)!;
    const draft = d
      .prepare(
        "SELECT id,content_json,status FROM ticket_drafts WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id);
    const result = draft
      ? d
          .prepare(
            "SELECT ticket_id,ticket_number FROM demo_ticket_results WHERE draft_id=?",
          )
          .get(String(draft.id))
      : null;
    return {
      id,
      status: call.status,
      session,
      turns: d
        .prepare(
          "SELECT * FROM conversation_turns WHERE session_id=? ORDER BY turn_index LIMIT 300",
        )
        .all(id),
      events: d
        .prepare(
          "SELECT event_type,public_summary,event_time FROM call_events WHERE session_id=? ORDER BY sequence DESC LIMIT 40",
        )
        .all(id)
        .reverse(),
      draft: draft
        ? {
            id: draft.id,
            content: JSON.parse(String(draft.content_json)),
            status: draft.status,
            result,
          }
        : null,
    };
  }
  private ingest(id: string, a: Active, e: any) {
    if (!this.active.has(id)) return;
    if (++a.events > 10000) {
      void this.end(a.owner, id, "event_limit");
      return;
    }
    const type = e.type;
    if (type === "response.created") {
      a.responseId = e.response?.id;
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      a.speaking = true;
      a.generation = (a.generation ?? 0) + 1;
      this.event(
        id,
        "caller.speech_started",
        "Caller began speaking; pending speech continuation suppressed",
        e.event_id,
      );
      // WebRTC owns playback, cancellation and truncation. Do not estimate timestamps or send duplicate cancels.
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      a.speaking = false;
      return;
    }
    if (
      type === "output_audio_buffer.cleared" ||
      type === "conversation.item.truncated"
    ) {
      this.event(
        id,
        "audio.interrupted",
        "Provider cleared unplayed WebRTC audio and truncated conversation",
        e.event_id,
      );
      if (e.item_id) {
        a.truncatedItems ??= new Set();
        a.truncatedItems.add(String(e.item_id));
        this.markInterrupted(id, String(e.item_id));
      }
      return;
    }
    if (
      type === "input_audio_buffer.committed" &&
      typeof e.item_id === "string"
    ) {
      if (!a.committed.has(e.item_id)) {
        a.committed.set(e.item_id, ++a.commitOrder);
        a.intake.callerCommitted(a.commitOrder);
      }
      return;
    }

    if (
      type === "conversation.item.input_audio_transcription.completed" ||
      type === "response.output_audio_transcript.done" ||
      type === "response.output_text.done"
    ) {
      const user = type.startsWith("conversation."),
        text = this.sanitize(
          String(user ? e.transcript : (e.transcript ?? e.text ?? "")),
        );
      if (!text) return;
      const item = String(e.item_id ?? e.event_id ?? "");
      if (!item) return;
      const turnId = digest(
          id +
            item +
            String(e.content_index ?? 0) +
            (user ? "caller" : "assistant"),
        ),
        d = this.o.store.db;
      const existing = d
        .prepare("SELECT turn_index FROM conversation_turns WHERE id=?")
        .get(turnId);
      if (existing) return;
      const turn = Number(
        d
          .prepare(
            "SELECT COALESCE(max(turn_index),-1)+1 n FROM conversation_turns WHERE session_id=?",
          )
          .get(id)!.n,
      );
      if (turn >= 300) {
        void this.end(a.owner, id, "turn_limit");
        return;
      }
      const interrupted =
        !user &&
        (a.responseStatus.get(e.response_id) === "cancelled" ||
          a.truncatedItems?.has(item));
      d.prepare("INSERT INTO conversation_turns VALUES(?,?,?,?,?,?,?)").run(
        turnId,
        id,
        turn,
        user ? "caller" : "assistant",
        interrupted ? "[Interrupted audio; heard text unavailable]" : text,
        interrupted ? 1 : 0,
        "available",
      );
      if (!user)
        this.o.store.db
          .prepare("INSERT OR REPLACE INTO assistant_items VALUES(?,?,?,?)")
          .run(item, id, e.response_id ?? "", turnId);
      d.prepare(
        "UPDATE sessions SET transcript_status='available' WHERE id=?",
      ).run(id);
      if (user) a.intake.callerTurn(a.committed.get(item) ?? -1, text);
      this.event(
        id,
        user ? "transcript.user.final" : "transcript.assistant.final",
        interrupted ? "[Interrupted audio; heard text unavailable]" : text,
        e.event_id,
      );
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      this.event(
        id,
        "transcript.unavailable",
        "Caller transcription unavailable; no speech text fabricated",
        e.event_id,
      );
      return;
    }
    if (type === "response.function_call_arguments.done") {
      if (
        typeof e.call_id === "string" &&
        !a.completedCalls.has(e.call_id) &&
        a.pending.length < 5
      )
        a.pending.push({ ...e, generation: a.generation ?? 0 });
      return;
    }
    if (type === "response.done") {
      const response = e.response ?? {};
      if (a.responseId === response.id) a.responseId = undefined;
      a.responseStatus.set(response.id, response.status);
      if (a.responseStatus.size > 300)
        a.responseStatus.delete(a.responseStatus.keys().next().value!);
      if (response.status === "cancelled") {
        for (const item of this.o.store.db
          .prepare(
            "SELECT item_id FROM assistant_items WHERE session_id=? AND response_id=?",
          )
          .all(id, response.id))
          this.markInterrupted(id, String(item.item_id));
        this.event(
          id,
          "response.interrupted",
          "Assistant response was interrupted",
          e.event_id,
        );
      }
      const calls = a.pending.filter(
        (call) => !call.response_id || call.response_id === response.id,
      );
      a.pending = a.pending.filter(
        (call) => call.response_id && call.response_id !== response.id,
      );
      if (response.status === "cancelled") return;
      if (!calls.length) return;
      const continuationGeneration = a.generation ?? 0;
      a.chain = a.chain
        .then(async () => {
          for (const call of calls) {
            if (a.completedCalls.has(call.call_id) || !this.active.has(id))
              continue;
            a.completedCalls.add(call.call_id);
            if (call.generation !== (a.generation ?? 0)) continue;
            if (a.completedCalls.size > 40) {
              await this.end(a.owner, id, "tool_limit");
              return;
            }
            this.event(
              id,
              "tool.requested",
              `Tool requested: ${String(call.name).slice(0, 80)}`,
            );
            let result: unknown;
            try {
              if (
                [
                  "create_ticket",
                  "confirm_intake",
                  "match_clinic",
                  "update_intake",
                ].includes(call.name)
              ) {
                const deadline = Date.now() + 3000;
                while (
                  !a.intake.transcriptCurrent() &&
                  Date.now() < deadline &&
                  this.active.has(id)
                )
                  await new Promise((r) => setTimeout(r, 25));
              }
              if (!this.active.has(id)) return;
              result = await a.intake.execute(
                call.name,
                JSON.parse(call.arguments),
              );
              this.event(
                id,
                "tool.completed",
                `Tool completed: ${String(call.name).slice(0, 80)}`,
              );
            } catch (err) {
              const code =
                err instanceof z.ZodError
                  ? "INVALID_TOOL_ARGUMENTS"
                  : (err as Error).message;
              result =
                code === "INVALID_TOOL_ARGUMENTS"
                  ? {
                      status: "clarification_required",
                      instruction:
                        "Use only the allowed tool fields. Ask one question to clarify missing caller information.",
                    }
                  : {
                      outcome: "failed",
                      instruction:
                        "I'm having trouble processing your request. Offer human support; do not reveal internal errors or ask unrelated intake questions.",
                    };
              this.event(
                id,
                "tool.failed",
                `Tool failed: ${String(call.name).slice(0, 80)}; ${/^[A-Z_]+$/.test(code) ? code : "TOOL_FAILED"}`,
              );
            }
            if (!this.active.has(id)) return;
            a.socket?.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: JSON.stringify(
                    mapStrings(result, (text) => this.sanitize(text)),
                  ),
                },
              }),
            );
          }
          if (
            this.active.has(id) &&
            !a.speaking &&
            !a.responseId &&
            continuationGeneration === (a.generation ?? 0)
          )
            a.socket?.send(JSON.stringify({ type: "response.create" }));
        })
        .catch(() => {
          this.event(id, "provider.error", "Tool processing failed safely");
        });
      return;
    }
    if (type === "error")
      this.event(
        id,
        "provider.error",
        "Realtime reported an error; raw provider payload discarded",
        e.event_id,
      );
  }
  private markInterrupted(id: string, itemId: string) {
    const item = this.o.store.db
      .prepare(
        "SELECT turn_id FROM assistant_items WHERE item_id=? AND session_id=?",
      )
      .get(itemId, id);
    if (!item) return;
    const turn = this.o.store.db
      .prepare("SELECT text_redacted FROM conversation_turns WHERE id=?")
      .get(String(item.turn_id));
    if (!turn) return;
    this.o.store.db
      .prepare(
        "UPDATE conversation_turns SET text_redacted='[Interrupted audio; heard text unavailable]',is_interrupted=1 WHERE id=?",
      )
      .run(String(item.turn_id));
    this.o.store.db
      .prepare(
        "UPDATE call_events SET public_summary='[Interrupted audio; heard text unavailable]' WHERE session_id=? AND event_type='transcript.assistant.final' AND public_summary=?",
      )
      .run(id, turn.text_redacted);
  }
  async end(owner: string, id: string, reason = "ended") {
    this.owned(owner, id);
    const a = this.active.get(id);
    if (!a) return { ok: true };
    this.active.delete(id);
    a.socket?.close();
    const d = this.o.store.db,
      failed = [
        "setup_failed",
        "provider_disconnect",
        "event_limit",
        "turn_limit",
        "tool_limit",
      ].includes(reason);
    d.prepare("UPDATE browser_calls SET status=? WHERE session_id=?").run(
      failed ? "failed" : "ended",
      id,
    );
    d.prepare(
      "UPDATE sessions SET state=?,outcome=CASE WHEN outcome IN (\x27completed\x27,\x27failed\x27) THEN outcome ELSE ? END,ended_at=?,transcript_status=CASE WHEN transcript_status=\x27pending\x27 THEN \x27unavailable\x27 ELSE transcript_status END WHERE id=?",
    ).run(
      failed ? "failed" : "completed",
      failed ? "failed" : "no_ticket",
      new Date().toISOString(),
      id,
    );
    this.event(id, "call.ended", `Browser demo ended: ${reason}`);
    if (a.callId) await this.hangup(a.callId, a.key, id);
    return { ok: true };
  }
  private async hangup(callId: string, key: string, id: string) {
    try {
      const r = await this.fetcher(
        `https://api.openai.com/v1/realtime/calls/${callId}/hangup`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok && r.status !== 404)
        this.event(
          id,
          "provider.cleanup_failed",
          "Provider hangup failed; browser microphone and connection must be closed",
        );
    } catch {
      this.event(
        id,
        "provider.cleanup_failed",
        "Provider hangup could not be confirmed; local session ended",
      );
    }
  }
  async endOwner(owner: string) {
    await Promise.allSettled(
      [...this.active]
        .filter(([, a]) => a.owner === owner)
        .map(([id]) => this.end(owner, id, "signed_out")),
    );
  }
  async close() {
    await this.recovery;
    clearInterval(this.timer);
    const pending = [...this.active.values()].map((a) => a.chain);
    await Promise.allSettled(
      [...this.active].map(([id, a]) =>
        this.end(a.owner, id, "server_shutdown"),
      ),
    );
    await Promise.allSettled(pending);
  }
}
