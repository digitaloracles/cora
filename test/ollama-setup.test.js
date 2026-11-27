import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { INSTALL_COMMAND, machineInfo, ollamaBinary, runOllamaSetup, setupScript, setupState } from "../src/ollama-setup.js";

test("Ollama is looked for on the PATH, and on a Mac also as the app", () => {
  const only = (files) => (file) => files.includes(file);
  assert.equal(ollamaBinary({ platform: "linux", path: "/opt/x:/usr/local/bin", exists: only(["/usr/local/bin/ollama"]) }), "/usr/local/bin/ollama");
  assert.equal(ollamaBinary({ platform: "linux", path: "/usr/bin", exists: only([]) }), "", "nothing installed is nothing found");
  assert.equal(ollamaBinary({ platform: "darwin", path: "/usr/bin", home: "/Users/sam", exists: only(["/Users/sam/Applications/Ollama.app"]) }),
    "/Users/sam/Applications/Ollama.app/Contents/Resources/ollama", "the app without the /usr/local/bin link still counts");
});

test("the panel offers to install only an Ollama this machine serves itself, on Linux or macOS", () => {
  assert.deepEqual(setupState({ url: "http://127.0.0.1:11434", reachable: false, platform: "linux", binary: "" }),
    { installed: false, running: false, installable: true, command: INSTALL_COMMAND });
  assert.equal(setupState({ url: "http://localhost:11434", platform: "darwin", binary: "/Applications/Ollama.app/Contents/Resources/ollama" }).installed, true);
  assert.equal(setupState({ url: "http://192.168.1.20:11434", platform: "linux", binary: "" }).installable, false, "an Ollama on another machine is not installed from here");
  assert.equal(setupState({ url: "http://127.0.0.1:11434", platform: "win32", binary: "" }).installable, false);
  assert.equal(INSTALL_COMMAND, "curl -fsSL https://ollama.com/install.sh | sh");
});

test("each system gets its own way to install and to start", () => {
  assert.match(setupScript("linux", "install"), /ollama\.com\/install\.sh/);
  assert.match(setupScript("linux", "install"), /apt-get install -y -q zstd/, "the script stops without zstd, so it comes first");
  assert.match(setupScript("linux", "start"), /systemctl enable --now ollama/);
  assert.match(setupScript("linux", "install"), /"\$OLLAMA" serve/, "without systemd the script installs but starts nothing");
  assert.match(setupScript("darwin", "install"), /Ollama-darwin\.zip/);
  assert.doesNotMatch(setupScript("darwin", "install"), /sudo/, "on a Mac nothing waits for a password nobody can type");
  assert.match(setupScript("darwin", "start"), /open -a/);
  assert.equal(setupScript("win32", "install"), "");
});

test("the machine is described even without a card", () => {
  const machine = machineInfo({ platform: "linux", arch: "x64", cpuList: [{ model: "AMD  Ryzen 9 7950X " }, {}], memory: 64 * 1024 ** 3 });
  assert.deepEqual(machine, { platform: "linux", arch: "x64", cpu: "AMD Ryzen 9 7950X", cores: 2, ram: 65536 });
});

test("an install follows the script line by line, and says why it failed", async () => {
  const fake = (body) => (cmd, args, options) => spawn("sh", ["-c", body], options);
  const lines = [];
  const done = await runOllamaSetup({ platform: "linux", url: "http://127.0.0.1:11434", elevate: () => true, onLine: (line) => lines.push(line),
    spawnFn: fake("echo '>>> Downloading ollama' >&2; printf '###### 42.0%%\\r#=#=#\\n##O#-#\\n'; echo '>>> Install complete'"), answers: async () => "0.40.18" });
  assert.deepEqual(done, { ok: true, version: "0.40.18" });
  assert.deepEqual(lines.sort(), [">>> Downloading ollama", ">>> Install complete"], "curl's progress bar is not a message");

  const failed = await runOllamaSetup({ platform: "linux", url: "http://127.0.0.1:11434", elevate: () => true,
    spawnFn: fake("echo '>>> Downloading'; echo 'ERROR: Unsupported architecture: mips'; exit 1"), answers: async () => "x" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Unsupported architecture/);

  const silent = await runOllamaSetup({ platform: "darwin", url: "http://127.0.0.1:11434", spawnFn: fake("true"), answers: async () => "" });
  assert.match(silent.error, /non risponde ancora/, "installed is not enough: it has to answer");

  const locked = await runOllamaSetup({ platform: "linux", url: "http://127.0.0.1:11434", elevate: () => false, spawnFn: () => assert.fail("never started") });
  assert.match(locked.error, /sudo senza password.*install\.sh/, "without root it says what to run by hand");
  assert.match((await runOllamaSetup({ platform: "win32" })).error, /Linux e macOS/);
});
