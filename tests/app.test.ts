import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../apps/server/src/app.ts";
import { Store } from "../apps/server/src/store.ts";
import { defaultAgent } from "../packages/shared/src/config.ts";
const origin = "http://localhost:3000",
  password = "long synthetic password 123";
async function fixture(
  options: Partial<import("../apps/server/src/app.ts").AppOptions> = {},
) {
  const store = new Store(":memory:");
  store.seed();
  const app = await buildApp({
    store,
    key: randomBytes(32),
    bootstrapToken: "synthetic-bootstrap",
    origin,
    demo: true,
    ...options,
  });
  return { store, app };
}
async function setup(app: any) {
  const r = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { origin },
    payload: {
      email: "admin@example.test",
      password,
      bootstrapToken: "synthetic-bootstrap",
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  return { cookie: r.headers["set-cookie"].split(";")[0], csrf: r.json().csrf };
}
function headers(auth: { cookie: string; csrf: string }) {
  return { origin, cookie: auth.cookie, "x-csrf-token": auth.csrf };
}
test("first admin requires bootstrap token, origin and strong password; setup locks after success", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  assert.equal(
    (await app.inject({ url: "/api/conversations" })).statusCode,
    401,
  );
  const bad = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { origin },
    payload: { email: "admin@example.test", password, bootstrapToken: "wrong" },
  });
  assert.equal(bad.statusCode, 403);
  await setup(app);
  assert.equal(
    (await app.inject({ url: "/api/setup/status" })).json().needsSetup,
    false,
  );
  const repeat = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { origin },
    payload: {
      email: "admin@example.test",
      password,
      bootstrapToken: "synthetic-bootstrap",
    },
  });
  assert.equal(repeat.statusCode, 409);
});
test("stored credentials remain encrypted, masked and excluded from all readable settings and audit responses", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app),
    secret = "sk-example_secret_value_long";
  const save = await app.inject({
    method: "PUT",
    url: "/api/settings/connections",
    headers: headers(a),
    payload: { provider: "openai", model: "", voice: "", secret },
  });
  assert.equal(save.statusCode, 200, save.body);
  const row = store.db.prepare("SELECT encrypted_blob FROM credentials").get()!;
  assert.ok(!String(row.encrypted_blob).includes(secret));
  for (const url of [
    "/api/settings/connections",
    "/api/admin/audit",
    "/api/auth/me",
    "/api/conversations",
  ]) {
    const res = await app.inject({ url, headers: headers(a) });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(secret));
  }
  const response = await app.inject({
    method: "PUT",
    url: "/api/settings/connections",
    headers: headers(a),
    payload: { provider: "openai", model: "", voice: "" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM credentials").get()!.n,
    1,
  );
  const prompt = await app.inject({
    method: "PUT",
    url: "/api/settings/agent",
    headers: headers(a),
    payload: { ...defaultAgent, prompt: secret },
  });
  assert.equal(prompt.statusCode, 400);
  assert.ok(!prompt.body.includes(secret));
});
test("mutations require the logged-in CSRF token and same origin", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  for (const h of [
    { origin, cookie: a.cookie },
    { ...headers(a), origin: "https://attacker.test" },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/agent",
          headers: h,
          payload: defaultAgent,
        })
      ).statusCode,
      403,
    );
  }
});
test("support user sees history but cannot access credentials, create users, change prompts or export", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: headers(a),
        payload: { email: "support@example.test", password, role: "support" },
      })
    ).statusCode,
    200,
  );
  const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin },
      payload: { email: "support@example.test", password },
    }),
    s = {
      cookie: String(login.headers["set-cookie"]).split(";")[0],
      csrf: login.json().csrf,
    };
  const history = await app.inject({
    url: "/api/conversations",
    headers: headers(s),
  });
  assert.equal(history.statusCode, 200);
  const id = history.json().items[0].id;
  for (const url of [
    "/api/settings/connections",
    "/api/demo-calls/status",
    "/api/admin/users",
    `/api/conversations/${id}/export`,
  ])
    assert.equal(
      (await app.inject({ url, headers: headers(s) })).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/agent",
        headers: headers(s),
        payload: defaultAgent,
      })
    ).statusCode,
    403,
  );
});
test("cursor history includes every outcome without duplicates and accepts literal transcript search", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  let cursor: string | null = null,
    ids: string[] = [];
  do {
    const r: any = await app.inject({
      url: "/api/conversations?limit=11" + (cursor ? "&cursor=" + cursor : ""),
      headers: headers(a),
    });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    ids.push(...b.items.map((s: any) => s.id));
    cursor = b.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75);
  for (const q of [
    "destination unavailable",
    '" OR 1=1 --',
    "%",
    "NEAR(",
    "[REDACTED]",
  ]) {
    const r = await app.inject({
      url: "/api/conversations?q=" + encodeURIComponent(q),
      headers: headers(a),
    });
    assert.equal(r.statusCode, 200, r.body);
    if (q === "destination unavailable") assert.ok(r.json().items.length > 0);
  }
  assert.equal(
    (
      await app.inject({
        url: "/api/conversations?cursor=invalid",
        headers: headers(a),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/conversations?limit=201",
        headers: headers(a),
      })
    ).statusCode,
    400,
  );
});
test("historical calls keep their prompt version and redacted transcripts after agent changes", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app),
    id = String(store.db.prepare("SELECT id FROM sessions LIMIT 1").get()!.id);
  await app.inject({
    method: "PUT",
    url: "/api/settings/agent",
    headers: headers(a),
    payload: { ...defaultAgent, name: "Future name" },
  });
  const r = await app.inject({
    url: "/api/conversations/" + id,
    headers: headers(a),
  });
  assert.equal(r.json().agent.name, "Ryan");
  assert.ok(!r.body.includes("synthetic-secret"));
  assert.equal(
    (
      await app.inject({
        url: "/api/conversations/" + id + "/export",
        headers: headers(a),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE operation='conversation.exported'",
      )
      .get()!.n,
    1,
  );
});
test("demo provider checks are blocked and live readiness never claims success", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  for (const p of ["pbx", "openai", "syncro"]) {
    const r = await app.inject({
      method: "POST",
      url: "/api/settings/test/" + p,
      headers: headers(a),
      payload: {},
    });
    assert.equal(r.json().status, "blocked");
  }
  assert.equal(
    (await app.inject({ url: "/api/health/ready", headers: headers(a) })).json()
      .voiceEnabled,
    false,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/conversations/not-a-uuid",
        headers: headers(a),
      })
    ).statusCode,
    400,
  );
});
test("logout revokes authenticated access", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: headers(a),
    payload: {},
  });
  assert.equal(
    (await app.inject({ url: "/api/auth/me", headers: headers(a) })).statusCode,
    401,
  );
});

test("turn/event pagination ends cleanly at an exact page boundary", async (t) => {
  const { app, store } = await fixture();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app),
    id = String(store.db.prepare("SELECT id FROM sessions LIMIT 1").get()!.id);
  const turns = await app.inject({
    url: `/api/conversations/${id}/turns?limit=5`,
    headers: headers(a),
  });
  assert.equal(turns.json().items.length, 5);
  assert.equal(turns.json().nextAfter, null);
  const first = await app.inject({
    url: `/api/conversations/${id}/events?limit=2`,
    headers: headers(a),
  });
  assert.equal(first.json().nextAfter, 1);
  const last = await app.inject({
    url: `/api/conversations/${id}/events?limit=2&after=1`,
    headers: headers(a),
  });
  assert.equal(last.json().items.length, 2);
  assert.equal(last.json().nextAfter, null);
});

test("non-demo read checks are scoped and discard customer payloads and raw provider errors", async (t) => {
  let mode = "models",
    requests: { url: string; headers: any }[] = [];
  const secret = "synthetic-test-credential";
  const mock: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: init?.headers });
    if (mode === "models")
      return new Response(
        JSON.stringify({
          data: [{ id: "documented-realtime-model" }, { id: "other-model" }],
        }),
      );
    if (mode === "customers")
      return new Response(
        JSON.stringify({ customers: [{ id: 1, notes: secret }] }),
      );
    if (mode === "error") return new Response(secret, { status: 401 });
    return new Response(JSON.stringify({ secret }));
  };
  const { app, store } = await fixture({ demo: false, fetchProvider: mock });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const a = await setup(app);
  for (const payload of [
    {
      provider: "openai",
      model: "documented-realtime-model",
      voice: "",
      secret,
    },
    { provider: "syncro", tenant: "synthetic-clinic", secret },
  ])
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/connections",
          headers: headers(a),
          payload,
        })
      ).statusCode,
      200,
    );
  const check = async (p: string) =>
    app.inject({
      method: "POST",
      url: "/api/settings/test/" + p,
      headers: headers(a),
      payload: {},
    });
  let r = await check("openai");
  assert.equal(r.json().status, "read_access_verified");
  assert.deepEqual(r.json().models, ["documented-realtime-model"]);
  assert.equal(requests.at(-1)!.url, "https://api.openai.com/v1/models");
  mode = "customers";
  r = await check("syncro");
  assert.equal(r.json().status, "read_access_verified");
  assert.ok(!r.body.includes(secret));
  assert.equal(
    requests.at(-1)!.url,
    "https://synthetic-clinic.syncromsp.com/api/v1/customers?page=1",
  );
  for (mode of ["error", "malformed"]) {
    r = await check("openai");
    assert.equal(r.json().status, "failed");
    assert.ok(!r.body.includes(secret));
  }
  assert.ok(!JSON.stringify(store.setting("test:syncro")).includes(secret));
});
