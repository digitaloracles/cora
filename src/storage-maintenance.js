import { MachineCapacity } from "./machine-capacity.js";
import { DesktopCache } from "./desktop-cache.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TRACES_KEPT_PER_AGENT } from "./store.js";

const exec = promisify(execFile);
const script = name => fileURLToPath(new URL(name, import.meta.url));
const defaults = { automatic: true, desktopCache: true, time: "05:20", backups: true, keep: 7, grok: false, monitor: false, sampleDays: 31, turns: TRACES_KEPT_PER_AGENT };
const actions = ["backups", "grok", "monitor"];

function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }

async function jsonCommand(binary, args, timeout = 900000) {
  try {
    const { stdout } = await exec(binary, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // execFile's default message contains the command and can include the scanner source.
    const detail = error.stderr?.trim().split("\n").at(-1) || error.code || "invalid output";
    throw new Error(String(detail).slice(0, 220));
  }
}

function clock(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export class StorageMaintenance {
  constructor({ store, home, timezone, docker, boxes, brainEnabled, log }) {
    Object.assign(this, { store, home, timezone, docker, boxes, brainEnabled, log });
    this.capacity = new MachineCapacity({ store, docker, boxes });
    this.desktopCache = new DesktopCache({ store, boxes, docker, log });
    this.running = null;
  }

  settings() {
    const hour = String(this.store.settings.librarianHour).padStart(2, "0");
    return { ...defaults, time: `${hour}:20`, ...this.store.value("storagePolicy", {}) };
  }
  status() {
    return { settings: this.settings(), timezone: this.timezone, running: this.running, last: this.store.value("storageLast", {}), hours: this.store.value("storageHours", []) };
  }

  sample(hour) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) throw invalid("Invalid measurement hour");
    const sample = this.store.value("storageSample:" + hour);
    if (!sample) throw invalid("Measurement unavailable", 404);
    return sample;
  }

  update(patch) {
    if (!patch || Array.isArray(patch) || typeof patch !== "object" || !Object.keys(patch).length) throw invalid("Invalid storage settings");
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(defaults, key)) throw invalid("Unknown storage setting");
      if (key === "time") {
        if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid("Invalid cleanup time");
      } else if (key === "sampleDays") {
        if (!Number.isInteger(value) || value < 1 || value > 90) throw invalid("Keep between 1 and 90 days of measurements");
      } else if (key === "turns") {
        if (!Number.isInteger(value) || (value !== 0 && (value < 50 || value > 100000))) throw invalid("Keep every turn (0) or between 50 and 100000 turns per agent");
      } else if (key === "keep") {
        if (!Number.isInteger(value) || value < 1 || value > 90) throw invalid("Keep between 1 and 90 backups");
      } else if (typeof value !== "boolean") throw invalid("Expected a switch");
    }
    this.store.setValue("storagePolicy", { ...this.settings(), ...patch });
    if (Object.hasOwn(patch, "desktopCache")) this.desktopCache.writePolicy();
    return this.status();
  }

  tick(now) {
    this.capacity.tick(now.getTime());
    this.desktopCache.tick(now.getTime());
    if (this.running) return;
    const policy = this.settings();
    if (!policy.automatic) return;
    const { day, time } = clock(now, this.timezone);
    const slots = this.store.value("storageSlots", {});
    const due = [];
    // Before the owner configures a policy, retain the original nightly backup behavior.
    const ready = this.store.value("storagePolicy") || existsSync(join(this.home, "backups", `cora-${day}.db`));
    if (ready && time >= policy.time && slots.daily !== day && (policy.backups || policy.grok)) {
      slots.daily = day;
      due.push(...["backups", "grok"].filter(key => policy[key]));
    }
    const hour = day + " " + time.slice(0, 2);
    if (policy.monitor && time.slice(3) >= policy.time.slice(3) && slots.hourly !== hour) {
      slots.hourly = hour;
      due.push("monitor");
    }
    if (due.length) {
      this.store.setValue("storageSlots", slots);
      this.start(due, false, now);
    }
  }

  request(action, preview) {
    if (!actions.includes(action) || typeof preview !== "boolean") throw invalid("Invalid maintenance request");
    this.start([action], preview, new Date());
    return this.status();
  }

  start(jobs, preview, now) {
    if (this.running) throw invalid("A storage operation is already running", 409);
    const settings = this.settings();
    this.running = { action: jobs[0], preview, at: now.toISOString() };
    this.pending = this.execute(jobs, preview, now, settings).finally(() => { this.running = null; });
  }

  async execute(jobs, preview, now, settings) {
    for (const action of jobs) {
      this.running.action = action;
      const report = { at: now.toISOString(), preview };
      try {
        if (action === "backups") {
          const { day, time } = clock(now, this.timezone);
          const beforeNightly = Number(time.slice(0, 2)) < this.store.settings.librarianHour;
          const expectedDay = beforeNightly ? new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10) : day;
          report.result = await jsonCommand(process.execPath, ["--disable-warning=ExperimentalWarning", script("./storage-backup-worker.js"), JSON.stringify({
            folder: join(this.home, "backups"), day: expectedDay, timezone: this.timezone,
            keep: settings.keep, brain: this.brainEnabled(), preview
          })]);
        } else if (action === "grok") {
          report.result = await jsonCommand("python3", ["-I", script("./storage-grok.py"), join(this.home, "cli-work"), preview ? "preview" : "apply", join(this.home, "storage-grok.json")]);
        } else {
          report.result = await this.measure();
          const previous = this.store.value("storageLast", {}).monitor?.result;
          const warning = report.result.warning;
          if (warning && warning !== previous?.warning) this.log({ type: "warning", text: "Spazio disco: " + warning });
          if (!warning && previous?.warning) this.log({ type: "storage", text: "Spazio disco e monitoraggio rientrati nella norma." });
          this.recordSample(now, report.result, settings.sampleDays);
        }
      } catch (error) {
        report.error = error.message;
        this.log({ type: "error", text: `Pulizia spazio (${action}): ${report.error}` });
      }
      this.store.setValue("storageLast", { ...this.store.value("storageLast", {}), [action]: report });
    }
  }

  recordSample(now, sample, keepDays) {
    const hour = now.toISOString().slice(0, 13);
    const first = new Date(now.getTime() - keepDays * 86400000).toISOString().slice(0, 13);
    this.store.tx(() => {
      const hours = this.store.value("storageHours", []);
      this.store.setValue("storageSample:" + hour, sample);
      for (const key of hours.filter(key => key <= first)) {
        this.store.stmt("DELETE FROM settings WHERE key = ?").run("value:storageSample:" + key);
      }
      this.store.setValue("storageHours", [...new Set([...hours.filter(key => key > first), hour])].sort());
    });
  }

  async measure() {
    const disk = await statfs(this.home);
    const available = disk.bavail * disk.bsize;
    const percent = Math.round(100 * disk.bavail / disk.blocks);
    const scanner = script("./storage-measure.py");
    const roots = [["/var/log", "logs"], [this.home, "other"], [join(homedir(), ".cache"), "cache"]];
    const scopes = { host: await jsonCommand("python3", ["-I", scanner, JSON.stringify(roots)]) };
    const unavailable = [];
    const code = await readFile(scanner, "utf8");
    const agents = this.store.agents().filter(agent => !agent.sealed);
    const names = new Set(agents.map(agent => this.boxes.name(agent.id)));
    const listing = names.size ? await exec(this.docker, ["ps", "-a", "--format", "{{.Names}}"], { timeout: 20000 }).catch(() => { throw new Error("Docker desktop inventory unavailable"); }) : { stdout: "" };
    for (const box of listing.stdout.trim().split(/\s+/).filter(name => names.has(name))) {
      try {
        scopes[box] = await jsonCommand(this.docker, ["exec", box, "python3", "-I", "-c", code], 150000);
      } catch { unavailable.push(box); }
    }
    const previous = this.store.value("storageLast", {}).monitor?.result?.scopes || {};
    const growth = [];
    for (const [scope, stats] of Object.entries(scopes)) {
      for (const [category, bytes] of Object.entries(stats.bytes)) {
        const delta = bytes - previous[scope]?.bytes?.[category];
        if (delta > 0) growth.push({ scope, category, delta });
      }
    }
    growth.sort((a, b) => b.delta - a.delta);
    const warning = [
      available < 30e9 || percent <= 10 ? `${percent}% disponibile` : "",
      unavailable.length ? `${unavailable.length} desktop non misurati` : ""
    ].filter(Boolean).join(" · ");
    return { available, percent, scopes, unavailable, growth: growth.slice(0, 3), warning };
  }
}
