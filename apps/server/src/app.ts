import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import statics from "@fastify/static";
import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { Store } from "./store.ts";
import {
  connectionSchema,
  agentSchema,
  userSchema,
} from "../../../packages/shared/src/config.ts";
import {
  digest,
  equal,
  encrypt,
  decrypt,
  redact,
} from "../../../packages/security/src/index.ts";
const providerSchema = z.enum(["pbx", "openai", "syncro"]);
type User = {
  id: string;
  email: string;
  role: "admin" | "support";
  csrf: string;
};
declare module "fastify" {
  interface FastifyRequest {
    actor: User | null;
  }
}
export type AppOptions = {
  store: Store;
  key: Buffer;
  bootstrapToken: string;
  origin: string;
  demo: boolean;
  webRoot?: string;
  fetchProvider?: typeof fetch;
};
function fail(status: number, code: string): never {
  throw Object.assign(new Error(code), { statusCode: status, code });
}
export async function buildApp(o: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 24000,
    requestIdHeader: false,
  });
  app.decorateRequest("actor", null);
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  const d = o.store.db;
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; code?: string };
    const status = error instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
    reply.code(status).send({
      error: {
        code:
          status >= 500
            ? "INTERNAL_ERROR"
            : error instanceof z.ZodError
              ? "INVALID_INPUT"
              : (err.code ?? "REQUEST_REJECTED"),
        correlationId: req.id,
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== o.origin
    )
      fail(403, "ORIGIN_REJECTED");
    const token = req.cookies.chinook_session;
    if (token) {
      const row = d
        .prepare(
          "SELECT u.id,u.email,u.role,s.csrf FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>? AND u.disabled_at IS NULL",
        )
        .get(digest(token), Date.now());
      if (row) req.actor = row as User;
    }
  });
  const auth = async (req: FastifyRequest) => {
    if (!req.actor) fail(401, "LOGIN_REQUIRED");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !equal(String(req.headers["x-csrf-token"] ?? ""), req.actor.csrf)
    )
      fail(403, "CSRF_REJECTED");
  };
  const admin = async (req: FastifyRequest) => {
    await auth(req);
    if (req.actor!.role !== "admin") fail(403, "ADMIN_REQUIRED");
  };
  const secrets = () =>
    d
      .prepare("SELECT provider,encrypted_blob FROM credentials")
      .all()
      .map((r) => decrypt(String(r.encrypted_blob), o.key, String(r.provider)));
  const safeInput = (text: string) => {
    if (redact(text, secrets()) !== text)
      fail(400, "SENSITIVE_CONTENT_REJECTED");
  };
  app.get("/api/setup/status", async () => ({
    needsSetup: !d.prepare("SELECT id FROM users LIMIT 1").get(),
    demo: o.demo,
    targetVersion: "20 Update 10",
  }));
  async function createSession(
    user: { id: string; email: string; role: string },
    reply: FastifyReply,
  ) {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    d.prepare("DELETE FROM auth_sessions WHERE expires_at<?").run(Date.now());
    d.prepare("INSERT INTO auth_sessions VALUES(?,?,?,?)").run(
      digest(token),
      user.id,
      csrf,
      Date.now() + 8 * 3600000,
    );
    reply.setCookie("chinook_session", token, {
      path: "/",
      httpOnly: true,
      secure: o.origin.startsWith("https:"),
      sameSite: "strict",
      maxAge: 8 * 3600,
    });
    return { ...user, csrf };
  }
  app.post(
    "/api/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = userSchema
        .omit({ role: true })
        .extend({ bootstrapToken: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
      if (!equal(input.bootstrapToken, o.bootstrapToken))
        fail(403, "BOOTSTRAP_TOKEN_REJECTED");
      if (d.prepare("SELECT id FROM users LIMIT 1").get())
        fail(409, "ALREADY_CONFIGURED");
      const hash = await argon2.hash(input.password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      });
      const user = {
        id: randomUUID(),
        email: input.email.toLowerCase(),
        role: "admin",
      };
      o.store.transaction(() => {
        if (d.prepare("SELECT id FROM users LIMIT 1").get())
          fail(409, "ALREADY_CONFIGURED");
        d.prepare("INSERT INTO users VALUES(?,?,?,?,NULL,?)").run(
          user.id,
          user.email,
          hash,
          user.role,
          new Date().toISOString(),
        );
        o.store.audit(user.id, "admin.bootstrap", user.id);
      });
      return createSession(user, reply);
    },
  );
  const dummyHash = await argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
  });
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z.email().max(200),
          password: z.string().min(1).max(128),
        })
        .strict()
        .parse(req.body);
      const row = d
        .prepare("SELECT * FROM users WHERE email=? AND disabled_at IS NULL")
        .get(input.email.toLowerCase());
      const ok = await argon2.verify(
        row ? String(row.password_hash) : dummyHash,
        input.password,
      );
      if (!row || !ok) fail(401, "INVALID_CREDENTIALS");
      o.store.audit(String(row.id), "auth.login", String(row.id));
      return createSession(
        {
          id: String(row.id),
          email: String(row.email),
          role: String(row.role),
        },
        reply,
      );
    },
  );
  app.post("/api/auth/logout", { preHandler: auth }, async (req, reply) => {
    d.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(
      digest(req.cookies.chinook_session!),
    );
    reply.clearCookie("chinook_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/auth/me", { preHandler: auth }, async (req) => req.actor);
  app.get("/api/health/live", async () => ({ status: "ok" }));
  app.get("/api/health/ready", { preHandler: auth }, async () => ({
    status: "blocked",
    demo: o.demo,
    voiceEnabled: false,
    reason:
      "Live voice integration is not wired in Phase 1. PBX entitlement, transfer and provider access require validation.",
  }));
  app.get("/api/dashboard/metrics", { preHandler: auth }, async () => ({
    total: d.prepare("SELECT count(*) AS n FROM sessions").get()!.n,
    outcomes: d
      .prepare(
        "SELECT outcome,count(*) AS count FROM sessions GROUP BY outcome",
      )
      .all(),
    demo: o.demo,
    agentName: o.store.agent().name,
    voiceEnabled: false,
  }));
  app.get("/api/settings/connections", { preHandler: admin }, async () => ({
    connections: ["pbx", "openai", "syncro"].map((provider) => {
      const row = d
        .prepare("SELECT updated_at FROM credentials WHERE provider=?")
        .get(provider);
      return {
        provider,
        settings: o.store.setting(`connection:${provider}`),
        secretConfigured: !!row,
        updatedAt: row?.updated_at ?? null,
        test: o.store.setting(`test:${provider}`),
      };
    }),
  }));
  app.put("/api/settings/connections", { preHandler: admin }, async (req) => {
    const input = connectionSchema.parse(req.body),
      { secret, ...settings } = input;
    for (const value of Object.values(settings))
      if (typeof value === "string") safeInput(value);
    o.store.transaction(() => {
      o.store.setting(`connection:${input.provider}`, settings);
      o.store.setting(`test:${input.provider}`, {
        status: "not_tested",
        message: "Configuration changed; run a new test.",
      });
      if (secret)
        d.prepare(
          "INSERT INTO credentials VALUES(?,?,1,?,?) ON CONFLICT(provider) DO UPDATE SET encrypted_blob=excluded.encrypted_blob,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        ).run(
          input.provider,
          encrypt(secret, o.key, input.provider),
          new Date().toISOString(),
          req.actor!.id,
        );
      o.store.audit(
        req.actor!.id,
        "settings.connections.changed",
        input.provider,
      );
    });
    return {
      ok: true,
      secretConfigured: !!d
        .prepare("SELECT provider FROM credentials WHERE provider=?")
        .get(input.provider),
    };
  });
  app.post(
    "/api/settings/test/:provider",
    {
      preHandler: admin,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const provider = providerSchema.parse(
        (req.params as { provider: string }).provider,
      );
      const config = o.store.setting(`connection:${provider}`);
      const row = d
        .prepare("SELECT encrypted_blob FROM credentials WHERE provider=?")
        .get(provider);
      let result: {
        status: string;
        message: string;
        models?: string[];
        testedAt?: string;
      };
      if (o.demo)
        result = {
          status: "blocked",
          message:
            "Demo mode does not contact external providers. Settings are saved securely; use a dedicated test installation for live checks.",
        };
      else if (!config || !row)
        result = {
          status: "blocked",
          message: "Save connection settings and a credential first.",
        };
      else if (provider === "pbx")
        result = {
          status: "blocked",
          message:
            "PBX authentication, entitlement and transfer checks require Phase 2 worker integration. Target: V20 Update 10.",
        };
      else {
        try {
          const key = decrypt(String(row.encrypted_blob), o.key, provider);
          const url =
            provider === "openai"
              ? "https://api.openai.com/v1/models"
              : `https://${config.tenant}.syncromsp.com/api/v1/customers?page=1`;
          const res = await (o.fetchProvider ?? fetch)(url, {
            headers: { Authorization: `Bearer ${key}` },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok)
            result = {
              status: "failed",
              message: `Provider returned HTTP ${res.status}. Check credentials, account permissions and quota.`,
            };
          else {
            const body: any = await res.json();
            if (provider === "openai") {
              const models = z
                .object({ data: z.array(z.object({ id: z.string() })) })
                .parse(body)
                .data.map((m) => m.id)
                .filter((id) => id.includes("realtime"));
              result = {
                status: "read_access_verified",
                message:
                  config.model && !models.includes(config.model)
                    ? "Read access works; selected model was not returned. Realtime voice remains unverified."
                    : "Model listing works. Realtime voice and quota remain unverified.",
                models,
              };
            } else {
              z.object({
                customers: z.array(z.object({ id: z.number() })),
              }).parse(body);
              result = {
                status: "read_access_verified",
                message:
                  "Customer list permission works. Ticket write permissions and tenant fields remain unverified.",
              };
            }
          }
        } catch {
          result = {
            status: "failed",
            message:
              "Connection timed out, was rejected, or returned an unexpected schema. No provider payload was retained.",
          };
        }
      }
      result.testedAt = new Date().toISOString();
      o.store.setting(`test:${provider}`, result);
      o.store.audit(req.actor!.id, "connection.tested", provider);
      return result;
    },
  );
  app.get("/api/settings/agent", { preHandler: auth }, async () => ({
    ...o.store.agent(),
    versionId: o.store.setting("active_prompt"),
  }));
  app.put("/api/settings/agent", { preHandler: admin }, async (req) => {
    const input = agentSchema.parse(req.body);
    safeInput(JSON.stringify(input));
    const id = randomUUID();
    o.store.transaction(() => {
      d.prepare("INSERT INTO prompt_versions VALUES(?,?,?,?)").run(
        id,
        JSON.stringify(input),
        new Date().toISOString(),
        req.actor!.id,
      );
      o.store.setting("active_prompt", id);
      o.store.audit(req.actor!.id, "agent.version.created", id);
    });
    return { ok: true, versionId: id };
  });
  const listSchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(300).optional(),
    q: z.string().max(200).default(""),
    outcome: z
      .enum(["completed", "transferred", "abandoned", "failed", "no_ticket"])
      .optional(),
    clinic: z.string().max(150).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    ticket: z.string().max(100).optional(),
  });
  app.get("/api/conversations", { preHandler: auth }, async (req) => {
    const q = listSchema.parse(req.query),
      where: string[] = [],
      args: (string | number)[] = [];
    if (q.q) {
      where.push(
        "(summary LIKE ? ESCAPE '\\' OR clinic_name LIKE ? ESCAPE '\\' OR id IN (SELECT session_id FROM turns_fts WHERE turns_fts MATCH ?))",
      );
      const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(like, like, '"' + q.q.replace(/"/g, '""') + '"');
    }
    for (const [field, value] of [
      ["outcome", q.outcome],
      ["clinic_name", q.clinic],
      ["ticket_id", q.ticket],
    ] as const)
      if (value) {
        where.push(`${field}=?`);
        args.push(value);
      }
    if (q.from) {
      where.push("started_at>=?");
      args.push(q.from);
    }
    if (q.to) {
      where.push("started_at<=?");
      args.push(q.to);
    }
    if (q.cursor) {
      let cursor;
      try {
        cursor = z
          .object({ time: z.iso.datetime(), id: z.uuid() })
          .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
      } catch {
        fail(400, "INVALID_CURSOR");
      }
      where.push("(started_at<? OR (started_at=? AND id<?))");
      args.push(cursor.time, cursor.time, cursor.id);
    }
    const rows = d
        .prepare(
          `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC,id DESC LIMIT ?`,
        )
        .all(...args, q.limit + 1),
      hasMore = rows.length > q.limit,
      items = rows.slice(0, q.limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ time: last.started_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  });
  function session(id: string) {
    z.uuid().parse(id);
    const row = d.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!row) fail(404, "CONVERSATION_NOT_FOUND");
    return row;
  }
  app.get("/api/conversations/:id", { preHandler: auth }, async (req) => {
    const id = (req.params as { id: string }).id;
    return {
      session: session(id),
      turns: d
        .prepare(
          "SELECT * FROM conversation_turns WHERE session_id=? ORDER BY turn_index LIMIT 200",
        )
        .all(id),
      agent: JSON.parse(
        String(
          d
            .prepare("SELECT content_json FROM prompt_versions WHERE id=?")
            .get(String(session(id).prompt_version_id))!.content_json,
        ),
      ),
      truncated: !!d
        .prepare(
          "SELECT id FROM conversation_turns WHERE session_id=? AND turn_index>=200",
        )
        .get(id),
    };
  });
  app.get("/api/conversations/:id/turns", { preHandler: auth }, async (req) => {
    const id = (req.params as { id: string }).id;
    session(id);
    const q = z
      .object({
        after: z.coerce.number().int().min(-1).default(-1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = d
      .prepare(
        "SELECT * FROM conversation_turns WHERE session_id=? AND turn_index>? ORDER BY turn_index LIMIT ?",
      )
      .all(id, q.after, q.limit + 1);
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextAfter: rows.length > q.limit ? items.at(-1)!.turn_index : null,
    };
  });
  app.get(
    "/api/conversations/:id/events",
    { preHandler: auth },
    async (req) => {
      const id = (req.params as { id: string }).id;
      session(id);
      const q = z
        .object({
          after: z.coerce.number().int().min(-1).default(-1),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const rows = d
        .prepare(
          "SELECT * FROM call_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(id, q.after, q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextAfter: rows.length > q.limit ? items.at(-1)!.sequence : null,
      };
    },
  );
  app.get(
    "/api/conversations/:id/export",
    { preHandler: admin },
    async (req, reply) => {
      const id = (req.params as { id: string }).id,
        row = session(id);
      const count = Number(
        d
          .prepare(
            "SELECT count(*) AS n FROM conversation_turns WHERE session_id=?",
          )
          .get(id)!.n,
      );
      const eventCount = Number(
        d
          .prepare("SELECT count(*) n FROM call_events WHERE session_id=?")
          .get(id)!.n,
      );
      if (count > 10000 || eventCount > 10000) fail(422, "EXPORT_TOO_LARGE");
      o.store.audit(req.actor!.id, "conversation.exported", id);
      reply.header(
        "Content-Disposition",
        `attachment; filename="conversation-${id}.json"`,
      );
      return {
        session: row,
        turns: d
          .prepare(
            "SELECT * FROM conversation_turns WHERE session_id=? ORDER BY turn_index",
          )
          .all(id),
        events: d
          .prepare(
            "SELECT * FROM call_events WHERE session_id=? ORDER BY sequence",
          )
          .all(id),
        notice:
          "Automated redaction is imperfect. Synthetic calls are explicitly marked.",
      };
    },
  );
  app.get("/api/admin/users", { preHandler: admin }, async () => ({
    items: d
      .prepare(
        "SELECT id,email,role,disabled_at,created_at FROM users ORDER BY created_at LIMIT 200",
      )
      .all(),
  }));
  app.post("/api/admin/users", { preHandler: admin }, async (req) => {
    const input = userSchema.strict().parse(req.body);
    const hash = await argon2.hash(input.password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }),
      id = randomUUID();
    if (
      d
        .prepare("SELECT id FROM users WHERE email=?")
        .get(input.email.toLowerCase())
    )
      fail(409, "USER_EXISTS");
    d.prepare("INSERT INTO users VALUES(?,?,?,?,NULL,?)").run(
      id,
      input.email.toLowerCase(),
      hash,
      input.role,
      new Date().toISOString(),
    );
    o.store.audit(req.actor!.id, "user.created", id);
    return { id, email: input.email, role: input.role };
  });
  app.get("/api/admin/audit", { preHandler: admin }, async (req) => {
    const q = z
      .object({
        after: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    let time = "9999",
      id = "z";
    if (q.after) {
      try {
        const c = z
          .object({ time: z.iso.datetime(), id: z.uuid() })
          .parse(JSON.parse(Buffer.from(q.after, "base64url").toString()));
        time = c.time;
        id = c.id;
      } catch {
        fail(400, "INVALID_CURSOR");
      }
    }
    const rows = d
        .prepare(
          "SELECT * FROM audit_events WHERE occurred_at<? OR (occurred_at=? AND id<?) ORDER BY occurred_at DESC,id DESC LIMIT ?",
        )
        .all(time, time, id, q.limit + 1),
      items = rows.slice(0, q.limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ time: last.occurred_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  });
  if (o.webRoot) {
    await app.register(statics, { root: o.webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", correlationId: req.id } });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
