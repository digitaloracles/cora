import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessUpdates, compareVersions, parseVersion } from "../src/harness-updates.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

function memoryStore(settings = {}) {
  const values = new Map();
  return { settings: { harnessAutoUpdate: true, ...settings }, value: (key, fallback) => values.has(key) ? values.get(key) : fallback, setValue: (key, value) => values.set(key, structuredClone(value)), values };
}

function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A machine with one CLI and the tools that update it, all fakes that log what they are asked. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "cora-harness-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.log");
  const version = join(root, "version");
  writeFileSync(log, "");
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const registry = { "@openai/codex": "0.170.0", "@xai-official/grok": "1.0.89", "@anthropic-ai/claude-code": "2.1.327" };
  const fetchImpl = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
    return registry[name] ? new Response(JSON.stringify({ version: registry[name] })) : new Response("{}", { status: 404 });
  };
  return { root, bin, log, version, calls, registry, fetchImpl, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } };
}

test("harness versions are parsed from what each CLI prints and compared with prereleases first", () => {
  assert.equal(parseVersion("codex-cli 0.164.0"), "0.164.0");
  assert.equal(parseVersion("grok 1.0.89 (28be5bb1bf65) [alpha]"), "1.0.89");
  assert.equal(parseVersion("Hermes Agent v0.21.0 (2026.8.31)"), "0.21.0");
  assert.equal(parseVersion("0.2.1-rc.5"), "0.2.1-rc.5");
  assert.equal(compareVersions("0.164.0", "0.170.0"), -1);
  assert.equal(compareVersions("2.1.327", "2.1.322"), 1);
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.2-rc.1"), -1);
  assert.equal(compareVersions("0.2.2-rc.1", "0.2.2"), -1);
  assert.equal(compareVersions("0.2.2-rc.10", "0.2.2-rc.9"), 1);
  assert.equal(compareVersions("1.0.89", "1.0.89"), 0);
});

test("a CLI installed with npm under a prefix is upgraded there, its catalog is asked again, and a busy one waits", async () => {
  const m = machine();
  const prefix = join(m.root, "clis");
  const pkg = join(prefix, "lib", "node_modules", "@openai", "codex", "bin");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(prefix, "bin"));
  writeFileSync(m.version, "0.164.0");
  script(join(pkg, "codex.js"), `echo "codex-cli $(cat ${m.version})"`);
  symlinkSync(join(pkg, "codex.js"), join(prefix, "bin", "codex"));
  script(join(m.bin, "npm"), `echo "npm $*" >> ${m.log}\necho 0.170.0 > ${m.version}`);
  const changed = [];
  let busy = true;
  const store = memoryStore();
  const updates = new HarnessUpdates({ store, bins: { codex: join(prefix, "bin", "codex") }, env: m.env, fetchImpl: m.fetchImpl, busy: () => busy, changed: (provider) => changed.push(provider) });

  let state = await updates.checkOne("codex");
  assert.equal(state.state, "deferred", "a CLI rewritten in place waits while a turn runs on it");
  assert.equal(state.version, "0.164.0");
  assert.equal(state.latest, "0.170.0");
  assert.deepEqual(m.calls(), []);

  busy = false;
  state = await updates.checkOne("codex");
  assert.equal(state.state, "current");
  assert.equal(state.version, "0.170.0");
  assert.equal(state.previous, "0.164.0");
  assert.equal(state.method, "npm");
  assert.deepEqual(m.calls(), [`npm install -g --prefix ${prefix} @openai/codex@0.170.0`]);
  assert.deepEqual(changed, ["codex"], "the model catalog is read again with the new CLI");
  assert.equal(store.values.get("harnessVersions").codex.version, "0.170.0", "the state survives a restart");
  assert.ok(!("path" in updates.status().find((item) => item.provider === "codex")), "the panel never sees where the CLI lives on the server");

  state = await updates.checkOne("codex");
  assert.equal(state.state, "current");
  assert.equal(m.calls().length, 1, "a current CLI is not reinstalled");
});

test("a mise wrapper is upgraded through mise even during a turn, and grok relinks the binary its launcher copied", async () => {
  const m = machine();
  writeFileSync(m.version, "1.0.70");
  const grokHome = join(m.root, ".grok");
  mkdirSync(join(grokHome, "bin"), { recursive: true });
  writeFileSync(join(grokHome, "bin", "grok-1.0.70"), "");
  symlinkSync("grok-1.0.70", join(grokHome, "bin", "grok"));
  const wrapper = join(m.root, "grok");
  script(wrapper, `export MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "npm:@xai-official/grok" || exit 1\nexec mise x "npm:@xai-official/grok" -- "grok" "$@"`);
  script(join(m.bin, "mise"), `echo "mise $* age=$MISE_MINIMUM_RELEASE_AGE" >> ${m.log}
case "$1" in
  upgrade) echo 1.0.89 > ${m.version} ;;
  x) echo "grok $(cat ${m.version}) (abc) [stable]" ;;
esac`);
  const updates = new HarnessUpdates({ store: memoryStore(), bins: { grok: wrapper }, env: m.env, grokHome, fetchImpl: m.fetchImpl, busy: () => true });
  const state = await updates.checkOne("grok");
  assert.equal(state.method, "mise");
  assert.equal(state.state, "current");
  assert.equal(state.version, "1.0.89");
  assert.ok(m.calls().includes("mise upgrade npm:@xai-official/grok age=0"), "mise installs the new version beside the one running turns use");
  assert.ok(!existsSync(join(grokHome, "bin", "grok")), "the old link is dropped so the launcher copies the new binary");
  assert.ok(lstatSync(join(grokHome, "bin", "grok-1.0.70")).isFile(), "the binary a running turn may use stays");
});

test("a failed upgrade keeps the old version with its error, and with automatic updates off nothing is installed", async () => {
  const m = machine();
  const prefix = join(m.root, "clis");
  const pkg = join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(prefix, "bin"));
  writeFileSync(m.version, "2.1.322");
  script(join(pkg, "cli.js"), `echo "$(cat ${m.version}) (Claude Code)"`);
  symlinkSync(join(pkg, "cli.js"), join(prefix, "bin", "claude"));
  script(join(m.bin, "npm"), `echo "npm $*" >> ${m.log}\necho "npm error code EACCES" >&2\nexit 243`);
  const changed = [];
  const store = memoryStore();
  const updates = new HarnessUpdates({ store, bins: { claude: join(prefix, "bin", "claude") }, env: m.env, fetchImpl: m.fetchImpl, changed: (provider) => changed.push(provider) });

  const failed = await updates.checkOne("claude");
  assert.equal(failed.state, "failed");
  assert.equal(failed.version, "2.1.322");
  assert.match(failed.error, /EACCES/);
  assert.deepEqual(changed, []);

  const before = m.calls().length;
  store.settings.harnessAutoUpdate = false;
  const listed = (await updates.checkAll()).find((item) => item.provider === "claude");
  assert.equal(listed.state, "outdated", "the panel still says it is behind");
  assert.equal(m.calls().length, before, "nothing installed while the owner keeps automatic updates off");
  const missing = (await updates.checkAll()).find((item) => item.provider === "codex");
  assert.equal(missing.state, "missing");
});

test("the panel shows each harness's version and only the owner starts a check", async (t) => {
  const store = { calls: 0 };
  const fake = {
    status: () => [{ provider: "codex", product: "Codex", version: "0.170.0", latest: "0.170.0", state: "current", method: "mise" }],
    version: (provider) => provider === "codex" ? "0.170.0" : "",
    checkAll: async () => { store.calls += 1; return fake.status(); },
    start() {}, stop() {},
  };
  const f = await knowledgeWorld({ harnessUpdates: fake });
  t.after(() => f.close());
  const state = await f.request(f.admin, "/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.harnesses.map((item) => [item.provider, item.version, item.state]), [["codex", "0.170.0", "current"]]);
  assert.equal(state.data.settings.harnessAutoUpdate, true, "automatic updates are on by default");

  const refused = await f.request(f.alice, "/api/harnesses/check", { method: "POST" });
  assert.equal(refused.status, 403, "a member does not upgrade the server's programs");
  assert.equal(store.calls, 0);
  const checked = await f.request(f.admin, "/api/harnesses/check", { method: "POST" });
  assert.equal(checked.status, 200);
  assert.equal(store.calls, 1);

  const off = await f.request(f.admin, "/api/settings", { method: "PUT", body: { harnessAutoUpdate: false } });
  assert.equal(off.status, 200);
  assert.equal(off.data.harnessAutoUpdate, false);
  assert.equal(f.app.store.settings.harnessAutoUpdate, false);
});

test("a manual update queued behind a read-only check still installs once", async () => {
  const m = machine();
  const pkg = join(m.root, "node_modules", "@openai", "codex");
  mkdirSync(pkg, { recursive: true });
  const cli = join(pkg, "codex");
  writeFileSync(m.version, "0.164.0");
  script(cli, 'cat "' + m.version + '"');
  script(join(m.bin, "npm"), 'echo install >> "' + m.log + '"\necho 0.170.0 > "' + m.version + '"');
  let release;
  const pendingRegistry = new Promise((resolve) => { release = resolve; });
  const updates = new HarnessUpdates({
    store: memoryStore({ harnessAutoUpdate: false }),
    bins: { codex: cli },
    env: m.env,
    fetchImpl: async (url) => { await pendingRegistry; return m.fetchImpl(url); },
  });
  const checkOnly = updates.checkAll();
  const manual = updates.checkAll({ update: true, waitForTurns: true });
  assert.equal(updates.checkAll({ update: true, waitForTurns: true }), manual);
  release();
  assert.equal((await checkOnly).find((item) => item.provider === "codex").state, "outdated");
  assert.equal((await manual).find((item) => item.provider === "codex").version, "0.170.0");
  assert.deepEqual(m.calls(), ["install"]);
});
