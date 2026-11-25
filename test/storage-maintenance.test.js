import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { rotateBackups, retainedArtifactTrees } from "../src/storage-backups.js";

test("owner storage API, native scheduler, restart slots and fail-closed backup rotation", async t => {
  const f = await knowledgeWorld({ timezone: "UTC" }); t.after(f.close);
  const { store, scheduler } = f.app;
  const storage = scheduler.storage;
  await storage.pending;
  for (const [path, method] of [["/api/storage", "GET"], ["/api/storage/sample?hour=2026-11-25T13", "GET"], ["/api/storage", "PUT"], ["/api/storage/run", "POST"]]) {
    assert.equal((await f.request(f.alice, path, { method })).status, 403);
  }
  const change = body => f.request(f.admin, "/api/storage", { method: "PUT", body });
  for (const body of [{ keep: 0 }, { keep: 2.5 }, { time: "24:11" }, { automatic: "yes" }, { path: "/" }]) {
    assert.equal((await change(body)).status, 400);
  }
  assert.equal((await change({ keep: 2, time: "13:10", automatic: true, monitor: false })).data.settings.keep, 2);
  const folder = join(store.home, "backups");
  mkdirSync(folder, { recursive: true });
  const sample = { pages: [], revisions: [], notes: [], state: [] };
  const days = ["2026-11-18", "2026-11-21", "2026-11-25"];
  for (const day of days) {
    await scheduler.backup(day);
    const data = day === days[0] ? sample : { owners: [{ id: "alice", data: sample }] };
    writeFileSync(join(folder, `brain-${day}.json`), JSON.stringify({ ...data, at: day + "T03:00:00Z" }));
  }
  const release = join(folder, "release-2026-11-18.db");
  writeFileSync(release, "release backup");
  const originals = readdirSync(folder).sort();
  const opts = { folder, day: days[2], keep: 2, timezone: "UTC", brain: true, preview: true };
  assert.equal(rotateBackups(opts).expired, 2);
  assert.deepEqual(readdirSync(folder).sort(), originals);
  const newest = join(folder, "brain-" + days[2] + ".json");
  const bytes = readFileSync(newest);
  renameSync(newest, newest + ".saved");
  const apply = () => rotateBackups({ ...opts, preview: false });
  assert.throws(apply, /missing/);
  symlinkSync(release, newest);
  assert.throws(apply, /Invalid nightly backup/);
  renameSync(newest + ".saved", newest);
  writeFileSync(newest, "{}");
  assert.throws(apply);
  assert.deepEqual(readdirSync(folder).sort(), originals);
  writeFileSync(newest, bytes);
  const db = join(folder, "cora-" + days[2] + ".db");
  copyFileSync(db, db + ".saved");
  writeFileSync(db, "broken database");
  assert.throws(apply);
  assert.ok(existsSync(join(folder, "cora-" + days[0] + ".db")));
  renameSync(db + ".saved", db);
  assert.ok(retainedArtifactTrees(folder) instanceof Set);
  scheduler.tick(new Date("2026-11-25T13:09Z"));
  assert.equal(storage.running, null);
  scheduler.tick(new Date("2026-11-25T13:10Z"));
  assert.equal(storage.running.action, "backups");
  assert.equal((await f.request(f.admin, "/api/storage/run", { method: "POST", body: { action: "grok", preview: true } })).status, 409);
  await storage.pending;
  assert.equal(storage.status().last.backups.result.expired, 2);
  assert.deepEqual(readdirSync(folder).sort(), originals.filter(name => !name.includes(days[0]) || name.startsWith("release")));
  scheduler.tick(new Date("2026-11-25T13:11Z"));
  assert.equal(storage.running, null);
  assert.equal(store.value("storageSlots").daily, days[2]);
  await change({ automatic: false, monitor: true });
  scheduler.tick(new Date("2026-11-26T13:10Z"));
  assert.equal(storage.running, null);
  const response = await f.request(f.admin, "/api/storage/run", { method: "POST", body: { action: "grok", preview: true } });
  assert.equal(response.status, 202);
  await storage.pending;
  assert.equal(storage.status().last.grok.result.copies, 0);
  assert.equal((await f.request(f.admin, "/api/storage/run", { method: "POST", body: { action: "unsafe", preview: true } })).status, 400);
  await change({ sampleDays: 1 });
  const measurement = { available: 100, scopes: {}, unavailable: [] };
  for (const hour of ["2026-11-24T10", "2026-11-25T09", "2026-11-25T10"]) {
    storage.recordSample(new Date(hour + ":00Z"), measurement, 1);
  }
  assert.deepEqual(storage.status().hours, ["2026-11-25T09", "2026-11-25T10"]);
  assert.deepEqual((await f.request(f.admin, "/api/storage/sample?hour=2026-11-25T09")).data, measurement);
  assert.equal((await f.request(f.admin, "/api/storage/sample?hour=2026-11-24T10")).status, 404);
});
