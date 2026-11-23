import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

/**
 * Where each harness comes from. A CLI that is behind its provider sees fewer models
 * (Codex lists gpt-6.2 only to new clients), so Cora keeps them current by itself:
 * npm packages through whatever installed them, self-updating CLIs through their own
 * command, and a git checkout only reported, because pulling it may carry local changes away.
 */
export const HARNESS_SOURCES = {
  claude: { product: "Claude Code", package: "@anthropic-ai/claude-code" },
  codex: { product: "Codex", package: "@openai/codex" },
  grok: { product: "Grok Build", package: "@xai-official/grok" },
  gemini: { product: "Antigravity CLI", selfUpdate: ["update"] },
  muse: { product: "Muse Code", self: true },
  kimi: { product: "Kimi Code", package: "@moonshot-ai/kimi-code" },
  pi: { product: "Pi", package: "@earendil-works/pi-coding-agent" },
  hermes: { product: "Hermes", git: true },
  deepseek: { product: "DeepSeek Harness", package: "@deepseek-ai/dsh" },
};

const CHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const FIRST_MS = 2 * 60 * 1000;
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

export function parseVersion(text) {
  return VERSION.exec(String(text || ""))?.[0] || "";
}

/** -1, 0 or 1. A prerelease sorts before its release; parts are compared as numbers where they are numbers. */
export function compareVersions(a, b) {
  const split = (value) => {
    const [core, pre = ""] = String(value).split("-", 2);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.core[index] || 0) - (right.core[index] || 0);
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index], y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x), ny = Number(y);
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function which(bin, path) {
  if (!bin) return "";
  if (bin.includes("/")) return existsSync(bin) ? bin : "";
  for (const dir of String(path || "").split(":")) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return "";
}

function real(file) {
  try { return realpathSync(file); } catch { return file; }
}

function head(file) {
  try {
    const text = readFileSync(file).subarray(0, 4096);
    return text.includes(0) ? "" : text.toString("utf8");
  } catch { return ""; }
}

export class HarnessUpdates {
  /**
   * `bins` maps a harness to the command Cora runs it with; `busy(provider)` says whether a turn
   * is using it now; `changed(provider)` is told after a new version is in place, so the model
   * catalogs are read again with it.
   */
  constructor({ store, bins, busy = () => false, changed = () => {}, emit = () => {}, fetchImpl = fetch, registry = "https://registry.npmjs.org", env = process.env, grokHome = "", checkMs = CHECK_MS, retryMs = RETRY_MS, commandTimeoutMs = 10 * 60 * 1000 }) {
    this.store = store;
    this.bins = bins;
    this.busy = busy;
    this.changed = changed;
    this.emit = emit;
    this.fetchImpl = fetchImpl;
    this.registry = registry.replace(/\/$/, "");
    this.env = env;
    this.grokHome = grokHome || env.GROK_HOME || join(homedir(), ".grok");
    this.checkMs = checkMs;
    this.retryMs = retryMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.states = { ...(store.value("harnessVersions", {}) || {}) };
    this.timer = null;
    for (const state of Object.values(this.states)) {
      if (state.state === "updating") state.state = "unknown";
    }
    this.running = null;
    this.progress = null;
    this.installations = new Map();
  }

  enabled() {
    return this.store.settings.harnessAutoUpdate !== false;
  }

  status() {
    // Where a CLI lives on the server stays on the server.
    return Object.keys(HARNESS_SOURCES).map((provider) => {
      const { path: _path, ...state } = this.states[provider] || { state: "unknown" };
      return { provider, product: HARNESS_SOURCES[provider].product, ...state };
    });
  }

  publishProgress(values) {
    this.progress = { ...this.progress, ...values };
    this.emit({ type: "harness-versions", harnesses: this.status(), progress: this.progress });
  }

  phase(provider, phase) {
    if (this.progress?.provider === provider) this.publishProgress({ phase });
  }

  installation(provider) {
    return this.installations.get(provider);
  }

  /** One harness's version, for the selectors: empty when it was never read. */
  version(provider) {
    return this.states[provider]?.version || "";
  }

  start({ firstMs = FIRST_MS } = {}) {
    this.stop();
    const tick = async (delay) => {
      this.timer = setTimeout(async () => {
        let deferred = false;
        try { deferred = (await this.checkAll({ update: this.enabled() })).some((item) => item.state === "deferred"); } catch {}
        if (this.timer) tick(deferred ? this.retryMs : this.checkMs);
      }, delay);
      this.timer.unref?.();
    };
    tick(firstMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  run(command, args, { timeoutMs = 20000, env = {} } = {}) {
    return new Promise((resolve) => {
      let output = "";
      let child;
      try {
        child = spawn(command, args, { env: { ...this.env, ...env, NO_COLOR: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ code: -1, output: error.message });
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const keep = (chunk) => { if (output.length < 64000) output += chunk; };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") }); });
    });
  }

  async readVersion(provider, path) {
    const { code, output } = await this.run(path, ["--version"]);
    return code === 0 ? parseVersion(output) : "";
  }

  /** How a CLI was installed, which decides how it is brought up to date. */
  async method(provider, path) {
    const source = HARNESS_SOURCES[provider];
    if (source.self) return { kind: "self" };
    if (source.git) return { kind: "git" };
    if (source.selfUpdate) return { kind: "command" };
    const text = head(path);
    const wrapped = /\bmise\s+(?:x|exec)\s+(?:--\s+)?["']?([^"'\s]+)["']?\s+--/.exec(text)?.[1];
    if (wrapped) return { kind: "mise", tool: wrapped };
    const target = real(path);
    if (/\/mise\/(shims|installs)\//.test(path) || /\/mise\/installs\//.test(target) || /\/mise$/.test(target)) {
      const tool = await this.miseTool(path);
      if (tool) return { kind: "mise", tool };
    }
    const name = source.package.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const global = new RegExp(`^(.*)/lib/node_modules/${name}/`).exec(target);
    if (global) return { kind: "npm", prefix: global[1], global: true };
    const local = new RegExp(`^(.*)/node_modules/${name}/`).exec(target);
    if (local) return { kind: "npm", prefix: local[1], global: false };
    return { kind: "manual" };
  }

  async miseTool(path) {
    const name = path.split("/").pop();
    const located = await this.run("mise", ["which", name]);
    const resolved = located.code === 0 ? real(located.output.trim()) : real(path);
    const listed = await this.run("mise", ["ls", "--current", "--json"]);
    if (listed.code !== 0) return "";
    try {
      for (const [tool, versions] of Object.entries(JSON.parse(listed.output))) {
        for (const version of versions || []) {
          const root = version.install_path && real(version.install_path);
          if (root && resolved.startsWith(`${root}/`)) return tool;
        }
      }
    } catch {}
    return "";
  }

  async latest(provider) {
    const source = HARNESS_SOURCES[provider];
    if (!source.package) return "";
    const response = await this.fetchImpl(`${this.registry}/${source.package.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`npm risponde ${response.status}`);
    return parseVersion((await response.json()).version);
  }

  async update(provider, method, latest) {
    const source = HARNESS_SOURCES[provider];
    const timeoutMs = this.commandTimeoutMs;
    if (method.kind === "mise") return this.run("mise", ["upgrade", method.tool], { timeoutMs, env: { MISE_MINIMUM_RELEASE_AGE: "0", MISE_YES: "1" } });
    if (method.kind === "npm") {
      const args = ["install", ...(method.global ? ["-g"] : []), "--prefix", method.prefix, `${source.package}@${latest}`];
      return this.run("npm", args, { timeoutMs });
    }
    if (method.kind === "command") return this.run(this.states[provider]?.path || this.bins[provider], source.selfUpdate, { timeoutMs });
    return { code: -1, output: "nessun modo noto per aggiornarlo" };
  }

  /**
   * Grok's npm launcher runs the binary it once copied to ~/.grok/bin and only copies a new one
   * when that link is missing: after an upgrade the link is dropped so the next start relinks.
   */
  relinkGrok(previous) {
    const link = join(this.grokHome, "bin", "grok");
    try {
      if (lstatSync(link).isSymbolicLink() && real(link).endsWith(`grok-${previous}`)) unlinkSync(link);
    } catch {}
  }

  set(provider, values) {
    this.states[provider] = { ...(this.states[provider] || {}), ...values };
    this.store.setValue("harnessVersions", this.states);
  }

  async checkOne(provider, { update = true } = {}) {
    const source = HARNESS_SOURCES[provider];
    const path = which(this.bins[provider], this.env.PATH);
    const checkedAt = new Date().toISOString();
    if (!path) {
      this.set(provider, { state: "missing", auto: false, version: "", latest: "", method: "", path: "", error: "", checkedAt });
      return this.states[provider];
    }
    const version = await this.readVersion(provider, path);
    const method = await this.method(provider, path);
    this.set(provider, { path, version, method: method.kind, checkedAt, auto: ["mise", "npm", "command"].includes(method.kind) });
    if (method.kind === "self") {
      this.set(provider, { state: "self", latest: "", error: "" });
      return this.states[provider];
    }
    if (method.kind === "git") {
      const { code, output } = await this.run(path, ["update", "--check"], { timeoutMs: 120000 });
      const behind = /(\d+)\s+commits?\s+behind/i.exec(output)?.[1];
      const available = code === 0 && /update available/i.test(output);
      this.set(provider, { state: available ? "outdated" : code === 0 ? "current" : "unknown", latest: available ? (behind ? `+${behind} commit` : "nuova") : "", error: code === 0 ? "" : output.trim().split("\n").pop()?.slice(0, 200) || "" });
      return this.states[provider];
    }
    let latest = "";
    if (source.package) {
      try { latest = await this.latest(provider); } catch (error) {
        this.set(provider, { state: "unknown", latest: "", error: `ultima versione non letta: ${error.message}` });
        return this.states[provider];
      }
      if (!version || !latest || compareVersions(version, latest) >= 0) {
        this.set(provider, { state: version && latest ? "current" : "unknown", latest, error: !version ? "versione non letta" : !latest ? "ultima versione non letta" : "" });
        return this.states[provider];
      }
      this.set(provider, { state: "outdated", latest, error: "" });
    }
    if (!update || method.kind === "manual") {
      if (method.kind === "manual" && latest) this.set(provider, { error: "installato a mano: aggiornalo sul server" });
      if (!source.package) this.set(provider, { state: "unknown", latest: "" });
      return this.states[provider];
    }
    // A versioned install (mise) leaves the running turns on their own copy; anything rewritten in place waits for them.
    if (method.kind !== "mise" && this.busy(provider)) {
      this.set(provider, { state: "deferred", error: "" });
      return this.states[provider];
    }
    let release;
    if (method.kind !== "mise") this.installations.set(provider, new Promise((resolve) => { release = resolve; }));
    try {
      this.set(provider, { state: "updating", error: "" });
      this.phase(provider, "installing");
      const result = await this.update(provider, method, latest);
      this.phase(provider, "restarting");
      if (provider === "grok") this.relinkGrok(version);
      // Agents start a fresh CLI for each turn. Launch the installed executable through the
      // same path before releasing any waiting turns, then check it in a second fresh process.
      const started = await this.readVersion(provider, path);
      this.phase(provider, "verifying");
      const now = started && await this.readVersion(provider, path);
      const advanced = now && (!version || compareVersions(now, version) > 0);
      const verified = now && now === started && (!latest || compareVersions(now, latest) >= 0);
      const noChange = !source.package && result.code === 0 && now === version;
      if (!verified || (!advanced && !noChange)) {
        const detail = result.code !== 0
          ? result.output.trim().split("\n").filter(Boolean).pop() || "uscito con codice " + result.code
          : "verifica della versione non riuscita (" + (now || started || "versione non leggibile") + ")";
        this.set(provider, { state: "failed", version: now || version, error: detail.slice(0, 300) });
        return this.states[provider];
      }
      if (advanced) {
        this.set(provider, { version: now });
        await this.changed(provider);
      }
      const verifiedAt = new Date().toISOString();
      this.set(provider, {
        state: "current", error: "", checkedAt: verifiedAt,
        ...(advanced ? { previous: version, updatedAt: verifiedAt, verifiedVersion: now } : {}),
      });
      return this.states[provider];
    } finally {
      this.installations.delete(provider);
      release?.();
    }
  }

  async checkBatch({ update, waitForTurns }) {
    const providers = Object.keys(HARNESS_SOURCES);
    const deferred = [];
    let done = 0;
    const check = async (provider) => {
      this.publishProgress({ active: true, provider, phase: "checking", done, total: providers.length });
      try {
        return await this.checkOne(provider, { update });
      } catch (error) {
        this.set(provider, { state: this.states[provider]?.state === "updating" ? "failed" : "unknown", error: error.message });
        return this.states[provider];
      }
    };
    for (const provider of providers) {
      const item = await check(provider);
      if (waitForTurns && item.state === "deferred") deferred.push(provider);
      else done++;
    }
    const deadline = Date.now() + 120000;
    for (const provider of deferred) {
      this.publishProgress({ provider, phase: "waiting", done });
      while (this.busy(provider) && Date.now() < deadline) await wait(1000, undefined, { ref: false });
      if (!this.busy(provider)) await check(provider);
      done++;
    }
    return providers.map((provider) => ({ provider, ...this.states[provider] }));
  }

  /** Join a compatible check. A manual update following a read-only check still installs. */
  checkAll({ update = this.enabled(), waitForTurns = false } = {}) {
    if (this.queued) return this.queued;
    if (this.running) {
      if ((!update || this.runningUpdate) && (!waitForTurns || this.runningWait)) return this.running;
      const next = () => {
        this.queued = null;
        return this.checkAll({ update, waitForTurns });
      };
      this.queued = this.running.then(next, next);
      return this.queued;
    }
    this.runningUpdate = update;
    this.runningWait = waitForTurns;
    this.running = this.checkBatch({ update, waitForTurns }).finally(() => {
      this.running = null;
      this.publishProgress({ active: Boolean(this.queued), provider: "", phase: "", done: this.progress.total });
    });
    return this.running;
  }
}
