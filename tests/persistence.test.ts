import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/src/store.ts";
test("migrations and history survive restart and demo seeding never duplicates calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "chinookit-db-"));
  try {
    let s = new Store(join(dir, "test.sqlite"));
    s.seed();
    const id = s.db.prepare("SELECT id FROM sessions LIMIT 1").get()!.id;
    s.setting("persistent-test", { enabled: true });
    s.close();
    s = new Store(join(dir, "test.sqlite"));
    s.seed();
    assert.equal(s.db.prepare("SELECT count(*) n FROM sessions").get()!.n, 75);
    assert.equal(
      s.db.prepare("SELECT id FROM sessions WHERE id=?").get(String(id))!.id,
      id,
    );
    assert.deepEqual(s.setting("persistent-test"), { enabled: true });
    assert.equal(s.db.prepare("SELECT count(*) n FROM migrations").get()!.n, 2);
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM turns_fts").get()!.n,
      375,
    );
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
