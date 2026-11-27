import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { estimateCapacity, MachineCapacity, recordCapacity } from "../src/machine-capacity.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

const GiB = 2 ** 30;
const HOUR = 3600000;
const sample = { machine: "vm", active: 2, working: 2, cores: 8, load: 2, cpu: 0.5,
  ram: GiB, ramTotal: 64 * GiB, ramFree: 48 * GiB, diskFree: 160 * GiB, diskTotal: 400 * GiB };

test("capacity takes the tightest unrounded resource after reserves, including zero headroom", () => {
  const estimate = patch => estimateCapacity({ ...sample, ...patch }, [], 20 * GiB);
  assert.equal(estimate({}).limit, "disk");
  assert.equal(estimate({}).additional, 5);
  assert.equal(estimate({ ramFree: 8 * GiB }).limit, "ram");
  assert.equal(estimate({ ramFree: 8 * GiB }).additional, 1);
  assert.equal(estimate({ load: 6 }).limit, "cpu");
  assert.equal(estimate({ load: 6 }).additional, 1);
  assert.equal(estimate({ diskFree: 0 }).additional, 0);
  assert.equal(estimate({ load: 10 }).additional, 0);
});

test("recent concurrent work shapes the estimate and only distinct hours count", () => {
  let rows = [];
  const at = 1000 * HOUR;
  for (let i = 0; i < 30; i++) rows = recordCapacity(rows, at + i * HOUR, { ...sample, working: 0 });
  assert.ok(estimateCapacity(sample, rows, null).preliminary);
  for (const hour of [30, 31, 32, 33, 34, 54]) {
    rows = recordCapacity(rows, at + hour * HOUR, { ...sample, cpu: 2, load: 6 });
    rows = recordCapacity(rows, at + hour * HOUR + 60000, sample);
  }
  assert.equal(rows.length, 36);
  const result = estimateCapacity(sample, rows, null);
  assert.equal(result.preliminary, false);
  assert.equal(result.diskDefault, true);
  assert.equal(result.additional, 0);
  assert.equal(result.limit, "cpu");
  assert.equal(recordCapacity(rows, at + 222 * HOUR, sample).length, 1);
  assert.equal(recordCapacity(rows, at + 55 * HOUR, { ...sample, machine: "replacement" }).length, 1);
});

test("owner state serves a Docker measurement, preserves history, and recovers from an incomplete sample", async t => {
  const f = await knowledgeWorld();
  t.after(f.close);
  const { store, boxes } = f.app;
  const storage = f.app.scheduler.storage;
  await storage.capacity.pending;
  const name = boxes.name(store.createAgent({ name: "Capacity", enabled: false }).id);
  const docker = join(store.home, "test-capacity-docker");
  const daemon = ["vm", "remote", "kernel", "/volumes", sample.cores].map(v => JSON.stringify(v)).join("\t");
  const writeDocker = stats => writeFileSync(docker, [
    "#!/bin/sh", 'case "$1" in',
    "info) echo '" + daemon + "';;", "ps) echo '" + name + "';;",
    "exec) echo '" + JSON.stringify(sample) + "';;", "stats) echo '" + stats + "';;", "esac",
  ].join("\n"), { mode: 0o700 });
  const valid = name + "\t50%\t1GiB / 2GiB";
  writeDocker(valid);
  const at = Date.now() - 60000;
  store.setValue("storageLast", { monitor: { at: new Date(at).toISOString(), result: { scopes: {
    [name]: { bytes: { work: 4 * GiB }, unreadable_count: 0 },
  } } } });
  storage.capacity = new MachineCapacity({ store, boxes, docker });
  const capacity = storage.capacity;
  const tick = async time => { capacity.next = 0; capacity.tick(time); await capacity.pending; };
  await tick(at);
  const owner = await f.request(f.admin, "/api/state");
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.data.machineCapacity, { active: 1, additional: 9, limit: "cpu", preliminary: true, diskDefault: false, at });
  assert.equal((await f.request(f.alice, "/api/state")).data.machineCapacity, undefined);
  assert.equal(store.value("machineCapacityHistory").length, 1);
  writeDocker("");
  await tick(at + 1);
  assert.deepEqual(capacity.status(), { active: 1, preliminary: true, at: at + 1 });
  assert.equal(store.value("machineCapacityHistory").length, 1);
  writeDocker(valid);
  await tick(at + 2);
  assert.equal(capacity.status().additional, 9);
  assert.deepEqual(capacity.status(at + HOUR), { preliminary: true });
});
