#!/usr/bin/env node
// The custom agent preview pipeline (NOT-94) on the macOS host that runs usecora.space.
// A LaunchAgent runs it every minute through hush (deploy/preview/README.md):
//   CORA_PREVIEW_PIPELINE_TOKEN (usecora.space's preview API), CORA_OLLAMA_API_KEY (briefing), RESEND_API_KEY (the email).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readSite, runOnce } from "../src/preview-pipeline.js";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const ROOT = env.CORA_PREVIEW_ROOT || join(homedir(), ".cora-previews");
const CLOUD = (env.CORA_PREVIEW_CLOUD_URL || "https://usecora.space").replace(/\/$/, "");
const CLOUD_HOME = env.CORA_CLOUD_HOME || join(homedir(), ".cora-cloud");
const CLOUD_CLI = env.CORA_CLOUD_CLI || join(homedir(), "Services", "cora-website", "cloud", "cli.js");
const NODE = env.CORA_NODE || process.execPath;
const HUSH = env.HUSH_BIN || join(homedir(), ".local", "bin", "hush");
const MODEL = env.CORA_PREVIEW_MODEL || "ollama/gpt-oss:120b";
const MINUTES = Number(env.CORA_PREVIEW_MINUTES || 60);
const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const uid = userInfo().uid;
const label = (entry) => `space.usecora.preview.${entry.slug}`;
const keyName = (entry) => `CORA_PREVIEW_${entry.slug.toUpperCase().replace(/-/g, "_")}_SESSION_KEY`;
const dir = (entry) => join(ROOT, entry.slug);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

async function cloudCall(path, { method = "GET", body } = {}) {
  const response = await fetch(`${CLOUD}/api/previews${path}`, { method, headers: { Authorization: `Bearer ${env.CORA_PREVIEW_PIPELINE_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`usecora.space previews answered ${response.status}`);
  return response.json();
}

const plist = (entry) => {
  const args = [HUSH, "run", "--name", keyName(entry), "--env", "CORA_SESSION_KEY", "--redact", "--", HUSH, "run", "--name", env.CORA_PREVIEW_OLLAMA_SECRET || "CORO_OLLAMA_API_KEY", "--env", "CORA_OLLAMA_API_KEY", "--redact", "--",
    NODE, "--disable-warning=ExperimentalWarning", join(app, "bin", "preview-space.mjs"), join(dir(entry), "spec.json")];
  const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label(entry)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(homedir())}</string><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>WorkingDirectory</key><string>${xml(dir(entry))}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(dir(entry), "space.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dir(entry), "space.log"))}</string>
</dict></plist>\n`;
};

const cloudDb = () => new DatabaseSync(join(CLOUD_HOME, "cloud.db"));

const spaces = {
  taken(slug) { const db = cloudDb(); try { return Boolean(db.prepare("SELECT 1 FROM spaces WHERE slug = ?").get(slug)); } finally { db.close(); } },
  freePort(used) {
    for (let port = 4600; port < 4700; port++) {
      if (used.includes(port)) continue;
      if (spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).stdout.length === 0) return port;
    }
    throw new Error("no free port");
  },
  write(entry) {
    writeJson(join(dir(entry), "spec.json"), {
      slug: entry.slug, port: entry.port, home: join(dir(entry), "home"), company: entry.company, site: entry.site, lang: entry.lang, model: MODEL, minutes: MINUTES,
      agents: entry.agents, guests: entry.guests.map(({ email, name, tokenHash }) => ({ email, name, tokenHash })),
    });
  },
  async start(entry) {
    if (spawnSync(HUSH, ["info", keyName(entry)], { stdio: "ignore" }).status !== 0) execFileSync(HUSH, ["generate", keyName(entry)], { stdio: "ignore" });
    const file = join(AGENTS_DIR, `${label(entry)}.plist`);
    writeFileSync(file, plist(entry));
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label(entry)}`], { stdio: "ignore" });
    execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: "ignore" });
  },
  async restart(entry) { execFileSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${label(entry)}`], { stdio: "ignore" }); },
  async healthy(entry) {
    for (let i = 0; i < 90; i++) {
      try {
        const runtime = JSON.parse(readFileSync(join(dir(entry), "runtime.json"), "utf8"));
        const ok = (await fetch(`http://127.0.0.1:${entry.port}/healthz`, { signal: AbortSignal.timeout(3000) })).ok;
        if (ok && runtime.ready && statSync(join(dir(entry), "runtime.json")).mtimeMs >= (entry.startedLaunchAt || 0)) return true;
      } catch {}
      await sleep(1000);
    }
    throw new Error("the preview space did not start");
  },
  async register(entry) {
    if (!spaces.taken(entry.slug)) {
      const owner = env.CORA_PREVIEW_OWNER_ACCOUNT || (() => { const db = cloudDb(); try { return db.prepare("SELECT account_id FROM spaces WHERE slug = 'notseb'").get()?.account_id; } finally { db.close(); } })();
      if (!owner) throw new Error("no owner account for preview spaces");
      execFileSync(NODE, ["--disable-warning=ExperimentalWarning", CLOUD_CLI, "space", "add", entry.slug, "--upstream", `http://127.0.0.1:${entry.port}`, "--owner", owner], { stdio: "ignore", env: { ...env, CORA_CLOUD_HOME: CLOUD_HOME } });
    }
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`https://${entry.slug}.usecora.space/healthz`, { signal: AbortSignal.timeout(5000) })).ok) return true; } catch {}
      await sleep(1500);
    }
    throw new Error("the preview space does not answer on usecora.space");
  },
  async unregister(entry) { const db = cloudDb(); try { db.prepare("DELETE FROM spaces WHERE slug = ? AND upstream = ?").run(entry.slug, `http://127.0.0.1:${entry.port}`); } finally { db.close(); } },
  async stop(entry) {
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label(entry)}`], { stdio: "ignore" });
    rmSync(join(AGENTS_DIR, `${label(entry)}.plist`), { force: true });
    spawnSync(HUSH, ["rm", keyName(entry)], { stdio: "ignore" });
    rmSync(dir(entry), { recursive: true, force: true });
  },
  window(entry) {
    const file = join(dir(entry), "home", "cora.db");
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try { const row = db.prepare("SELECT value FROM settings WHERE key = 'value:previewWindow'").get(); return row ? { minutes: MINUTES, ...JSON.parse(row.value) } : null; } finally { db.close(); }
  },
};

async function chat(messages) {
  const response = await fetch("https://ollama.com/api/chat", {
    method: "POST", headers: { Authorization: `Bearer ${env.CORA_OLLAMA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.CORA_PREVIEW_BRIEF_MODEL || "gpt-oss:120b", stream: false, format: "json", messages }), signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`briefing model answered ${response.status}`);
  return (await response.json()).message?.content || "";
}

async function mail({ to, subject, text, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.CORA_PREVIEW_MAIL_FROM || "Cora <cora@usecora.space>", to: [to], subject, text, html }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`mail provider answered ${response.status}`);
}

async function main() {
  for (const name of ["CORA_PREVIEW_PIPELINE_TOKEN", "CORA_OLLAMA_API_KEY", "RESEND_API_KEY"]) if (!env[name]) throw new Error(`${name} must be injected through hush`);
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const lock = join(ROOT, ".lock");
  try { if (Date.now() - statSync(lock).mtimeMs > 30 * 60000) unlinkSync(lock); } catch {}
  let fd;
  try { fd = openSync(lock, "wx"); } catch { return; }
  try {
    const registryFile = join(ROOT, "registry.json");
    await runOnce({
      now: () => Date.now(), log, chat, mail, site: (url) => readSite(url),
      registry: { load: () => (existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")) : []), save: (entries) => writeJson(registryFile, entries) },
      cloud: { list: async (status) => (await cloudCall(`?status=${status}`)).previews, update: (id, body) => cloudCall(`/${id}`, { method: "POST", body }), firstMessage: (id) => cloudCall(`/${id}/first-message`, { method: "POST" }) },
      spaces: { ...spaces, start: async (entry) => { entry.startedLaunchAt = Date.now() - 1000; return spaces.start(entry); }, restart: async (entry) => { entry.startedLaunchAt = Date.now() - 1000; return spaces.restart(entry); } },
    });
  } finally { closeSync(fd); unlinkSync(lock); }
}

main().catch((error) => { log({ type: "pipeline-error", error: error.message }); process.exit(1); });
