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
  const desktopPolicy = join(store.home, "desktop-cache-policy", "policy");
  assert.equal(readFileSync(desktopPolicy, "utf8"), "on");
  assert.equal((await change({ desktopCache: "false" })).status, 400);
  for (const enabled of [false, true]) {
    assert.equal((await change({ desktopCache: enabled })).data.settings.desktopCache, enabled);
    assert.equal(readFileSync(desktopPolicy, "utf8"), enabled ? "on" : "off");
  }
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

test("turn retention follows the storage policy and 0 keeps every turn", async t => {
  const f = await knowledgeWorld({ timezone: "UTC" }); t.after(f.close);
  const { store } = f.app;
  const change = body => f.request(f.admin, "/api/storage", { method: "PUT", body });
  assert.equal((await f.request(f.admin, "/api/storage")).data.settings.turns, 300);
  for (const turns of [-1, 49, 100001, 2.5, "0", null]) assert.equal((await change({ turns })).status, 400);
  const agentId = "ag_keep";
  const add = (count, from) => {
    for (let i = 0; i < count; i++) {
      store.saveTrace({ id: `tr_keep${from + i}`, agentId, kind: "chat", startedAt: new Date(Date.UTC(2026, 10, 1) + (from + i) * 1000).toISOString(), endedAt: null, status: "running", steps: [], tools: [] });
    }
  };
  const count = () => store.stmt("SELECT COUNT(*) AS n FROM traces WHERE agent_id = ?").get(agentId).n;
  const before = count();
  add(120, 0);
  assert.equal((await change({ turns: 0 })).data.settings.turns, 0);
  store.pruneTraces(agentId);
  assert.equal(count(), before + 120);
  assert.equal((await change({ turns: 50 })).data.settings.turns, 50);
  store.pruneTraces(agentId);
  assert.equal(count(), 50);
  assert.equal(store.stmt("SELECT MIN(started_at) AS at FROM traces WHERE agent_id = ?").get(agentId).at, new Date(Date.UTC(2026, 10, 1) + 70000).toISOString());
});
