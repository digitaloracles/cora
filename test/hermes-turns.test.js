import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolBridge } from "../src/bridge.js";
import { runHermes } from "../src/cli.js";
import { HarnessUpdates } from "../src/harness-updates.js";
import { LLM } from "../src/llm.js";
import { processesWithEnv } from "../src/process-scan.js";

/**
 * A Hermes that behaves like 0.23: the first one-shot run on a home starts a detached gateway
 * with that run's environment, and later runs on the same home go through it.
 */
function gatewayHermes(root) {
  const bin = join(root, "hermes");
  writeFileSync(bin, `#!/usr/bin/env python3
import json, os, subprocess, sys, urllib.error, urllib.request
home = os.environ["HERMES_HOME"]
record = os.path.join(home, "gateway.json")
def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
token = None
if os.path.exists(record):
    data = json.load(open(record))
    if alive(data["pid"]):
        token = data["token"]
if token is None:
    gateway = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token = os.environ["CORA_BRIDGE_TOKEN"]
    json.dump({"pid": gateway.pid, "token": token}, open(record, "w"))
    open(os.environ["FAKE_HERMES_LOG"], "a").write(str(gateway.pid) + "\\n")
request = urllib.request.Request(os.environ["CORA_BRIDGE_URL"] + "/tools/call", data=json.dumps({"name": "whoami", "arguments": {}}).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}, method="POST")
try:
    print(json.load(urllib.request.urlopen(request))["text"])
except urllib.error.HTTPError as error:
    print("HTTP %d" % error.code)
`);
  chmodSync(bin, 0o755);
  return bin;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("each Hermes turn runs on a home of its own, so a gateway Hermes leaves running never lends one turn's tools to the next", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cora-hermes-turns-"));
  const log = join(root, "gateways.log");
  writeFileSync(log, "");
  process.env.FAKE_HERMES_LOG = log;
  t.after(() => { delete process.env.FAKE_HERMES_LOG; });
  const bin = gatewayHermes(root);
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const calls = [];
  const session = (who) => bridge.register({ tools: [{ name: "whoami", description: "Who calls", parameters: { type: "object", properties: {} } }], execute: async () => { calls.push(who); return { text: `who=${who}` }; } });
  const first = session("A"), second = session("B");
  t.after(() => { first.dispose(); second.dispose(); });
  const home = join(root, "hermes-home-model");
  const turn = (mcp) => runHermes({ bin, model: "fixture", system: "System", prompt: "Who?", mcp, toolNames: ["whoami"], workDir: join(root, "work"), timeoutMs: 20000, home, baseUrl: "http://127.0.0.1:1/v1" });

  assert.equal((await turn(first)).text, "who=A");
  assert.equal((await turn(second)).text, "who=B", "the second turn calls with its own token, not the first turn's");
  const [one, two] = await Promise.all([turn(first), turn(second)]);
  assert.deepEqual([one.text, two.text], ["who=A", "who=B"]);
  assert.deepEqual(calls.sort(), ["A", "A", "B", "B"]);

  const gateways = readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number);
  assert.equal(gateways.length, 4, "every turn started its own gateway");
  assert.deepEqual(gateways.filter(alive), [], "no gateway outlives its turn");
  assert.deepEqual(readdirSync(join(home, "turns")), [], "the turn homes are removed");
  assert.match(readFileSync(join(home, "config.yaml"), "utf8"), /cora-tools/, "the shared home keeps the configuration the turns copy");
});

test("an update from the panel stops a busy Hermes, updates it and starts the stopped turn again on the new version", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cora-hermes-stop-"));
  // Cora's server keeps the event loop alive; here only the waits of the update would.
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const head = join(root, "head");
  const calls = join(root, "calls.log");
  writeFileSync(head, "aaaaaaa1");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "hermes"), [
    "#!/bin/sh",
    `echo "$1 $2" >> ${calls}`,
    `if [ "$1" = "--version" ]; then echo "Hermes Agent v0.23.3 (2026.9.24) · upstream $(cat ${head})"; exit 0; fi`,
    `if [ "$1" = "update" ] && [ "$2" = "--check" ]; then if [ "$(cat ${head})" = "bbbbbbb2" ]; then echo "Already up to date."; else echo "Update available: 2 commits behind origin/main."; fi; exit 0; fi`,
    `if [ "$1" = "update" ] && [ "$2" = "--yes" ]; then echo bbbbbbb2 > ${head}; exit 0; fi`,
    // A turn: on the old version it hangs, as a long turn would; on the new one it answers.
    `if [ "$(cat ${head})" = "aaaaaaa1" ]; then exec sleep 60; fi`,
    `case "$2" in *"stopped halfway"*) echo "restarted on new" ;; *) echo "fresh on new" ;; esac`,
  ].join("\n"));
  chmodSync(join(bin, "hermes"), 0o755);
  const home = join(root, "hermes-home");
  const llm = new LLM({
    ollamaUrl: "http://127.0.0.1:1", ollamaKey: "", orcaKey: "", hermesBin: join(bin, "hermes"), hermesHome: home, hermesBaseUrl: "http://127.0.0.1:1/v1",
    claudeBin: "/missing/claude", codexBin: "/missing/codex", grokBin: "/missing/grok", museBin: "/missing/muse", geminiBin: "/missing/agy",
    cliWorkDir: join(root, "work"), bridge: { register() { return null; } },
  });
  llm.contextLength = async () => 0;
  const updates = new HarnessUpdates({
    store: { settings: { harnessAutoUpdate: true }, value: (_key, fallback) => fallback, setValue() {} },
    bins: { hermes: "hermes" }, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    busy: (provider) => llm.harnessBusy(provider), interrupt: (provider) => llm.interruptHarness(provider), homes: { hermes: home },
  });
  llm.harnessInstallation = (provider) => updates.installation(provider);
  const steps = [];
  const answer = llm.runAgent({ model: "hermes/fixture", tools: [], system: "System", prompt: "Work", timeoutMs: 30000, onStep: (step) => steps.push(step) });
  for (let i = 0; i < 100 && !llm.harnessBusy("hermes"); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(llm.harnessBusy("hermes"), true);

  const automatic = await updates.checkOne("hermes", { update: true });
  assert.equal(automatic.state, "deferred", "the automatic update still waits for the turns");
  assert.equal(llm.harnessBusy("hermes"), true);

  const started = Date.now();
  const manual = await updates.checkAll({ update: true, waitForTurns: true });
  assert.equal(manual.find((item) => item.provider === "hermes").state, "current");
  assert.equal(manual.find((item) => item.provider === "hermes").version, "0.23.3 · bbbbbbb2");
  assert.ok(Date.now() - started < 20000, "the button does not wait for the turn to end by itself");
  assert.equal((await answer).text, "restarted on new", "the stopped turn starts again on the new version and is told it was stopped");
  assert.ok(steps.some((step) => step.type === "note" && /riparte sulla nuova versione/.test(step.text)));
  assert.equal(llm.harnessBusy("hermes"), false);
  assert.deepEqual(processesWithEnv("HERMES_HOME", (value) => value.startsWith(home)), []);
});
