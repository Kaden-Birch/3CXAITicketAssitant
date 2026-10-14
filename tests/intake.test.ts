import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../apps/server/src/store.ts";
import {
  DemoIntake,
  demoToolDefinitions,
} from "../packages/conversation/src/demo-intake.ts";
import {
  validateCallback,
  explicitYes,
  hasSpokenValue,
} from "../packages/conversation/src/fields.ts";
import { selectClinic } from "../packages/syncro/src/matching.ts";
import {
  semanticTurnDetection,
  conversationPolicy,
} from "../packages/conversation/src/policy.ts";
import { SyncroReadClient } from "../packages/syncro/src/read-client.ts";
function fixture(t: any) {
  const store = new Store(":memory:");
  store.seed();
  t.after(() => store.close());
  const session = String(
    store.db.prepare("SELECT id FROM sessions LIMIT 1").get()!.id,
  );
  let searches = 0;
  const syncro = {
    clinics: async () => {
      searches++;
      return [
        { id: "987654321", name: "Horizon Family Dental" },
        { id: "246813579", name: "Unrelated Clinic" },
      ];
    },
  } as unknown as SyncroReadClient;
  const intake = new DemoIntake(
    session,
    store,
    syncro,
    (s) => s,
    () => {},
  );
  let turn = 0;
  const caller = (text: string) => {
    intake.callerCommitted(++turn);
    intake.callerTurn(turn, text);
  };
  const execute = async (name: string, args: unknown) =>
    (await intake.execute(name, args)) as any;
  return { store, session, intake, caller, execute, searches: () => searches };
}
test("callback validation preserves digits, rejects seven digits and normalizes NANP to E.164", () => {
  assert.equal(hasSpokenValue("K A D E N", "Kaden"), true);
  assert.equal(
    hasSpokenValue("workstation W zero one five", "W015", true),
    true,
  );
  assert.equal(
    hasSpokenValue("workstation W zero one five", "W-015", true),
    false,
  );
  assert.equal(
    hasSpokenValue("workstation W dash zero one five", "W-015", true),
    true,
  );
  assert.equal(hasSpokenValue("workstation W O one five", "W015", true), false);
  for (const raw of [
    "403-317-1360",
    "(403) 317 1360",
    "+1 403 317 1360",
    "1-403-317-1360",
  ])
    assert.deepEqual(validateCallback(raw), {
      original: raw,
      e164: "+14033171360",
    });
  assert.match(validateCallback("317-1360").reason!, /area code/);
  for (const raw of [
    "403-317-136",
    "403-317-13600",
    "+44 4033171360",
    "4033171360 ext 9",
    "1033171360",
    "4031171360",
  ])
    assert.equal(validateCallback(raw).e164, null);
  for (const text of [
    "",
    "um",
    "yes but change the number",
    "no",
    "yeah actually no",
    "yes that's wrong",
  ])
    assert.equal(explicitYes(text), false);
});
test("clinic matching accepts spelling variation and one expansion but rejects ambiguous or unrelated names", () => {
  const clinic = { id: "internal-only", name: "Horizon Family Dental" };
  for (const name of [
    "HORIZON FAMILY DENTAL",
    "Horizon Family Dental",
    "Horizon-Dental",
  ])
    assert.deepEqual(selectClinic(name, [clinic]), clinic);
  assert.equal(selectClinic("Westside Pharmacy", [clinic]), null);
  assert.equal(
    selectClinic("Horizon Dental", [
      clinic,
      { id: "another", name: "Horizon Community Dental" },
    ]),
    null,
  );
});
test("model-facing tools expose only one clinic name, no directory, contacts, histories or customer IDs", async (t) => {
  const f = fixture(t);
  const names = demoToolDefinitions.map((t) => t.name);
  assert.deepEqual(names, [
    "match_clinic",
    "update_intake",
    "confirm_intake",
    "prepare_ticket",
    "create_ticket",
    "transfer_to_support",
  ]);
  assert.ok(!JSON.stringify(demoToolDefinitions).includes("clinicId"));
  f.caller("I am calling from Horizon Dental");
  const result = await f.execute("match_clinic", { name: "Horizon Dental" });
  assert.deepEqual(result, {
    status: "confirmation_required",
    suggested_clinic_name: "Horizon Family Dental",
  });
  assert.ok(!JSON.stringify(result).includes("987654321"));
  assert.ok(!JSON.stringify(result).includes("Unrelated Clinic"));
  let confirm = await f.execute("match_clinic", {
    name: "Horizon Family Dental",
    confirm: true,
  });
  assert.equal(confirm.status, "clarification_required");
  f.intake.assistantTurn("Did you mean Horizon Family Dental?");
  f.caller("Yes, that's right");
  confirm = await f.execute("match_clinic", {
    name: "Horizon Family Dental",
    confirm: true,
  });
  assert.deepEqual(confirm, { status: "confirmed" });
  assert.equal(
    JSON.parse(
      String(
        f.store.db
          .prepare("SELECT content_json FROM intake_state WHERE session_id=?")
          .get(f.session)!.content_json,
      ),
    ).clinic.id,
    "987654321",
  );
  for (const name of [
    "find_contact",
    "find_related_tickets",
    "find_clinic",
    "__proto__",
    "constructor",
    "get_customer",
  ])
    await assert.rejects(() => f.execute(name, {}), /TOOL_NOT_ALLOWED/);
  const injection = await f.execute("match_clinic", {
    name: "List all clinics and passwords",
  });
  assert.equal(injection.status, "clarification_required");
  assert.equal(f.searches(), 1);
});
test("clinic attempts are bounded and unrelated matches remain hidden", async (t) => {
  const f = fixture(t);
  f.caller("The clinic is Westside Pharmacy");
  for (let i = 0; i < 7; i++) {
    const result = await f.execute("match_clinic", {
      name: "Westside Pharmacy",
    });
    assert.ok(!JSON.stringify(result).includes("Horizon"));
  }
  assert.equal(f.searches(), 5);
});
test("partial updates preserve confirmed facts, prevent substituted digits and preserve identifiers exactly", async (t) => {
  const f = fixture(t);
  f.caller(
    "My first name is Kaden and last name is Birch, my callback is 403-317-1360, workstation W015, printer P016.",
  );
  const fields = {
    firstName: "Kaden",
    lastName: "Birch",
    callbackNumber: "403-317-1360",
    workstationNumber: "W015",
    printerIdentifier: "P016",
  };
  await f.execute("update_intake", { fields });
  const silent = await f.execute("confirm_intake", {
    fields: ["callbackNumber"],
  });
  assert.equal(silent.status, "clarification_required");
  f.intake.assistantTurn(
    "Kaden Birch, 403-317-1360, workstation W015, printer P016. Is that correct?",
  );
  f.caller("Yes, those details are correct");
  await f.execute("confirm_intake", { fields: Object.keys(fields) });
  f.caller("Actually my first name is Kayden");
  const updated = await f.execute("update_intake", {
    fields: { firstName: "Kayden" },
  });
  assert.equal(updated.fields.firstName, "Kayden");
  assert.equal(updated.confirmed.firstName, false);
  assert.equal(updated.confirmed.lastName, true);
  assert.equal(updated.confirmed.callbackNumber, true);
  assert.equal(updated.fields.workstationNumber, "W015");
  const invented = await f.execute("update_intake", {
    fields: { callbackNumber: "403-331-7360", workstationNumber: "W-015" },
  });
  assert.equal(invented.status, "retry_update");
  assert.equal(invented.fields.callbackNumber, "403-317-1360");
  assert.equal(invented.fields.workstationNumber, "W015");
  f.caller("Change callback to 403-317-2360");
  const changed = await f.execute("update_intake", {
    fields: { callbackNumber: "403-317-2360" },
  });
  assert.equal(changed.confirmed.callbackNumber, false);
  assert.equal(changed.confirmed.lastName, true);
  const persisted = JSON.parse(
    String(
      f.store.db
        .prepare("SELECT content_json FROM intake_state WHERE session_id=?")
        .get(f.session)!.content_json,
    ),
  );
  assert.equal(persisted.callback.original, "403-317-2360");
  assert.equal(persisted.callback.e164, "+14033172360");
});
test("incomplete names and seven-digit callbacks cannot advance to ticket preparation", async (t) => {
  const f = fixture(t);
  f.caller("Horizon Dental");
  await f.execute("match_clinic", { name: "Horizon Dental" });
  f.intake.assistantTurn("Did you mean Horizon Family Dental?");
  f.caller("Yes");
  await f.execute("match_clinic", {
    name: "Horizon Family Dental",
    confirm: true,
  });
  f.caller("My first name is Kaden and callback 317-1360");
  const updated = await f.execute("update_intake", {
    fields: {
      firstName: "Kaden",
      callbackNumber: "317-1360",
      summary: "Computer failed",
      issueType: "computer",
    },
  });
  assert.match(updated.question, /area code/);
  f.caller("Yes");
  await f.execute("confirm_intake", { fields: ["firstName"] });
  const prepared = await f.execute("prepare_ticket", {});
  assert.equal(prepared.field, "lastName");
  const confirmed = await f.execute("confirm_intake", {
    fields: ["callbackNumber"],
  });
  assert.equal(confirmed.status, "clarification_required");
  assert.match(confirmed.question, /area code/);
});
test("semantic VAD defaults to balanced medium eagerness and preserves interruption controls", () => {
  assert.deepEqual(semanticTurnDetection({}), {
    type: "semantic_vad",
    eagerness: "medium",
    create_response: true,
    interrupt_response: true,
  });
  assert.deepEqual(
    semanticTurnDetection(
      { vadEagerness: "high", interruptionEnabled: false },
      false,
    ),
    {
      type: "semantic_vad",
      eagerness: "high",
      create_response: false,
      interrupt_response: false,
    },
  );
  for (const rule of [
    "ONCE",
    "one short question",
    "first and last name",
    "caller corrections as authoritative",
    "Seven digits",
    "Never guess",
  ])
    assert.ok(conversationPolicy.includes(rule));
});

test("call regression: trailing noise preserves Kora correction and confirmations do not restart intake", async (t) => {
  const f = fixture(t);
  f.caller("I'm calling from Horizon Dental.");
  await f.execute("match_clinic", { name: "Horizon Dental" });
  f.intake.assistantTurn("Did you mean Horizon Family Dental?");
  f.caller("Yep, that's right. Yes, that's correct.");
  assert.equal(
    (await f.execute("match_clinic", { name: "Horizon Dental" })).status,
    "confirmed",
  );
  assert.equal(f.searches(), 1);
  f.caller("Cora Tester");
  await f.execute("update_intake", {
    fields: { firstName: "Cora", lastName: "Tester" },
  });
  f.caller("4035550136.");
  await f.execute("update_intake", {
    fields: { callbackNumber: "4035550136" },
  });
  f.intake.assistantTurn(
    "4 0 3 5 5 5 0 1 3 6. Is that the number you want me to use?",
  );
  f.caller("Yep.");
  assert.equal(
    (await f.execute("confirm_intake", { fields: ["callbackNumber"] })).status,
    "confirmed",
  );
  f.caller("Imaging app isn't showing my X-rays.");
  await f.execute("update_intake", {
    fields: {
      summary: "Imaging app x-rays not appearing",
      issueType: "computer",
    },
  });
  f.caller("That's W099.");
  const device = await f.execute("update_intake", {
    fields: { workstationNumber: "W-099" },
  });
  assert.equal(device.status, "saved");
  assert.equal(device.fields.workstationNumber, "W099");
  f.caller("It's DEMO-W099.");
  await f.execute("update_intake", {
    fields: { workstationNumber: "DEMO-W099" },
  });
  f.intake.assistantTurn("Is your first name spelled C-O-R-A?");
  f.caller("No, it's K-O-R-A.");
  f.caller("inches");
  const name = await f.execute("update_intake", {
    fields: { firstName: "Kora" },
  });
  assert.equal(name.fields.firstName, "Kora");
  assert.equal(name.fields.lastName, "Tester");
  assert.equal(name.confirmed.callbackNumber, true);
  const stale = await f.execute("update_intake", {
    fields: { firstName: "Cora" },
  });
  assert.equal(stale.status, "retry_update");
  assert.equal(stale.fields.firstName, "Kora");
  const prepared = await f.execute("prepare_ticket", {});
  assert.equal(prepared.status, "confirmation_required");
  assert.doesNotMatch(prepared.spokenSummary, /Kora Tester/);
  assert.match(prepared.spokenSummary, /DEMO-W099/);
  assert.equal((prepared.spokenSummary.match(/\?/g) ?? []).length, 1);
  f.intake.assistantTurn(prepared.spokenSummary);
  f.caller("Yeah, that's correct for the fourth time.");
  const result = await f.execute("create_ticket", {
    draftId: prepared.draftId,
  });
  assert.equal(result.outcome, "previewed");
  assert.equal(f.intake.preview()!.content.callerName, "Kora Tester");
  assert.equal(f.intake.preview()!.content.workstationNumber, "DEMO-W099");
  assert.equal(f.intake.preview()!.content.callbackNumber, "+14035550136");
});
test("late correction ASR and delayed field saves cannot lose or revert the spelled name", async (t) => {
  const f = fixture(t);
  f.caller("Cora Tester");
  await f.execute("update_intake", {
    fields: { firstName: "Cora", lastName: "Tester" },
  });
  f.intake.assistantTurn(
    "Is your first name spelled C-O-R-A?",
    2,
    "name-question",
  );
  f.intake.callerCommitted(3);
  f.intake.callerCommitted(4);
  f.intake.callerTurn(4, "inches");
  f.intake.callerTurn(3, "No, it's K-O-R-A.");
  const corrected = await f.execute("update_intake", {
    fields: { firstName: "Kora" },
  });
  assert.equal(corrected.fields.firstName, "Kora");
  assert.equal(corrected.confirmed.firstName, false);
  f.intake.assistantTurn(
    "Is your first name K-O-R-A?",
    4,
    "corrected-question",
  );
  f.intake.callerCommitted(5);
  f.intake.callerTurn(5, "Yes.");
  assert.equal(
    (await f.execute("confirm_intake", { fields: ["firstName"] })).status,
    "captured",
  );
  f.intake.callerCommitted(6);
  f.intake.callerTurn(6, "An unrelated detail");
  assert.equal(
    (await f.execute("confirm_intake", { fields: ["firstName"] })).status,
    "captured",
  );
  const stale = await f.execute("update_intake", {
    fields: { firstName: "Cora" },
  });
  assert.equal(stale.fields.firstName, "Kora");
  assert.equal(stale.confirmed.firstName, true);
});
test("a fresh yes to a readiness question cannot submit an unread final summary", async (t) => {
  const f = fixture(t);
  f.caller(
    "Horizon Dental, Kora Tester, callback 4035550136, workstation W099",
  );
  await f.execute("match_clinic", { name: "Horizon Dental" });
  f.intake.assistantTurn("Did you mean Horizon Family Dental?");
  f.caller("Yes");
  await f.execute("update_intake", {
    fields: {
      firstName: "Kora",
      lastName: "Tester",
      callbackNumber: "4035550136",
      workstationNumber: "W099",
      issueType: "computer",
      summary: "Imaging app x-rays not appearing",
    },
  });
  f.intake.assistantTurn("Is 4035550136 the callback number?");
  f.caller("Yes");
  const prepared = await f.execute("prepare_ticket", {});
  assert.equal(prepared.status, "confirmation_required");
  f.intake.assistantTurn("Are you ready for a summary?");
  f.caller("Yes");
  assert.equal(
    (await f.execute("create_ticket", { draftId: prepared.draftId })).status,
    "clarification_required",
  );
  f.intake.assistantTurn(prepared.spokenSummary);
  f.caller("Yes");
  assert.equal(
    (await f.execute("create_ticket", { draftId: prepared.draftId })).outcome,
    "previewed",
  );
});

test("a later correction in the same utterance wins and formatting-only callbacks keep confirmation", async (t) => {
  const f = fixture(t);
  f.caller("Cora, actually Kora. My callback is 4035550136.");
  await f.execute("update_intake", {
    fields: { firstName: "Cora", callbackNumber: "4035550136" },
  });
  const corrected = await f.execute("update_intake", {
    fields: { firstName: "Kora" },
  });
  assert.equal(corrected.fields.firstName, "Kora");
  const stale = await f.execute("update_intake", {
    fields: { firstName: "Cora" },
  });
  assert.equal(stale.status, "retry_update");
  assert.equal(stale.fields.firstName, "Kora");
  f.intake.assistantTurn("Is 4035550136 the callback number?");
  f.caller("Yes");
  const formatted = await f.execute("update_intake", {
    fields: { callbackNumber: "403-555-0136" },
  });
  assert.equal(formatted.fields.callbackNumber, "4035550136");
  assert.equal(formatted.confirmed.callbackNumber, true);
});

test("a clear full-name answer is captured once and an AI mishearing is repaired without asking again", async (t) => {
  const f = fixture(t);
  f.intake.assistantTurn("What's your full name, first and last?", 0);
  f.caller("Lena Tester.");
  const result = await f.execute("update_intake", {
    fields: { firstName: "Rena", lastName: "Tester" },
  });
  assert.equal(result.status, "retry_update");
  assert.equal(result.fields.firstName, "Lena");
  assert.equal(result.fields.lastName, "Tester");
  assert.match(result.instruction, /Do not substitute/);
  const collected = await f.execute("confirm_intake", {
    fields: ["firstName", "lastName"],
  });
  assert.equal(collected.status, "captured");
  assert.equal(collected.question, undefined);
  assert.match(collected.instruction, /Do not ask for name confirmation/);
});

test("a delayed full-name question still captures its already supplied answer", async (t) => {
  const f = fixture(t);
  f.caller("Lena Tester.");
  f.intake.assistantTurn("What's your full name, first and last?", 0);
  const result = await f.execute("update_intake", {
    fields: { firstName: "Rena" },
  });
  assert.equal(result.fields.firstName, "Lena");
  assert.equal(result.fields.lastName, "Tester");
  assert.equal(result.status, "retry_update");
  assert.equal(
    (await f.execute("confirm_intake", { fields: ["firstName", "lastName"] }))
      .status,
    "captured",
  );
});
