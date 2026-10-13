import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../apps/server/src/store.ts";
import {
  DemoCalls,
  type ControlSocket,
} from "../apps/server/src/demo-calls.ts";
import { encrypt } from "../packages/security/src/index.ts";
const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
class Control implements ControlSocket {
  sent: any[] = [];
  handler: (s: string) => void = () => {};
  closed: () => void = () => {};
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed();
  }
  onMessage(h: (s: string) => void) {
    this.handler = h;
  }
  onClose(h: () => void) {
    this.closed = h;
  }
  emit(e: any) {
    this.handler(JSON.stringify(e));
  }
}
async function fixture(mode = "success") {
  const store = new Store(":memory:"),
    key = randomBytes(32),
    owner = randomUUID(),
    socket = new Control(),
    requests: { url: string; method: string; body: any }[] = [];
  store.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,NULL,?)")
    .run(
      owner,
      "demo@example.test",
      "not-used",
      "admin",
      new Date().toISOString(),
    );
  for (const provider of ["openai", "syncro"])
    store.db
      .prepare("INSERT INTO credentials VALUES(?,?,1,?,?)")
      .run(
        provider,
        encrypt(`synthetic-${provider}-key`, key, provider),
        new Date().toISOString(),
        owner,
      );
  store.setting("connection:openai", {
    model: "validated-realtime-model",
    voice: "alloy",
  });
  store.setting("connection:syncro", { tenant: "synthetic-test" });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body });
    if (url.includes("/realtime/calls") && !url.endsWith("/hangup"))
      return new Response(offer, {
        status: 201,
        headers: { location: "/v1/realtime/calls/rtc_test123" },
      });
    if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
    if (method === "POST" && url.endsWith("/tickets")) {
      if (mode === "timeout") throw new Error("Synthetic timeout");
      if (mode === "malformed") return new Response("{}");
      if (mode === "rejected")
        return new Response("synthetic-secret-error", { status: 422 });
      return Response.json({
        ticket: { id: 55, number: 1234, customer_id: 42 },
      });
    }
    if (url.includes("/customers"))
      return Response.json({
        customers: [{ id: 42, business_name: "Demo Clinic" }],
      });
    if (url.includes("/contacts"))
      return Response.json({
        contacts: [
          { id: 9, customer_id: 42, name: "Demo Caller" },
          { id: 10, customer_id: 88, name: "Wrong Clinic" },
        ],
      });
    return Response.json({ tickets: [] });
  };
  const manager = new DemoCalls({
    store,
    key,
    enabled: true,
    fetcher,
    connect: async () => socket,
  });
  return { store, owner, socket, requests, manager };
}
async function tool(socket: Control, name: string, args: unknown) {
  const callId = randomUUID();
  socket.emit({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
  socket.emit({
    type: "response.done",
    response: { id: randomUUID(), status: "completed" },
  });
  for (let i = 0; i < 200; i++) {
    const sent = socket.sent.find((e) => e.item?.call_id === callId);
    if (sent) return JSON.parse(sent.item.output);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Tool result timed out");
}
function caller(socket: Control, text: string, item = randomUUID()) {
  socket.emit({ type: "input_audio_buffer.committed", item_id: item });
  socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: item,
    event_id: randomUUID(),
    transcript: text,
  });
  return item;
}
async function draft(f: Awaited<ReturnType<typeof fixture>>, live = false) {
  const started = await f.manager.start(f.owner, {
    sdp: offer,
    ...(live ? { writeMode: "live_test", testCustomerId: "42" } : {}),
  });
  f.manager.activate(f.owner, started.id);
  caller(f.socket, "Demo Clinic, printer scan failure");
  await tool(f.socket, "find_clinic", { name: "Demo Clinic" });
  await tool(f.socket, "confirm_clinic", {
    clinicId: "42",
    callerConfirmed: true,
  });
  await tool(f.socket, "find_contact", { clinicId: "42", name: "Demo" });
  const prepared = await tool(f.socket, "prepare_ticket", {
    clinicId: "42",
    contactId: "9",
    callerName: "Demo Caller",
    callbackNumber: "555-0100",
    summary: "Printer scan failure",
    details: "password is test-secret. Printing works.",
  });
  return { started, prepared };
}
test("browser call snapshots hide keys, capture redacted final turns and deduplicate transcripts", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const r = await f.manager.start(f.owner, { sdp: offer });
  assert.equal(r.writeMode, "preview");
  assert.ok(!JSON.stringify(r).includes("synthetic-openai-key"));
  f.manager.activate(f.owner, r.id);
  const item = caller(f.socket, "password is synthetic-password");
  caller(f.socket, "password is synthetic-password", item);
  const s = f.manager.snapshot(f.owner, r.id);
  assert.equal(s.turns.length, 1);
  assert.ok(!JSON.stringify(s).includes("synthetic-password"));
  assert.throws(
    () => f.manager.snapshot(randomUUID(), r.id),
    /DEMO_CALL_NOT_FOUND/,
  );
  await assert.rejects(
    () => f.manager.start(f.owner, { sdp: offer }),
    /DEMO_CALL_ALREADY_ACTIVE/,
  );
  await f.manager.end(f.owner, r.id);
  assert.ok(f.requests.some((r) => r.url.endsWith("/hangup")));
  assert.equal(f.manager.snapshot(f.owner, r.id).status, "ended");
});
test("preview is default, requires a new spoken confirmation and never POSTs to Syncro", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const { started, prepared } = await draft(f);
  assert.equal(
    prepared.content.details,
    "password: [REDACTED] Printing works.",
  );
  const first = await tool(f.socket, "submit_ticket", {
    draftId: prepared.draftId,
    callerConfirmed: true,
  });
  assert.equal(first.outcome, "failed");
  caller(f.socket, "Yes, that is accurate");
  const result = await tool(f.socket, "submit_ticket", {
    draftId: prepared.draftId,
    callerConfirmed: true,
  });
  assert.equal(result.outcome, "previewed");
  assert.equal(
    f.manager.snapshot(f.owner, started.id).draft!.status,
    "preview_confirmed",
  );
  assert.equal(
    f.requests.filter((r) => r.method === "POST" && r.url.endsWith("/tickets"))
      .length,
    0,
  );
});
test("live test requires customer allowlist and creates one correctly labelled confirmed ticket", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  await assert.rejects(
    () => f.manager.start(f.owner, { sdp: offer, writeMode: "live_test" }),
    /REAL_TEST_REQUIRES_CUSTOMER_ID/,
  );
  const { started, prepared } = await draft(f, true);
  const wrong = await tool(f.socket, "prepare_ticket", {
    clinicId: "88",
    callerName: "Demo",
    callbackNumber: "555",
    summary: "Bad",
    details: "Bad",
  });
  assert.equal(wrong.outcome, "failed");
  caller(f.socket, "Yes but change the callback");
  assert.equal(
    (
      await tool(f.socket, "submit_ticket", {
        draftId: prepared.draftId,
        callerConfirmed: true,
      })
    ).outcome,
    "failed",
  );
  caller(f.socket, "Yes, that is correct");
  const result = await tool(f.socket, "submit_ticket", {
    draftId: prepared.draftId,
    callerConfirmed: true,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.ticketNumber, "1234");
  const again = await tool(f.socket, "submit_ticket", {
    draftId: prepared.draftId,
    callerConfirmed: true,
  });
  assert.equal(again.ticketNumber, "1234");
  const writes = f.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/tickets"),
  );
  assert.equal(writes.length, 1);
  const body = JSON.parse(writes[0].body);
  assert.equal(body.customer_id, 42);
  assert.equal(body.contact_id, 9);
  assert.match(body.subject, /^\[BROWSER TEST\]/);
  assert.equal(body.comments_attributes[0].do_not_email, true);
  assert.ok(!body.comments_attributes[0].body.includes("test-secret"));
  assert.equal(
    f.manager.snapshot(f.owner, started.id).draft!.result!.ticket_number,
    "1234",
  );
});
for (const mode of ["timeout", "malformed", "rejected"])
  test(`real ticket ${mode} never fabricates success or retries`, async (t) => {
    const f = await fixture(mode);
    t.after(async () => {
      await f.manager.close();
      f.store.close();
    });
    const { prepared } = await draft(f, true);
    caller(f.socket, "Yes, confirmed");
    const result = await tool(f.socket, "submit_ticket", {
      draftId: prepared.draftId,
      callerConfirmed: true,
    });
    assert.equal(
      result.outcome,
      mode === "rejected" ? "failed" : "unknown_outcome",
    );
    const duplicate = await tool(f.socket, "submit_ticket", {
      draftId: prepared.draftId,
      callerConfirmed: true,
    });
    assert.equal(duplicate.outcome, result.outcome);
    assert.equal(
      f.requests.filter(
        (r) => r.method === "POST" && r.url.endsWith("/tickets"),
      ).length,
      1,
    );
    assert.ok(!JSON.stringify(result).includes("synthetic-secret-error"));
  });

test("a delayed earlier yes cannot confirm a later draft; corrections create a fresh draft", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const started = await f.manager.start(f.owner, { sdp: offer });
  f.manager.activate(f.owner, started.id);
  await tool(f.socket, "find_clinic", { name: "Demo Clinic" });
  await tool(f.socket, "confirm_clinic", {
    clinicId: "42",
    callerConfirmed: true,
  });
  const earlier = randomUUID();
  f.socket.emit({ type: "input_audio_buffer.committed", item_id: earlier });
  const args = {
    clinicId: "42",
    callerName: "Demo",
    callbackNumber: "555-0100",
    summary: "Printer failed",
    details: "One user",
  };
  const prepared = await tool(f.socket, "prepare_ticket", args);
  f.socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: earlier,
    transcript: "Yes",
  });
  assert.equal(
    (
      await tool(f.socket, "submit_ticket", {
        draftId: prepared.draftId,
        callerConfirmed: true,
      })
    ).outcome,
    "failed",
  );
  caller(f.socket, "Change callback to 555-0200");
  const revised = await tool(f.socket, "prepare_ticket", {
    ...args,
    callbackNumber: "555-0200",
  });
  assert.notEqual(revised.draftId, prepared.draftId);
  assert.equal(
    f.manager.snapshot(f.owner, started.id).draft!.content.callbackNumber,
    "555-0200",
  );
  caller(f.socket, "Yes, correct");
  assert.equal(
    (
      await tool(f.socket, "submit_ticket", {
        draftId: revised.draftId,
        callerConfirmed: true,
      })
    ).outcome,
    "previewed",
  );
});
