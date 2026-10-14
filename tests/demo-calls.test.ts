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
function assistant(socket: Control, text: string) {
  const responseId = randomUUID();
  socket.emit({ type: "response.created", response: { id: responseId } });
  socket.emit({
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    item_id: randomUUID(),
    transcript: text,
  });
  socket.emit({
    type: "response.done",
    response: { id: responseId, status: "completed" },
  });
}
async function draft(f: Awaited<ReturnType<typeof fixture>>, live = false) {
  const started = await f.manager.start(f.owner, {
    sdp: offer,
    ...(live ? { writeMode: "live_test", testCustomerId: "42" } : {}),
  });
  f.manager.activate(f.owner, started.id);
  caller(f.socket, "Demo Clinic, printer scan failure");
  const match = await tool(f.socket, "match_clinic", { name: "Demo Clinic" });
  assert.deepEqual(match, {
    status: "confirmation_required",
    suggested_clinic_name: "Demo Clinic",
  });
  assistant(f.socket, "Did you mean Demo Clinic?");
  caller(f.socket, "Yes, that's the clinic");
  await tool(f.socket, "match_clinic", { name: "Demo Clinic", confirm: true });
  caller(
    f.socket,
    "My first name is Demo and last name is Caller, callback 403-317-1360, printer P016, workstation W015",
  );
  await tool(f.socket, "update_intake", {
    fields: {
      firstName: "Demo",
      lastName: "Caller",
      callbackNumber: "403-317-1360",
      printerIdentifier: "P016",
      workstationNumber: "W015",
      issueType: "printer",
      summary: "Printer scan failure",
      details: "password is test-secret. Printing works.",
    },
  });
  assistant(
    f.socket,
    "Demo Caller, 403-317-1360, printer P016, workstation W015. Is that correct?",
  );
  caller(f.socket, "Yes, those details are correct");
  await tool(f.socket, "confirm_intake", {
    fields: [
      "firstName",
      "lastName",
      "callbackNumber",
      "printerIdentifier",
      "workstationNumber",
    ],
  });
  const prepared = await tool(f.socket, "prepare_ticket", {});
  assert.equal(prepared.status, "confirmation_required");
  assistant(f.socket, prepared.spokenSummary);
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
    f.manager.snapshot(f.owner, started.id).draft!.content.details,
    "password: [REDACTED] Printing works.",
  );
  const first = await tool(f.socket, "create_ticket", {
    draftId: prepared.draftId,
  });
  assert.equal(first.status, "clarification_required");
  caller(f.socket, "Yes, that is accurate");
  const result = await tool(f.socket, "create_ticket", {
    draftId: prepared.draftId,
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
  const { started, prepared: originalPrepared } = await draft(f, true);
  let prepared = originalPrepared;
  const wrong = await tool(f.socket, "prepare_ticket", {
    clinicId: "88",
    callerName: "Demo",
    callbackNumber: "555",
    summary: "Bad",
    details: "Bad",
  });
  assert.equal(wrong.status, "clarification_required");
  caller(f.socket, "Yes but change the callback");
  assert.equal(
    (
      await tool(f.socket, "create_ticket", {
        draftId: prepared.draftId,
      })
    ).status,
    "clarification_required",
  );
  caller(f.socket, "Change callback to 403-317-2360");
  await tool(f.socket, "update_intake", {
    fields: { callbackNumber: "403-317-2360" },
  });
  assistant(
    f.socket,
    "Is 403-317-2360 the callback number you want me to use?",
  );
  caller(f.socket, "Yes, that is correct");
  await tool(f.socket, "confirm_intake", { fields: ["callbackNumber"] });
  prepared = await tool(f.socket, "prepare_ticket", {});
  assistant(f.socket, prepared.spokenSummary);
  caller(f.socket, "Yes, that is correct");
  const result = await tool(f.socket, "create_ticket", {
    draftId: prepared.draftId,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.ticket_number, "1234");
  const again = await tool(f.socket, "create_ticket", {
    draftId: prepared.draftId,
  });
  assert.equal(again.ticket_number, "1234");
  const writes = f.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/tickets"),
  );
  assert.equal(writes.length, 1);
  const body = JSON.parse(writes[0].body);
  assert.equal(body.customer_id, 42);
  assert.equal(body.contact_id, undefined);
  assert.match(
    body.comments_attributes[0].body,
    /Callback \(authoritative\): \+14033172360/,
  );
  assert.match(body.comments_attributes[0].body, /Workstation: W015/);
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
    const result = await tool(f.socket, "create_ticket", {
      draftId: prepared.draftId,
    });
    assert.equal(
      result.outcome,
      mode === "rejected" ? "failed" : "unknown_outcome",
    );
    const duplicate = await tool(f.socket, "create_ticket", {
      draftId: prepared.draftId,
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

test("a delayed earlier yes cannot confirm a later draft; corrections preserve facts and require fresh confirmation", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const { started, prepared } = await draft(f);
  const earlier = randomUUID();
  f.socket.emit({ type: "input_audio_buffer.committed", item_id: earlier });
  caller(f.socket, "Change callback to 403-317-2360");
  await tool(f.socket, "update_intake", {
    fields: { callbackNumber: "403-317-2360" },
  });
  let response = await tool(f.socket, "prepare_ticket", {});
  assert.equal(response.field, "callbackNumber");
  f.socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: earlier,
    transcript: "Yes",
  });
  response = await tool(f.socket, "confirm_intake", {
    fields: ["callbackNumber"],
  });
  assert.equal(response.status, "clarification_required");
  assistant(
    f.socket,
    "Is 403-317-2360 the callback number you want me to use?",
  );
  caller(f.socket, "Yes, that's the corrected number");
  await tool(f.socket, "confirm_intake", { fields: ["callbackNumber"] });
  const revised = await tool(f.socket, "prepare_ticket", {});
  assert.notEqual(revised.draftId, prepared.draftId);
  const content = f.manager.snapshot(f.owner, started.id).draft!.content;
  assert.equal(content.callbackNumber, "+14033172360");
  assert.equal(content.callbackOriginal, "403-317-2360");
  assert.equal(content.workstationNumber, "W015");
  assert.equal(content.lastName, "Caller");
  assert.equal(content.confirmedFields.lastName, true);
  assistant(f.socket, revised.spokenSummary);
  caller(f.socket, "Yes, correct");
  assert.equal(
    (await tool(f.socket, "create_ticket", { draftId: revised.draftId }))
      .outcome,
    "previewed",
  );
});

test("existing prompts receive mandatory continuity, one greeting and semantic balanced VAD", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const agent = f.store.agent();
  f.store.db
    .prepare("UPDATE prompt_versions SET content_json=? WHERE id=?")
    .run(
      JSON.stringify({ ...agent, prompt: "Custom receptionist instructions" }),
      f.store.setting("active_prompt"),
    );
  const started = await f.manager.start(f.owner, {
    sdp: offer,
    writeMode: "live_test",
    testCustomerId: "42",
  });
  const request = f.requests.find((r) => r.url.endsWith("/realtime/calls"))!;
  const session = JSON.parse(
    (request.body as FormData).get("session") as string,
  );
  assert.ok(session.instructions.includes("Custom receptionist instructions"));
  assert.ok(session.instructions.includes("Never greet or introduce yourself"));
  assert.ok(!session.instructions.includes("customer ID 42"));
  assert.deepEqual(session.audio.input.noise_reduction, { type: "far_field" });
  assert.equal(session.audio.input.transcription.language, "en");
  assert.ok(
    session.audio.input.transcription.prompt.includes(
      "Preserve spoken letters and digits exactly",
    ),
  );
  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "medium",
    create_response: false,
    interrupt_response: true,
  });
  f.manager.activate(f.owner, started.id);
  f.manager.activate(f.owner, started.id);
  const greetings = f.socket.sent.filter(
    (e) => e.type === "response.create" && e.response?.instructions,
  );
  assert.equal(greetings.length, 1);
  const update = f.socket.sent.find((e) => e.type === "session.update");
  assert.deepEqual(update.session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "medium",
    create_response: true,
    interrupt_response: true,
  });
});
test("interrupted transcripts are removed from searchable history and cancelled tools never execute", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const started = await f.manager.start(f.owner, { sdp: offer });
  f.manager.activate(f.owner, started.id);
  f.socket.emit({
    type: "response.output_audio_transcript.done",
    item_id: "assistant-1",
    response_id: "response-1",
    transcript: "Neverheardword continuation",
  });
  f.socket.emit({
    type: "response.function_call_arguments.done",
    response_id: "response-1",
    call_id: "cancelled-tool",
    name: "match_clinic",
    arguments: '{"name":"Demo Clinic"}',
  });
  f.socket.emit({ type: "input_audio_buffer.speech_started" });
  f.socket.emit({
    type: "response.done",
    response: { id: "response-1", status: "cancelled" },
  });
  f.socket.emit({
    type: "conversation.item.truncated",
    item_id: "assistant-2",
  });
  f.socket.emit({
    type: "response.output_audio_transcript.done",
    item_id: "assistant-2",
    response_id: "response-2",
    transcript: "Neverheardword delayed transcript",
  });
  await new Promise((r) => setTimeout(r, 30));
  const snapshot = f.manager.snapshot(f.owner, started.id);
  assert.equal(snapshot.turns.length, 2);
  assert.ok(snapshot.turns.every((turn: any) => turn.is_interrupted === 1));
  assert.ok(!JSON.stringify(snapshot).includes("Neverheardword"));
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) n FROM turns_fts WHERE turns_fts MATCH 'Neverheardword'",
      )
      .get()!.n,
    0,
  );
  assert.ok(!f.socket.sent.some((e) => e.item?.call_id === "cancelled-tool"));
});
test("real ticket creation kill switch rejects writes before contacting providers", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  f.store.db
    .prepare("UPDATE prompt_versions SET content_json=? WHERE id=?")
    .run(
      JSON.stringify({ ...f.store.agent(), ticketCreationEnabled: false }),
      f.store.setting("active_prompt"),
    );
  await assert.rejects(
    () =>
      f.manager.start(f.owner, {
        sdp: offer,
        writeMode: "live_test",
        testCustomerId: "42",
      }),
    /REAL_TICKET_CREATION_DISABLED/,
  );
  assert.equal(f.requests.length, 0);
});

test("tool completion does not start a second speaking response after Ryan already asked a question", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const started = await f.manager.start(f.owner, { sdp: offer });
  f.manager.activate(f.owner, started.id);
  caller(f.socket, "The printer stopped working.");
  const responseId = randomUUID(),
    callId = randomUUID();
  f.socket.emit({ type: "response.created", response: { id: responseId } });
  f.socket.emit({
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    item_id: randomUUID(),
    transcript: "Who else is affected?",
  });
  const before = f.socket.sent.filter(
    (e) => e.type === "response.create",
  ).length;
  f.socket.emit({
    type: "response.function_call_arguments.done",
    response_id: responseId,
    call_id: callId,
    name: "update_intake",
    arguments: JSON.stringify({
      fields: { summary: "Printer stopped working" },
    }),
  });
  f.socket.emit({
    type: "response.done",
    response: { id: responseId, status: "completed" },
  });
  for (
    let i = 0;
    i < 100 && !f.socket.sent.some((e) => e.item?.call_id === callId);
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(f.socket.sent.some((e) => e.item?.call_id === callId));
  assert.equal(
    f.socket.sent.filter((e) => e.type === "response.create").length,
    before,
  );
});
test("a delayed readback transcript recognizes the reply using response-start turn order", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const started = await f.manager.start(f.owner, { sdp: offer });
  f.manager.activate(f.owner, started.id);
  caller(f.socket, "4033171360");
  await tool(f.socket, "update_intake", {
    fields: { callbackNumber: "4033171360" },
  });
  const responseId = randomUUID();
  f.socket.emit({ type: "response.created", response: { id: responseId } });
  caller(f.socket, "Yep");
  f.socket.emit({
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    item_id: randomUUID(),
    transcript: "4 0 3 3 1 7 1 3 6 0. Is that correct?",
  });
  f.socket.emit({
    type: "response.done",
    response: { id: responseId, status: "completed" },
  });
  const result = await tool(f.socket, "confirm_intake", {
    fields: ["callbackNumber"],
  });
  assert.equal(result.status, "confirmed");
});

test("microphone profiles and balanced VAD are applied to each new call", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  for (const noiseReduction of ["near_field", "off"] as const) {
    f.store.db
      .prepare("UPDATE prompt_versions SET content_json=? WHERE id=?")
      .run(
        JSON.stringify({
          ...f.store.agent(),
          noiseReduction,
          vadEagerness: "medium",
        }),
        f.store.setting("active_prompt"),
      );
    const started = await f.manager.start(f.owner, { sdp: offer });
    const request = f.requests
      .filter((r) => r.url.endsWith("/realtime/calls"))
      .at(-1)!;
    const session = JSON.parse(
      (request.body as FormData).get("session") as string,
    );
    assert.deepEqual(
      session.audio.input.noise_reduction,
      noiseReduction === "off" ? null : { type: "near_field" },
    );
    assert.equal(session.audio.input.turn_detection.eagerness, "medium");
    f.manager.activate(f.owner, started.id);
    assert.equal(
      f.socket.sent.filter((e) => e.type === "session.update").at(-1).session
        .audio.input.turn_detection.eagerness,
      "medium",
    );
    await f.manager.end(f.owner, started.id);
  }
});

test("call diagnostics separate transcription, response and playback delays", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.manager.close();
    f.store.close();
  });
  const started = await f.manager.start(f.owner, { sdp: offer });
  f.manager.activate(f.owner, started.id);
  f.socket.emit({ type: "input_audio_buffer.speech_started" });
  f.socket.emit({ type: "input_audio_buffer.speech_stopped" });
  f.socket.emit({
    type: "input_audio_buffer.committed",
    item_id: "timing-caller",
  });
  f.socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "timing-caller",
    transcript: "A printer is not printing.",
  });
  f.socket.emit({
    type: "response.created",
    response: { id: "timing-response" },
  });
  f.socket.emit({ type: "output_audio_buffer.started" });
  const events = f.manager.snapshot(f.owner, started.id).events as any[];
  for (const type of [
    "timing.transcription",
    "timing.response",
    "timing.audio",
  ]) {
    const event = events.find((e) => e.event_type === type);
    assert.ok(event, type);
    assert.match(event.public_summary, /: \d+ ms$/);
    assert.ok(!event.public_summary.includes("printer"));
  }
});
