import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolBridge } from "../src/bridge.js";
import { kimiAgentFile, nodeCli, piFiles, runKimi, runPi } from "../src/cli.js";
import { PI_SERVICES, subscriptionProviderOf } from "../src/harnesses.js";
import { modelKeyBackend } from "../src/hermes-keys.js";
import { kimiAccessToken, kimiAccount, kimiModels, kimiRegion } from "../src/kimi-auth.js";
import { startCora } from "../src/main.js";
import { Store } from "../src/store.js";
import { subscriptionEnvironment } from "../src/subscriptions.js";
import { parseSubscriptionUsage } from "../src/subscription-usage.js";
import { fakeDocker, tempHome, waitFor } from "./helpers.js";

const TOOLS = [
  { name: "say", description: "Post a message", parameters: { type: "object", properties: { text: { type: "string" } } } },
  { name: "shell", description: "Run a command on the agent's computer", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

/** A Kimi Code home as the official login leaves it: the token, the region's provider, a model alias and a device id. */
function kimiHome(root, { expiresIn = 3600, region = "global" } = {}) {
  const home = join(root, "kimi-home");
  mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
  const base = region === "global" ? "https://api.kimi.ai/coding/v1" : "https://api.kimi.com/coding/v1";
  writeFileSync(join(home, "config.toml"), `default_model = "kimi-code/k3"\n\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "${base}"\n\n[models."kimi-code/k3"]\nprovider = "managed:kimi-code"\nmodel = "k3"\n`);
  writeFileSync(join(home, "device_id"), "fixture-device");
  writeFileSync(join(home, "credentials", "kimi-code-env-fixture.json"), JSON.stringify({
    access_token: "fixture-access-1", refresh_token: "fixture-refresh-1", expires_at: Math.floor(Date.now() / 1000) + expiresIn, scope: "kimi-code", token_type: "Bearer", expires_in: 3600,
  }), { mode: 0o600 });
  return home;
}

/** Kimi's endpoints as Cora uses them: the token refresh, who the account is, its models and its limits. */
function kimiApi({ refreshStatus = 200 } = {}) {
  const calls = [];
  let issued = 1;
  const fetchImpl = async (url, init = {}) => {
    const { pathname, host } = new URL(url);
    const auth = String(init.headers?.Authorization || "");
    calls.push({ host, pathname, auth, body: String(init.body || "") });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (pathname === "/api/oauth/token") {
      if (refreshStatus !== 200) return json(refreshStatus, { error: "invalid_grant" });
      issued += 1;
      return json(200, { access_token: `fixture-access-${issued}`, refresh_token: `fixture-refresh-${issued}`, expires_in: 3600, token_type: "Bearer", scope: "kimi-code" });
    }
    if (!/^Bearer fixture-access-\d+$/.test(auth)) return json(401, { error: "unauthorized" });
    if (pathname.endsWith("/me")) return json(200, { user_id: "u1", email: "owner@example.test", user_level_name: "Plus" });
    if (pathname.endsWith("/models")) return json(200, { data: [{ id: "k3", display_name: "K3" }, { id: "kimi-for-coding", display_name: "K2.8" }, { id: "bad id" }] });
    if (pathname.endsWith("/usages")) return json(200, { usages: { limit_5h: { used_ratio: 0.25, reset_time: "2026-11-17T20:00:00Z" }, limit_month_total: { used_ratio: 0.5, reset_time: "2026-12-17T00:00:00Z" } } });
    return json(404, { error: "not found" });
  };
  return { fetchImpl, calls };
}

function script(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

test("Kimi's token is refreshed once under the CLI's own lock, in the CLI's own file, and a revoked one disconnects", async () => {
  const root = mkdtempSync(join(tmpdir(), "cora-kimi-"));
  const home = kimiHome(root, { expiresIn: 30 });
  assert.equal(kimiRegion(home), "global");
  const api = kimiApi();
  const tokens = await Promise.all([1, 2, 3].map(() => kimiAccessToken(home, { fetchImpl: api.fetchImpl })));
  assert.deepEqual(new Set(tokens), new Set(["fixture-access-2"]), "parallel callers share one refresh");
  const refreshes = api.calls.filter((call) => call.pathname === "/api/oauth/token");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].host, "auth.kimi.ai", "the region the account signed in to");
  assert.match(refreshes[0].body, /grant_type=refresh_token/);
  const saved = JSON.parse(readFileSync(join(home, "credentials", "kimi-code-env-fixture.json"), "utf8"));
  assert.equal(saved.refresh_token, "fixture-refresh-2", "the rotated refresh token is the account's, for the CLI too");
  assert.ok(!existsSync(join(home, "oauth", "kimi-code-env-fixture.lock")), "the lock is released");
  assert.equal(await kimiAccessToken(home, { fetchImpl: api.fetchImpl }), "fixture-access-2", "a fresh token is reused");
  assert.deepEqual(await kimiAccount(home, { fetchImpl: api.fetchImpl }), { email: "owner@example.test", plan: "Plus" });
  assert.deepEqual((await kimiModels(home, { fetchImpl: api.fetchImpl })).map((model) => model.name), ["k3", "kimi-for-coding"]);

  const revoked = kimiHome(mkdtempSync(join(tmpdir(), "cora-kimi-")), { expiresIn: 0 });
  await assert.rejects(kimiAccessToken(revoked, { fetchImpl: kimiApi({ refreshStatus: 401 }).fetchImpl }), { code: "KIMI_AUTH" });
  const tomb = JSON.parse(readFileSync(join(revoked, "credentials", "kimi-code-env-fixture.json"), "utf8"));
  assert.equal(tomb.access_token, "", "the CLI's own tombstone: it asks for a new login too");

  assert.deepEqual(parseSubscriptionUsage("kimi", { usages: { limit_5h: { used_ratio: 0.25, reset_time: "2026-11-17T20:00:00Z" }, limit_month_code: { used_ratio: 2 } } }).map((item) => [item.id, item.kind, item.usedPercent]), [["limit_5h", "session", 25]]);
});

test("a model id names the account it runs on and the key it needs", () => {
  assert.equal(subscriptionProviderOf("kimi/k3"), "kimi");
  assert.equal(subscriptionProviderOf("hermes/kimi/k3"), "kimi");
  assert.equal(subscriptionProviderOf("pi/kimi/k3"), "kimi");
  assert.equal(subscriptionProviderOf("pi/anthropic/claude-sonnet-5-5"), "pi");
  assert.equal(subscriptionProviderOf("pi/openai-codex/gpt-6"), "pi");
  assert.equal(subscriptionProviderOf("pi/deepseek/deepseek-flash"), "");
  assert.equal(subscriptionProviderOf("hermes/ollama/qwen3"), "");
  assert.equal(subscriptionProviderOf("claude/claude-opus-5-5"), "claude");
  assert.equal(modelKeyBackend("pi/deepseek/deepseek-flash"), "deepseek");
  assert.equal(modelKeyBackend("pi/ollama/glm-5:cloud"), "ollama");
  assert.equal(modelKeyBackend("pi/kimi/k3"), "");
  assert.deepEqual(Object.keys(PI_SERVICES), ["anthropic", "openai-codex"]);

  const store = new Store(tempHome());
  const kimi = store.createSubscription({ provider: "kimi", label: "Kimi" });
  store.updateSubscription(kimi.id, { status: "ready" });
  assert.throws(() => store.createSubscription({ provider: "pi", label: "Pi" }), /servizio/);
  const claude = store.createSubscription({ provider: "pi", label: "Pi · Claude", service: "anthropic" });
  store.updateSubscription(claude.id, { status: "ready" });
  store.checkAgentSubscription({ model: "hermes/kimi/k3", subscriptionId: kimi.id });
  store.checkAgentSubscription({ model: "pi/anthropic/claude-sonnet-5-5", subscriptionId: claude.id });
  assert.throws(() => store.checkAgentSubscription({ model: "pi/openai-codex/gpt-6", subscriptionId: claude.id }), /incompatibile/);
  assert.throws(() => store.checkAgentSubscription({ model: "pi/kimi/k3", subscriptionId: claude.id }), /incompatibile/);
  assert.throws(() => store.checkAgentSubscription({ model: "hermes/kimi/k3" }), /subscription/);
  store.checkAgentSubscription({ model: "pi/deepseek/deepseek-flash" });
});

test("Kimi Code runs with Cora's prompt and tools only, in a home of its own linked to the account's login", async () => {
  const root = mkdtempSync(join(tmpdir(), "cora-kimi-run-"));
  const account = kimiHome(root);
  const record = join(root, "seen.json");
  const bin = script(root, "kimi", `
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), home = process.env.KIMI_CODE_HOME;
const files = Object.fromEntries(fs.readdirSync(home).map((name) => [name, fs.lstatSync(path.join(home, name)).isSymbolicLink() ? "link" : "file"]));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, files, homeEmpty: fs.readdirSync(process.env.HOME).length === 0, agent: fs.readFileSync(argv[argv.indexOf("--agent-file") + 1], "utf8"),
  mcp: files["mcp.json"] ? JSON.parse(fs.readFileSync(path.join(home, "mcp.json"), "utf8")) : null, bridge: Boolean(process.env.CORA_BRIDGE_TOKEN), telemetry: process.env.KIMI_DISABLE_TELEMETRY, update: process.env.KIMI_CODE_NO_AUTO_UPDATE, token: fs.readFileSync(path.join(home, "credentials", "kimi-code-env-fixture.json"), "utf8").includes("fixture-access-1") }));
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
// Kimi's own session log says how many tools the first step had; the toolless modes reproduce its MCP race.
const counter = path.join(${JSON.stringify(root)}, "attempts");
const attempt = (() => { let n = 0; try { n = Number(fs.readFileSync(counter, "utf8")); } catch {} fs.writeFileSync(counter, String(n + 1)); return n + 1; })();
const toolless = process.env.FIXTURE_MODE === "toolless" || (process.env.FIXTURE_MODE === "toolless-once" && attempt === 1);
fs.mkdirSync(path.join(home, "sessions", "wd_x", "s1", "logs"), { recursive: true });
fs.writeFileSync(path.join(home, "sessions", "wd_x", "s1", "logs", "kimi-code.log"), "2026-11-17T16:40:00.900Z INFO  llm config  turnStep=0.1 provider=openai model=k3 toolCount=" + (toolless ? 0 : 2) + "\\n");
if (toolless) { line({ role: "assistant", content: "Non ho strumenti." }); process.exit(0); }
if (process.env.FIXTURE_MODE === "text-call") { line({ role: "assistant", content: "<|open|>tools<|sep|><|open|>call tool=\\"say\\"" }); process.exit(0); }
if (process.env.FIXTURE_MODE === "fail") { process.stderr.write("Error: quota exceeded for this window\\n"); process.exit(1); }
line({ role: "assistant", content: "Guardo il nome host.", tool_calls: [{ type: "function", id: "c1", function: { name: "mcp__cora__shell", arguments: "{}" } }] });
line({ role: "tool", tool_call_id: "c1", content: "radix" });
line({ role: "assistant", content: "Fatto: radix." });
`);
  const bridge = new ToolBridge();
  await bridge.start();
  const run = bridge.register({ tools: TOOLS, execute: async () => ({ text: "ok" }) });
  const workDir = join(root, "work");
  const steps = [];
  const big = `richiesta ${"x".repeat(100 * 1024)}`;
  try {
    const out = await runKimi({ bin, model: "k3", system: "Sei Prova. ${cwd} resta così.", prompt: "Che host?", mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, onStep: (step) => steps.push(step), authEnv: subscriptionEnvironment("kimi", account) });
    assert.equal(out.text, "Fatto: radix.");
    assert.deepEqual(steps, [{ type: "text", text: "Guardo il nome host." }], "text before a tool call is its reasoning");
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(seen.argv.slice(0, 6), ["-p", "Che host?", "--output-format", "stream-json", "-m", "kimi-code/k3"]);
    assert.ok(seen.argv.includes("--skills-dir"));
    assert.equal(seen.homeEmpty, true, "the owner's ~/.agents never reaches Kimi");
    assert.equal(seen.telemetry, "1");
    assert.equal(seen.update, "1");
    assert.equal(seen.bridge, true);
    assert.equal(seen.token, true, "the account's login is read through the link");
    for (const name of ["credentials", "oauth", "device_id", "config.toml"]) assert.equal(seen.files[name], "link", `${name} is the account's`);
    assert.equal(seen.mcp.mcpServers.cora.url, `${run.url}/mcp`, "Cora's tools over HTTP, from the run's own bridge");
    assert.equal(seen.mcp.mcpServers.cora.bearerTokenEnvVar, "CORA_BRIDGE_TOKEN", "the key comes from the environment, never the file");
    assert.match(seen.agent, /^---\nname: cora\n/);
    assert.match(seen.agent, /tools: \["mcp__cora__\*"\]/);
    assert.match(seen.agent, /subagents: \[\]/);
    assert.ok(seen.agent.includes("Sei Prova.") && !seen.agent.includes("${cwd}"), "Kimi's template variables never rewrite Cora's text");
    assert.deepEqual(readdirSync(workDir), [], "the run's home is gone, links included");
    assert.ok(existsSync(join(account, "credentials", "kimi-code-env-fixture.json")), "the account's own login stays");

    await runKimi({ bin, model: "k3", system: "Sei Prova.", prompt: big, mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, authEnv: subscriptionEnvironment("kimi", account) });
    const long = JSON.parse(readFileSync(record, "utf8"));
    assert.ok(long.argv[1].length < 200, "a request over the argument limit travels in the agent file");
    assert.ok(long.agent.includes(big));

    await assert.rejects(runKimi({ bin, model: "k3", system: "S", prompt: "P", mcp: run, toolNames: [], workDir, timeoutMs: 20000, authEnv: { ...subscriptionEnvironment("kimi", account), FIXTURE_MODE: "text-call" } }), /returned no content/);
    const notes = [];
    rmSync(join(root, "attempts"), { force: true });
    const again = await runKimi({ bin, model: "k3", system: "S", prompt: "P", mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, onStep: (step) => notes.push(step), authEnv: { ...subscriptionEnvironment("kimi", account), FIXTURE_MODE: "toolless-once" } });
    assert.equal(again.text, "Fatto: radix.", "a turn Kimi started without Cora's tools is started again");
    assert.equal(notes[0].type, "note");
    assert.ok(!notes.some((step) => step.text === "Non ho strumenti."), "the toolless attempt's words never count");
    await assert.rejects(runKimi({ bin, model: "k3", system: "S", prompt: "P", mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, authEnv: { ...subscriptionEnvironment("kimi", account), FIXTURE_MODE: "toolless" } }), /tools did not load/);
    await assert.rejects(runKimi({ bin, model: "k3", system: "S", prompt: "P", mcp: run, toolNames: [], workDir, timeoutMs: 20000, authEnv: { ...subscriptionEnvironment("kimi", account), FIXTURE_MODE: "fail" } }), /quota exceeded/);
    await assert.rejects(runKimi({ bin, model: "k3", system: "S", prompt: "P", mcp: run, toolNames: [], workDir, timeoutMs: 20000, authEnv: null }), /subscription da collegare/);
  } finally {
    run.dispose();
    await bridge.stop();
  }
  const agent = kimiAgentFile({ system: "S", tools: false });
  assert.match(agent, /tools: \[\]/);
  // npm installs Kimi Code and Pi as Node scripts: they start with Cora's own Node, not the PATH's.
  const mainScript = join(root, "main.mjs");
  writeFileSync(mainScript, "");
  const link = join(root, "kimi-link");
  (await import("node:fs")).symlinkSync(mainScript, link);
  assert.deepEqual(nodeCli(link), { command: process.execPath, args: [mainScript] });
  assert.deepEqual(nodeCli(bin), { command: bin, args: [] }, "a native build starts as it is");
});

test("Pi runs over RPC with Cora's tools only, on the run's key, and reports thoughts and usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "cora-pi-run-"));
  const record = join(root, "seen.json");
  const bin = script(root, "pi", `
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), dir = process.env.PI_CODING_AGENT_DIR;
const keys = Object.keys(process.env).filter((key) => /API_KEY|CORA_PI_KEY/.test(key));
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const command = JSON.parse(input.split("\\n")[0]);
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, keys, key: process.env.DEEPSEEK_API_KEY || process.env.KIMI_API_KEY || process.env.CORA_PI_KEY || "", message: command.message,
    files: Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.lstatSync(path.join(dir, name)).isSymbolicLink() ? "link" : JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))])),
    system: fs.readFileSync(argv[argv.indexOf("--system-prompt") + 1], "utf8"), homeEmpty: fs.readdirSync(process.env.HOME).length === 0 }));
  const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  line({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  line({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 }, content: [{ type: "thinking", thinking: "Serve lo shell." }, { type: "text", text: "Controllo." }, { type: "toolCall", id: "t1", name: "mcp__cora__shell", arguments: {} }] } });
  line({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: "Fatto." }] } });
  line({ type: "agent_settled", aborted: false });
});
process.stdin.on("end", () => process.exit(0));
`);
  const bridge = new ToolBridge();
  await bridge.start();
  const run = bridge.register({ tools: TOOLS, execute: async () => ({ text: "ok" }) });
  const workDir = join(root, "work");
  const steps = [];
  try {
    const out = await runPi({ bin, model: "deepseek/deepseek-flash", system: "Sei Prova.", prompt: "Che host?", mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, onStep: (step) => steps.push(step), apiKey: "fixture-deepseek-key", effort: "high" });
    assert.equal(out.text, "Fatto.");
    assert.deepEqual(out.usage, { in: 350, out: 30 });
    assert.deepEqual(steps, [{ type: "thinking", text: "Serve lo shell." }, { type: "text", text: "Controllo." }]);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "--offline"]) assert.ok(seen.argv.includes(flag), flag);
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf("-e"), seen.argv.indexOf("-e") + 2), ["-e", "builtin:mcp"]);
    assert.equal(seen.argv[seen.argv.indexOf("--tools") + 1], "mcp__cora__*", "Pi's own read, bash and edit never reach the model");
    assert.deepEqual([seen.argv[seen.argv.indexOf("--provider") + 1], seen.argv[seen.argv.indexOf("--model") + 1]], ["deepseek", "deepseek-flash"]);
    assert.equal(seen.argv[seen.argv.indexOf("--thinking") + 1], "high");
    assert.equal(seen.message, "Che host?");
    assert.equal(seen.system, "Sei Prova.");
    assert.equal(seen.homeEmpty, true);
    assert.equal(seen.key, "fixture-deepseek-key");
    assert.deepEqual(seen.keys, ["DEEPSEEK_API_KEY"], "only the run's own key reaches Pi");
    assert.equal(seen.files["mcp.json"].mcpServers.cora.exposure, "direct");
    assert.equal(seen.files["mcp.json"].mcpServers.cora.url, `${run.url}/mcp`);
    assert.equal(seen.files["mcp.json"].mcpServers.cora.headers.Authorization, "Bearer ${CORA_BRIDGE_TOKEN}", "the token stays in the environment");
    assert.equal(seen.files["mcp.json"].autoEnableCodemode, false);
    assert.deepEqual(readdirSync(workDir), []);

    // A Pi account's login is linked from the account, so Pi's refresh writes back there.
    const account = join(root, "pi-account");
    mkdirSync(account);
    writeFileSync(join(account, "auth.json"), "{}");
    await runPi({ bin, model: "anthropic/claude-sonnet-5-5", system: "S", prompt: "P", mcp: run, toolNames: TOOLS.map((tool) => tool.name), workDir, timeoutMs: 20000, agentDir: account });
    const signed = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(signed.files["auth.json"], "link");
    assert.deepEqual(signed.keys, [], "a signed-in service needs no key");
    await assert.rejects(runPi({ bin, model: "anthropic/claude-sonnet-5-5", system: "S", prompt: "P", mcp: run, toolNames: [], workDir, timeoutMs: 20000 }), /subscription da collegare/);
    await assert.rejects(runPi({ bin, model: "deepseek/deepseek-flash", system: "S", prompt: "P", mcp: run, toolNames: [], workDir, timeoutMs: 20000 }), /chiave API non trovata/);
  } finally {
    run.dispose();
    await bridge.stop();
  }
  const files = piFiles({ backend: "ollama", model: "glm-5:cloud", tools: false });
  assert.equal(files["models.json"].providers.ollama.apiKey, "${CORA_PI_KEY}", "the key reaches Pi only as an environment variable");
  assert.deepEqual(files["mcp.json"].mcpServers, {});
  assert.equal(piFiles({ backend: "kimi", model: "k3", relayUrl: "http://127.0.0.1:1/relay" })["models.json"].providers["kimi-coding"].baseUrl, "http://127.0.0.1:1/relay/v1");
});

test("the bridge serves a run's tools as an MCP server over HTTP, to that run only", async () => {
  const bridge = new ToolBridge();
  await bridge.start();
  const calls = [];
  const run = bridge.register({ tools: TOOLS, execute: async (name, args) => { calls.push([name, args]); return { text: name === "shell" ? "radix" : "error: refused" }; } });
  const rpc = (body, token = run.token) => fetch(`${bridge.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  try {
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["say", "shell"]);
    assert.ok(list.result.tools.every((tool) => tool.inputSchema.type === "object"));
    const called = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shell", arguments: { command: "hostname" } } })).json();
    assert.deepEqual(called.result, { content: [{ type: "text", text: "radix" }], isError: false });
    assert.deepEqual(calls, [["shell", { command: "hostname" }]]);
    assert.equal((await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "say", arguments: {} } })).json()).result.isError, true);
    assert.equal((await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm", arguments: {} } })).json()).result.isError, true, "only the run's own tools");
    assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list" }, "wrong")).status, 401);
    run.dispose();
    assert.equal((await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" })).status, 401, "the server dies with the run");
  } finally {
    await bridge.stop();
  }
});

test("the relay gives a run's CLI Kimi's endpoint with the account's fresh token, and nothing to anyone else", async () => {
  const seen = [];
  const upstream = (await import("node:http")).createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers["x-api-key"] || "", body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: [DONE]\n\n"), 20);
    });
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const bridge = new ToolBridge();
  await bridge.start();
  let token = "account-token-1";
  const run = bridge.register({ relay: { base: `http://127.0.0.1:${upstream.address().port}/coding`, token: async () => token } });
  try {
    const response = await fetch(`${run.relayUrl}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${run.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "k3" }) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: one\n\ndata: [DONE]\n\n");
    assert.deepEqual(seen.at(-1), { url: "/coding/v1/chat/completions", auth: "Bearer account-token-1", key: "", body: JSON.stringify({ model: "k3" }) });
    token = "account-token-2";
    const byKey = await fetch(`${run.relayUrl}/v1/models`, { headers: { "x-api-key": run.token } });
    assert.equal(byKey.status, 200);
    assert.equal(seen.at(-1).auth, "Bearer account-token-2", "every request gets the token as it is now");
    assert.equal((await fetch(`${run.relayUrl}/v1/models`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const before = seen.length;
    assert.notEqual((await fetch(`${bridge.url}/relay%2F..%2Fadmin`, { headers: { Authorization: `Bearer ${run.token}` } })).status, 200);
    assert.equal(seen.length, before, "nothing outside the relay's path is forwarded");
    const plain = bridge.register({ tools: TOOLS, execute: async () => ({ text: "" }) });
    assert.equal((await fetch(`${run.relayUrl}/v1/models`, { headers: { Authorization: `Bearer ${plain.token}` } })).status, 401, "a run without a relay reaches no endpoint");
    plain.dispose();
    run.dispose();
    assert.equal((await fetch(`${run.relayUrl}/v1/models`, { headers: { Authorization: `Bearer ${run.token}` } })).status, 401, "the relay dies with the run");
  } finally {
    await bridge.stop();
    await new Promise((done) => upstream.close(done));
  }
});

test("a Kimi Code account signs in with kimi.ai's device code, says who it is, lists its models and runs Hermes and Pi through the relay", async (t) => {
  const home = tempHome();
  const bins = mkdtempSync(join(tmpdir(), "cora-kimi-bins-"));
  const control = join(bins, "control.json");
  writeFileSync(control, JSON.stringify({ complete: false }));
  const kimi = script(bins, "kimi", `
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), home = process.env.KIMI_CODE_HOME;
if (argv[0] === "login") {
  if (!argv.includes("global")) process.exit(3);
  process.stderr.write("\\nOpening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=TEST-ONLY\\nIf the browser did not open, paste the URL above and enter code: TEST-ONLY\\nWaiting for authorization to complete…\\n");
  const timer = setInterval(() => {
    if (!JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8")).complete) return;
    clearInterval(timer);
    fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), 'base_url = "https://api.kimi.ai/coding/v1"\\n');
    fs.writeFileSync(path.join(home, "credentials", "kimi-code-env-x.json"), JSON.stringify({ access_token: "fixture-access-1", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 }));
    process.stdout.write("Logged in to managed:kimi-code.\\n");
    process.exit(0);
  }, 50);
}
`);
  const hermesSeen = join(bins, "hermes.json");
  const hermes = script(bins, "hermes", `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const config = fs.readFileSync(process.env.HERMES_HOME + "/config.yaml", "utf8");
fs.writeFileSync(${JSON.stringify(hermesSeen)}, JSON.stringify({ argv, config, key: process.env.CORA_ENDPOINT_KEY || "" }));
const base = config.match(/base_url: "([^"]+)"/)[1];
fetch(base + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + process.env.CORA_ENDPOINT_KEY, "Content-Type": "application/json" }, body: "{}" })
  .then((response) => response.json()).then((data) => { process.stdout.write(data.answer + "\\n"); process.exit(0); });
`);
  const api = kimiApi();
  const relayed = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/chat/completions")) {
      relayed.push({ url: String(url), auth: init.headers.Authorization });
      return new Response(JSON.stringify({ answer: "Hermes su Kimi" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return api.fetchImpl(url, init);
  };
  const realFetch = globalThis.fetch;
  // The relay's own upstream call goes through the global fetch: the fixture answers there for kimi.ai only.
  globalThis.fetch = (url, init) => (String(url).includes("api.kimi.ai") ? fetchImpl(url, init) : realFetch(url, init));
  t.after(() => { globalThis.fetch = realFetch; });
  const app = startCora({ home, host: "127.0.0.1", port: 0, insecureCookies: true, adminPassword: "fixture-password", sessionKey: "fixture-session",
    discordToken: "", telegramToken: "", ollamaKey: "", orcaKey: "", cloudUrl: "", cloudKey: "", cloudSpace: "",
    claudeBin: "/missing/claude", codexBin: "/missing/codex", grokBin: "/missing/grok", museBin: "/missing/muse", geminiBin: "/missing/agy", piBin: "/missing/pi",
    kimiBin: kimi, hermesBin: hermes, kimiFetch: fetchImpl, residentDirectories: { kimi: join(home, "no-resident-kimi") }, botTokenFor: () => "",
    docker: fakeDocker().path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys" });
  await app.ready;
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await realFetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ password: "fixture-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await realFetch(`${base}${path}`, { method, headers: { Cookie: cookie, "X-Cora": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const state = (await request("/api/state")).data;
  assert.equal(state.providers.kimi, true);
  assert.equal(state.providers.pi, false);
  const created = await request("/api/subscriptions", { method: "POST", body: { provider: "kimi", label: "Kimi" } });
  assert.equal(created.status, 201);
  const started = await request(`/api/subscriptions/${created.data.id}/login`, { method: "POST" });
  assert.equal(started.data.status, "connecting");
  assert.equal(started.data.login.url, "https://www.kimi.ai/code/authorize_device?user_code=TEST-ONLY");
  assert.equal(started.data.login.userCode, "TEST-ONLY");
  assert.equal(started.data.login.manualCode, false);
  writeFileSync(control, JSON.stringify({ complete: true }));
  await waitFor(() => app.store.subscription(created.data.id).status === "ready", { what: "Kimi account ready" });
  assert.equal(app.store.subscription(created.data.id).email, "owner@example.test");
  assert.equal(app.store.subscription(created.data.id).plan, "Plus");
  const models = await app.llm.listModels({ fresh: true });
  assert.deepEqual(models.filter((model) => model.provider === "kimi").map((model) => model.id), ["kimi/k3", "kimi/kimi-for-coding"]);
  assert.deepEqual(models.filter((model) => model.provider === "hermes" && model.backend === "kimi").map((model) => model.id), ["hermes/kimi/k3", "hermes/kimi/kimi-for-coding"]);

  const agent = await request("/api/agents", { method: "POST", body: { name: "Kimo", model: "hermes/kimi/k3", subscriptionId: created.data.id, tools: false } });
  assert.equal(agent.status, 201);
  const result = await app.llm.runAgent({ model: "hermes/kimi/k3", subscriptionId: created.data.id, tools: [], system: "S", prompt: "P", timeoutMs: 15000 });
  assert.equal(result.text, "Hermes su Kimi");
  const seen = JSON.parse(readFileSync(hermesSeen, "utf8"));
  assert.match(seen.config, /base_url: "http:\/\/127\.0\.0\.1:\d+\/relay\/v1"/, "Hermes talks to Cora's relay");
  assert.doesNotMatch(seen.config + seen.key, /fixture-access/, "the account's token never reaches Hermes");
  assert.equal(relayed.at(-1).url, "https://api.kimi.ai/coding/v1/chat/completions");
  assert.equal(relayed.at(-1).auth, "Bearer fixture-access-1");

  assert.equal((await request(`/api/subscriptions/${created.data.id}`, { method: "DELETE" })).status, 400, "an account an agent uses stays");
  await request(`/api/agents/${agent.data.id}`, { method: "DELETE" });
  assert.equal((await request(`/api/subscriptions/${created.data.id}`, { method: "DELETE" })).status, 200);
  assert.ok(!existsSync(join(home, "subscriptions", created.data.id)), "removing the account removes its login");
});
