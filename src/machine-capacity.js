import { execFile } from "node:child_process";
import { hostname, release } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GiB = 2 ** 30;
const HOUR = 3600000;
const INTERVAL = 5 * 60000;
const WEEK = 7 * 24 * HOUR;

// Read the filesystem holding desktop homes and the kernel of the Docker machine.
// Docker Desktop and remote daemons may live on a different machine from the panel.
const hostProbe = `import json, os, sys
disk = os.statvfs(sys.argv[1])
with open("/proc/meminfo") as f:
    mem = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in f if line.startswith(("MemTotal:", "MemAvailable:"))}
print(json.dumps(dict(diskFree=disk.f_bavail*disk.f_frsize, diskTotal=disk.f_blocks*disk.f_frsize,
                      ramFree=mem["MemAvailable"], ramTotal=mem["MemTotal"], load=os.getloadavg()[1])))`;

async function command(bin, args) {
  const { stdout } = await exec(bin, args, { timeout: 12000, maxBuffer: 256 * 1024 });
  return stdout.trim();
}

function bytes(text) {
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/.exec(text.trim());
  return match ? Number(match[1]) * 1024 ** ["B", "KiB", "MiB", "GiB", "TiB"].indexOf(match[2]) : NaN;
}

export async function sampleMachine({ docker, names, inventory = () => {} }) {
  const [info, listing] = await Promise.all([
    command(docker, ["info", "--format", "{{json .ID}}\t{{json .Name}}\t{{json .KernelVersion}}\t{{json .DockerRootDir}}\t{{json .NCPU}}"]),
    command(docker, ["ps", "--filter", "label=cora.agent", "--format", "{{.Names}}"]),
  ]);
  const running = listing.split("\n").filter(name => names.has(name));
  const [machine, name, kernel, root, cores] = info.split("\t").map(part => JSON.parse(part));
  const active = running.length;
  inventory(active);
  if (!machine || !Number.isInteger(cores) || cores < 1) throw new Error("Invalid Docker machine");
  const local = process.platform === "linux" && name === hostname() && kernel === release();
  const probe = async () => {
    if (local) {
      try { return await command("python3", ["-I", "-c", hostProbe, root + "/volumes"]); }
      catch (error) { if (!active) throw error; }
    }
    if (!active) throw new Error("No running desktop on remote machine");
    return command(docker, ["exec", "--user", "65534", running[0], "/usr/bin/python3", "-I", "-c", hostProbe, "/home/agent"]);
  };
  const [host, stats] = await Promise.all([
    probe().then(JSON.parse),
    active ? command(docker, ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}", ...running]) : "",
  ]);
  if (!["diskFree", "diskTotal", "ramFree", "ramTotal", "load"].every(key => Number.isFinite(host[key]) && host[key] >= 0)
    || !host.diskTotal || !host.ramTotal || host.diskFree > host.diskTotal || host.ramFree > host.ramTotal) throw new Error("Invalid host measurements");
  const remaining = new Set(running);
  let cpu = 0, ram = 0, working = 0;
  for (const line of stats.split("\n").filter(Boolean)) {
    const [box, percent, memory] = line.split("\t");
    const usage = Number(percent?.replace(/%$/, "")) / 100;
    const used = bytes((memory || "").split("/")[0]);
    if (!remaining.delete(box) || !Number.isFinite(usage) || usage < 0 || !Number.isFinite(used)) throw new Error("Invalid desktop statistics");
    cpu += usage;
    ram += used;
    if (usage >= 0.1) working++;
  }
  if (remaining.size) throw new Error("Incomplete desktop statistics");
  return { ...host, running, machine, cores, active, cpu: cpu / (active || 1), ram: ram / (active || 1), working };
}

function percentile(values, fraction) {
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1];
}

export function recordCapacity(history, now, sample) {
  const hour = Math.floor(now / HOUR);
  const rows = history.filter(row => row.machine === sample.machine && row.hour > hour - 168 && row.hour <= hour);
  const demand = {
    cpu: sample.cpu, ram: sample.ram, load: sample.load, ramUsed: sample.ramTotal - sample.ramFree,
    busy: sample.active > 0 && sample.working >= Math.min(2, sample.active),
  };
  const last = rows.at(-1);
  if (last?.hour !== hour) rows.push({ machine: sample.machine, hour, ...demand });
  else {
    for (const key of ["cpu", "ram", "load", "ramUsed"]) last[key] = Math.max(last[key], demand[key]);
    last.busy ||= demand.busy;
  }
  return rows;
}

export function estimateCapacity(sample, history, diskPerAgent) {
  const busy = history.filter(row => row.busy);
  const profile = busy.length ? busy : history;
  const demand = key => Math.max(sample[key], percentile(profile.map(row => row[key]), 0.9) || 0);
  const load = Math.max(sample.load, percentile(history.map(row => row.load), 0.9) || 0);
  const used = Math.max(sample.ramTotal - sample.ramFree, percentile(history.map(row => row.ramUsed), 0.9) || 0);
  const slots = {
    disk: (sample.diskFree - Math.max(10 * GiB, sample.diskTotal * 0.15)) / (diskPerAgent || 20 * GiB),
    ram: (sample.ramTotal - used - Math.max(GiB, sample.ramTotal * 0.1)) / Math.max(GiB, demand("ram")),
    cpu: (sample.cores * 0.85 - load) / Math.max(0.25, demand("cpu")),
  };
  const limit = Object.keys(slots).reduce((a, b) => slots[a] <= slots[b] ? a : b);
  return { active: sample.active, additional: Math.max(0, Math.floor(slots[limit])), limit,
    preliminary: busy.length < 6 || busy.at(-1).hour - busy[0].hour < 24, diskDefault: !diskPerAgent };
}

export class MachineCapacity {
  constructor({ store, docker, boxes }) {
    Object.assign(this, { store, docker, boxes });
    this.next = 0;
    this.latest = null;
  }

  tick(now) {
    if (this.pending || now < this.next) return;
    this.next = now + INTERVAL;
    const names = new Set(this.store.agents().map(agent => this.boxes.name(agent.id)));
    let active = null;
    this.pending = sampleMachine({ docker: this.docker, names, inventory: count => { active = count; } }).then(sample => {
      const history = recordCapacity(this.store.value("machineCapacityHistory", []), now, sample);
      this.store.setValue("machineCapacityHistory", history);
      const report = this.store.value("storageLast", {}).monitor;
      let diskUnit = null;
      if (report?.result && now >= Date.parse(report.at) && now - Date.parse(report.at) < WEEK) {
        const sizes = Object.entries(report.result.scopes || {})
          .filter(([name, scope]) => names.has(name) && scope.bytes && scope.unreadable_count === 0)
          .map(([, scope]) => Object.values(scope.bytes).reduce((sum, bytes) => sum + bytes, 0));
        const complete = sample.running.every(name => report.result.scopes?.[name]?.unreadable_count === 0);
        if (complete && sizes.length) diskUnit = Math.max(GiB, percentile(sizes, 0.9));
      }
      this.latest = { ...estimateCapacity(sample, history, diskUnit), at: now };
    }).catch(() => { this.latest = { active, preliminary: true, at: now }; }).finally(() => { this.pending = null; });
  }

  status(now = Date.now()) {
    return this.latest && now - this.latest.at < INTERVAL * 2 ? this.latest : { preliminary: true };
  }
}
