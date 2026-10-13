import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  redact,
  validateKey,
} from "../packages/security/src/index.ts";
import {
  connectionSchema,
  defaultAgent,
  agentSchema,
} from "../packages/shared/src/config.ts";
test("authenticated encryption uses a new nonce, binds provider and rejects tampering", () => {
  const key = randomBytes(32),
    secret = "provider-secret";
  const a = encrypt(secret, key, "pbx"),
    b = encrypt(secret, key, "pbx");
  assert.notEqual(a, b);
  assert.ok(!a.includes(secret));
  assert.equal(decrypt(a, key, "pbx"), secret);
  assert.throws(() => decrypt(a, key, "syncro"));
  const payload = JSON.parse(a);
  payload.data = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(JSON.stringify(payload), key, "pbx"));
  assert.throws(() => validateKey("short"));
});
test("redacts configured secrets and obvious volunteered credentials before storage", () => {
  const result = redact(
    "password is hunter123. MFA code: 123456. API sk-synthetic_longkey123. patient name is Demo Person. tenant-token",
    ["tenant-token"],
  );
  for (const v of [
    "hunter123",
    "123456",
    "sk-synthetic_longkey123",
    "Demo Person",
    "tenant-token",
  ])
    assert.ok(!result.includes(v));
});
test("Ryan defaults require confirmation and reject unsafe credential destinations", () => {
  assert.equal(defaultAgent.name, "Ryan");
  assert.match(defaultAgent.greeting, /I'm Ryan/);
  assert.throws(() =>
    agentSchema.parse({ ...defaultAgent, requireConfirmation: false }),
  );
  for (const pbxBase of [
    "http://localhost",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?key=secret",
  ])
    assert.throws(() =>
      connectionSchema.parse({
        provider: "pbx",
        pbxBase,
        appId: "ai",
        targetVersion: "20 Update 10",
        supportExtension: "",
      }),
    );
  assert.throws(() =>
    connectionSchema.parse({ provider: "syncro", tenant: "evil.example.com" }),
  );
});
