import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./box.js";

const worker = readFileSync(new URL("./desktop-cache.py", import.meta.url));

// Only reconcile worker availability here. Each desktop keeps its own clock and receipt.
export class DesktopCache {
  constructor({ store, boxes, docker, log }) {
    Object.assign(this, { store, boxes, docker, log });
    this.folder = join(store.home, "desktop-cache-policy");
    mkdirSync(this.folder, { recursive: true, mode: 0o755 });
    chmodSync(this.folder, 0o755);
    this.publish("worker.py", worker);
    this.writePolicy();
    this.nextCheck = 0;
    this.checked = new Map();
    this.queue = Promise.resolve();
  }

  publish(name, content) {
    const target = join(this.folder, name);
    const temp = target + ".new";
    writeFileSync(temp, content, { mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, target);
  }

  writePolicy() {
    this.publish("policy", this.store.value("storagePolicy", {})?.desktopCache === false ? "off" : "on");
  }

  tick(now) {
    if (now < this.nextCheck) return;
    this.nextCheck = now + 60000;
    if (this.checking) return;
    this.checking = this.sync().finally(() => { this.checking = null; });
    this.checking.catch(error => this.log({ type: "error", text: error.message }));
  }

  sync() {
    const job = this.queue.then(() => this.reconcile());
    this.queue = job.catch(() => {});
    return job;
  }

  async reconcile() {
    const agents = this.store.agents();
    if (!agents.length) return;
    const enabled = this.store.value("storagePolicy", {})?.desktopCache !== false;
    const list = await runProcess(this.docker, ["ps", "--filter", "label=cora.agent", "--format", '{{.Names}}|{{.Label "cora.desktop-cache"}}'], { timeoutMs: 15000 });
    if (list.code !== 0) throw new Error("Desktop cache cleanup: Docker inventory unavailable");
    const known = new Map(agents.map(agent => [this.boxes.name(agent.id), agent]));
    const legacy = list.stdout.toString().trim().split("\n")
      .map(line => line.split("|")).filter(([name, kind]) => known.has(name) && kind !== "native")
      .map(([name]) => name);
    if (!legacy.length) { this.checked.clear(); return; }
    const states = await runProcess(this.docker, ["inspect", "--format", "{{.Name}}|{{.State.StartedAt}}|{{.State.Running}}", ...legacy], { timeoutMs: 15000 });
    if (states.code !== 0) throw new Error("Desktop cache cleanup: could not read desktop status");
    const now = Date.now();
    const current = new Map(this.checked);
    this.checked.clear();
    const failures = [];
    for (const line of states.stdout.toString().trim().split("\n")) {
      const [name, startedAt, running] = line.split("|");
      const agent = known.get(name.replace(/^\//, ""));
      if (!agent || running !== "true") continue;
      const signature = startedAt + ":" + enabled;
      const previous = current.get(agent.id);
      if (previous?.signature === signature && now < previous.checkAfter) {
        this.checked.set(agent.id, previous);
        continue;
      }
      const args = this.boxes.execArgs(agent.id, ["python3", "-I", "-", enabled ? "on" : "off"]);
      const result = await runProcess(this.docker, args, { input: worker, timeoutMs: 45000, maxBytes: 2048 });
      if (result.code !== 0) failures.push(agent.id);
      else this.checked.set(agent.id, { signature, checkAfter: now + 15 * 60000 });
    }
    if (failures.length) throw new Error("Desktop cache cleanup: " + failures.join(", "));
  }
}
