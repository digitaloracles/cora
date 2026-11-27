import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

/** What a person types to install Ollama by hand: the official script, for Linux and macOS alike. */
export const INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

const MiB = 1_048_576;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/** The machine itself, for a panel that has no card or no Ollama to talk about yet. */
export function machineInfo({ platform = process.platform, arch = process.arch, cpuList = cpus(), memory = totalmem() } = {}) {
  return {
    platform, arch,
    cpu: String(cpuList[0]?.model || "").replace(/\s+/g, " ").trim(),
    cores: cpuList.length,
    ram: Math.round(memory / MiB),
  };
}

/** Where the ollama binary is, or "" when this machine has none. */
export function ollamaBinary({ platform = process.platform, path = process.env.PATH, exists = existsSync, home = homedir() } = {}) {
  const dirs = [...String(path || "").split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"];
  for (const dir of new Set(dirs)) if (exists(join(dir, "ollama"))) return join(dir, "ollama");
  if (platform === "darwin") {
    for (const app of ["/Applications/Ollama.app", join(home, "Applications", "Ollama.app")]) {
      if (exists(app)) return join(app, "Contents", "Resources", "ollama");
    }
  }
  return "";
}

/**
 * Whether the panel may install or start Ollama here: only for an Ollama this
 * machine serves on its own loopback, on Linux or macOS, which the official script covers.
 */
export function setupState({ url = "", reachable = false, platform = process.platform, binary = ollamaBinary({ platform }) } = {}) {
  const supported = platform === "linux" || platform === "darwin";
  const here = LOOPBACK.test(String(url));
  return {
    installed: Boolean(binary),
    running: Boolean(reachable),
    installable: supported && here,
    command: INSTALL_COMMAND,
  };
}

/** Root, or a sudo that never asks: the Linux script writes /usr and a systemd unit. */
export function canElevate({ uid = process.getuid?.() ?? -1, run = spawnSync } = {}) {
  if (uid === 0) return true;
  try {
    return run("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

// macOS: the steps of the official script, without the /usr/local/bin link that wants
// a password, and into ~/Applications when /Applications is not writable.
const MAC_INSTALL = `set -eu
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo ">>> Scarico Ollama per macOS"
curl -fsSL -o "$T/Ollama-darwin.zip" https://ollama.com/download/Ollama-darwin.zip
unzip -q "$T/Ollama-darwin.zip" -d "$T"
DEST=/Applications; [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
echo ">>> Installo Ollama in $DEST"
rm -rf "$DEST/Ollama.app"; mv "$T/Ollama.app" "$DEST/"
echo ">>> Avvio Ollama"
if ! open -a "$DEST/Ollama.app" --args hidden; then
  nohup "$DEST/Ollama.app/Contents/Resources/ollama" serve </dev/null >/dev/null 2>&1 &
fi
`;

const MAC_START = `set -eu
APP=/Applications/Ollama.app; [ -d "$APP" ] || APP="$HOME/Applications/Ollama.app"
echo ">>> Avvio Ollama"
BIN="$APP/Contents/Resources/ollama"; [ -d "$APP" ] || BIN=ollama
if ! { [ -d "$APP" ] && open -a "$APP" --args hidden; }; then
  nohup "$BIN" serve </dev/null >/dev/null 2>&1 &
fi
`;

const LINUX_INSTALL = `set -eu
T=$(mktemp); trap 'rm -f "$T"' EXIT
SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo
# The script unpacks with zstd and stops when it is missing: install it first.
if ! command -v zstd >/dev/null 2>&1; then
  echo ">>> Installo zstd, che serve allo script di Ollama"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q zstd || { $SUDO apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q zstd; }
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y zstd
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y zstd
  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -S --noconfirm --needed zstd
  elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install zstd
  elif command -v apk >/dev/null 2>&1; then $SUDO apk add zstd
  fi
fi
echo ">>> Scarico lo script ufficiale di Ollama"
curl -fsSL https://ollama.com/install.sh -o "$T"
sh "$T"
# Without systemd the script installs but starts nothing: serve it from here.
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl is-active --quiet ollama 2>/dev/null; then
  echo ">>> Avvio ollama serve"
  OLLAMA=$(command -v ollama || echo /usr/local/bin/ollama)
  nohup "$OLLAMA" serve </dev/null >/dev/null 2>&1 &
fi
`;

const LINUX_START = `set -eu
if command -v systemctl >/dev/null 2>&1 && systemctl cat ollama >/dev/null 2>&1; then
  echo ">>> Avvio il servizio ollama"
  sudo systemctl enable --now ollama
else
  echo ">>> Avvio ollama serve"
  OLLAMA=$(command -v ollama || echo /usr/local/bin/ollama)
  nohup "$OLLAMA" serve </dev/null >/dev/null 2>&1 &
fi
`;

export function setupScript(platform, action) {
  if (platform === "darwin") return action === "start" ? MAC_START : MAC_INSTALL;
  if (platform === "linux") return action === "start" ? LINUX_START : LINUX_INSTALL;
  return "";
}

const clean = (line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();

/**
 * Install (or start) Ollama on this machine and wait until it answers. Each line the
 * script prints goes to onLine; a sudo that would ask for a password fails at once.
 */
export async function runOllamaSetup({ action = "install", url, platform = process.platform, onLine = () => {}, elevate = canElevate, spawnFn = spawn, answers = defaultAnswers, waitMs = 90000, timeoutMs = 20 * 60000 } = {}) {
  const script = setupScript(platform, action);
  if (!script) return { ok: false, error: "si installa da qui solo su Linux e macOS" };
  if (platform === "linux" && !elevate()) {
    return { ok: false, error: `serve root o sudo senza password: sul server lancia ${INSTALL_COMMAND}` };
  }
  const shim = mkdtempSync(join(tmpdir(), "cora-ollama-"));
  const realSudo = ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo"].find((file) => existsSync(file));
  if (realSudo) {
    writeFileSync(join(shim, "sudo"), `#!/bin/sh\nexec ${realSudo} -n "$@"\n`);
    chmodSync(join(shim, "sudo"), 0o755);
  }
  const tail = [];
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${shim}:${process.env.PATH || "/usr/bin:/bin"}` } });
    } catch (error) {
      tail.push(error.message);
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    const read = (stream) => {
      let buffer = "";
      stream?.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\n|\r(?!\n)/);
        buffer = lines.pop() || "";
        for (const raw of lines) {
          const line = clean(raw);
          // curl's progress bar is a line of hashes and a percentage: not worth a message each.
          if (!line || /^[#=O\s-]*(\d+(\.\d+)?%)?$/.test(line) || /^\(Reading database \.\.\. \d+%$/.test(line)) continue;
          tail.push(line);
          if (tail.length > 8) tail.shift();
          onLine(line);
        }
      });
    };
    read(child.stdout);
    read(child.stderr);
    child.on("error", (error) => { tail.push(error.message); });
    child.on("close", (status) => { clearTimeout(timer); resolve(status ?? -1); });
  });
  rmSync(shim, { recursive: true, force: true });
  if (code !== 0) return { ok: false, error: (tail.filter((line) => /error|errore|fail|denied|password|required/i.test(line)).pop() || tail.pop() || `uscito con ${code}`).slice(0, 300) };
  const version = await answers(url, waitMs);
  if (!version) return { ok: false, error: "Ollama è installato ma non risponde ancora: riprova tra poco" };
  return { ok: true, version };
}

/** Ollama is up when /api/version answers: the service may take a few seconds after the script. */
async function defaultAnswers(url, waitMs) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${String(url).replace(/\/$/, "")}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return String((await response.json()).version || "?");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return "";
}
