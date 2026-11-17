import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setup } from "../helpers.js";
import { Store } from "../../packages/persistence/src/database.js";
import {
  createBackup,
  restoreBackup,
} from "../../packages/persistence/src/backup.js";
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
test("schema 1 upgrade creates notices atomically and preserves jobs with a backup", async () => {
  const h = await setup();
  let upgraded: Store | undefined;
  try {
    h.store.close();
    const file = join(h.directory, "database", "app.sqlite");
    const old = new DatabaseSync(file);
    old.exec(
      "DROP TABLE notices; PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE)",
    );
    old.close();
    const before = hash(file);
    upgraded = new Store(file);
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      2,
    );
    assert.equal(upgraded.all("jobs").length, 4);
    assert.equal(upgraded.all("notices").length, 0);
    assert.ok(
      readdirSync(join(h.directory, "backups"))
        .filter((n) => n.startsWith("pre-migration-"))
        .some((n) => hash(join(h.directory, "backups", n)) === before),
    );
  } finally {
    upgraded?.close();
    await h.cleanup();
  }
});
test("legacy backup restores at schema 2 without mutating the source snapshot", async () => {
  const h = await setup();
  try {
    const backup = await createBackup(h.service),
      source = join(h.directory, "backups", backup.id),
      file = join(source, "app.sqlite");
    const old = new DatabaseSync(file);
    old.exec(
      "DROP TABLE notices; PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE)",
    );
    old.close();
    const manifestFile = join(source, "manifest.json"),
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.schema_version = 1;
    manifest.database_hash = hash(file);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const before = hash(file);
    restoreBackup(source, join(h.directory, "restored"));
    assert.equal(hash(file), before);
    const restored = new Store(
      join(h.directory, "restored", "database", "app.sqlite"),
    );
    try {
      assert.equal(
        restored.db.prepare("PRAGMA user_version").get()?.user_version,
        2,
      );
      assert.equal(restored.all("jobs").length, 4);
    } finally {
      restored.close();
    }
  } finally {
    await h.cleanup();
  }
});
