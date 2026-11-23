import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

/** Where /proc is missing (macOS) `ps -E` prints each process of this user with its environment. */
function fromPs(name, match) {
  let listing = "";
  try { listing = execFileSync("ps", ["-E", "-ww", "-x", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
  const pattern = new RegExp(`(?:^|\\s)${name}=(\\S+)`);
  const found = [];
  for (const line of listing.split("\n")) {
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
    if (!pid || pid === process.pid) continue;
    const value = pattern.exec(line)?.[1];
    if (value !== undefined && match(value)) found.push(pid);
  }
  return found;
}

/**
 * The processes of this user whose environment sets `name` to a value `match` accepts, detached
 * ones included (a daemon a CLI leaves behind): from /proc, or from `ps -E` where there is none.
 */
export function processesWithEnv(name, match, { procRoot = "/proc" } = {}) {
  if (!existsSync(procRoot)) return procRoot === "/proc" ? fromPs(name, match) : [];
  let entries = [];
  try { entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)); } catch { return []; }
  const prefix = `${name}=`;
  const found = [];
  for (const entry of entries) {
    if (Number(entry) === process.pid) continue;
    let environ = "";
    try { environ = readFileSync(join(procRoot, entry, "environ"), "latin1"); } catch { continue; }
    const value = environ.split("\0").find((item) => item.startsWith(prefix))?.slice(prefix.length);
    if (value !== undefined && match(value)) found.push(Number(entry));
  }
  return found;
}

/** SIGTERM, then SIGKILL to what is still alive after `graceMs`. Answers how many had to be killed. */
export async function stopProcesses(pids, { graceMs = 5000 } = {}) {
  if (!pids.length) return 0;
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const deadline = Date.now() + graceMs;
  let left = alive();
  while (left.length && Date.now() < deadline) {
    await wait(100, undefined, { ref: false });
    left = alive();
  }
  for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return left.length;
}
