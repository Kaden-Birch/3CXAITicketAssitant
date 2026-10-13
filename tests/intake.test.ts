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
  assert.equal(invented.status, "clarification_required");
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
test("semantic VAD defaults to patient low eagerness and preserves interruption controls", () => {
  assert.deepEqual(semanticTurnDetection({}), {
    type: "semantic_vad",
    eagerness: "low",
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
    "exactly once",
    "ONE short question",
    "first name and last name",
    "Caller corrections are authoritative",
    "Seven digits",
    "Never guess",
  ])
    assert.ok(conversationPolicy.includes(rule));
});
