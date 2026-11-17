import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { hostname, release } from "node:os";
import { join } from "node:path";

/**
 * A Kimi Code account as the official CLI keeps it in its home (KIMI_CODE_HOME): the
 * OAuth token in credentials/<name>.json, refreshed under the CLI's own lock
 * (oauth/<name>.lock, the proper-lockfile layout), so Cora and the CLI never spend the
 * same refresh token twice. Cora reads the account and hands a fresh token to Hermes
 * and Pi through its relay; the token itself never reaches them.
 */
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_REGIONS = {
  "mainland-cn": { oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.com/coding/v1" },
  global: { oauthHost: "https://auth.kimi.ai", baseUrl: "https://api.kimi.ai/coding/v1" },
};
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 60000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Which region the account signed in to: the CLI writes the managed provider's address in config.toml. */
export function kimiRegion(home) {
  let config = "";
  try { config = readFileSync(join(home, "config.toml"), "utf8"); } catch {}
  return /\bkimi\.ai\b/.test(config) && !/api\.kimi\.com/.test(config) ? "global" : "mainland-cn";
}

export function kimiEnds(home) {
  return KIMI_REGIONS[kimiRegion(home)];
}

/** The credential file the login wrote: kimi-code.json, or the name the CLI gave a region's key. */
export function kimiCredentialName(home) {
  const dir = join(home, "credentials");
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); } catch { return ""; }
  if (names.includes("kimi-code")) return "kimi-code";
  return names.find((name) => /^kimi-code/.test(name)) || "";
}

function readToken(home, name) {
  try {
    const wire = JSON.parse(readFileSync(join(home, "credentials", `${name}.json`), "utf8"));
    return {
      accessToken: String(wire.access_token || ""),
      refreshToken: String(wire.refresh_token || ""),
      expiresAt: Number(wire.expires_at) || 0,
      expiresIn: Number(wire.expires_in) || 0,
      scope: String(wire.scope || ""),
      tokenType: String(wire.token_type || "Bearer"),
    };
  } catch { return null; }
}

function saveToken(home, name, token) {
  const dir = join(home, "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${name}.json`);
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(`${JSON.stringify({
    access_token: token.accessToken, refresh_token: token.refreshToken, expires_at: token.expiresAt,
    scope: token.scope, token_type: token.tokenType, expires_in: token.expiresIn,
  }, null, 2)}\n`);
  const fd = openSync(temporary, "w", 0o600);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { chmodSync(temporary, 0o600); renameSync(temporary, target); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

/** The CLI's refresh lock: a directory next to oauth/<name>, refreshed while held, taken over once stale. */
async function lock(home, name) {
  const target = join(home, "oauth", name);
  mkdirSync(join(home, "oauth"), { recursive: true, mode: 0o700 });
  try { writeFileSync(target, "", { flag: "a" }); } catch {}
  const path = `${target}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { rmdirSync(path); } catch {} continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Kimi: refresh lock busy");
      await sleep(500);
    }
  }
  const keep = setInterval(() => { try { const now = new Date(); utimesSync(path, now, now); } catch {} }, LOCK_STALE_MS / 2);
  keep.unref?.();
  return () => { clearInterval(keep); try { rmdirSync(path); } catch {} };
}

/** The device headers the CLI's own refresh sends, with the device id the login created in the home. */
function deviceHeaders(home) {
  let id = "";
  try { id = readFileSync(join(home, "device_id"), "utf8").trim(); } catch {}
  const ascii = (value) => String(value || "").replace(/[^\x20-\x7e]/g, "").trim() || "unknown";
  return {
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Device-Name": ascii(hostname()),
    "X-Msh-Os-Version": ascii(release()),
    ...(id ? { "X-Msh-Device-Id": ascii(id) } : {}),
  };
}

export class KimiAuthError extends Error {
  constructor(message) { super(message); this.code = "KIMI_AUTH"; }
}

/**
 * A token good for at least `minSeconds` more, refreshed when needed with the CLI's
 * own lock and file format. A rejected refresh token leaves the CLI's tombstone, the
 * same signal the CLI would leave, so the account shows as disconnected.
 */
export async function kimiAccessToken(home, { minSeconds = 600, fetchImpl = fetch } = {}) {
  const name = kimiCredentialName(home);
  if (!name) throw new KimiAuthError("Kimi: not logged in");
  const fresh = (token) => token?.accessToken && (!token.expiresAt || token.expiresAt - Date.now() / 1000 > minSeconds);
  const first = readToken(home, name);
  if (!first?.accessToken) throw new KimiAuthError("Kimi: login expired, please log in again");
  if (fresh(first)) return first.accessToken;
  const release = await lock(home, name);
  try {
    const current = readToken(home, name);
    if (!current?.accessToken) throw new KimiAuthError("Kimi: login expired, please log in again");
    if (fresh(current)) return current.accessToken;
    if (!current.refreshToken) throw new KimiAuthError("Kimi: login expired, please log in again");
    const { oauthHost } = kimiEnds(home);
    let response;
    try {
      response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: { ...deviceHeaders(home), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: KIMI_CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refreshToken }).toString(),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      // The old token may still be valid for a while: use it rather than fail the turn.
      if (current.expiresAt > Date.now() / 1000 + 30) return current.accessToken;
      throw new Error("Kimi: refresh failed, network unavailable");
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 200 && typeof data.access_token === "string" && data.access_token && data.refresh_token && Number(data.expires_in) > 0) {
      const expiresIn = Number(data.expires_in);
      saveToken(home, name, {
        accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn,
        expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
        scope: typeof data.scope === "string" ? data.scope : current.scope,
        tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
      });
      return data.access_token;
    }
    if (response.status === 401 || response.status === 403 || data.error === "invalid_grant") {
      const again = readToken(home, name);
      if (again?.refreshToken && again.refreshToken !== current.refreshToken && again.accessToken) return again.accessToken;
      saveToken(home, name, { ...current, accessToken: "", refreshToken: "", expiresAt: 0, expiresIn: 0 });
      throw new KimiAuthError("Kimi: refresh token revoked, login expired");
    }
    if (current.expiresAt > Date.now() / 1000 + 30) return current.accessToken;
    throw new Error(`Kimi: refresh failed (HTTP ${response.status})`);
  } finally { release(); }
}

/** Whether a home holds a usable login, without touching the network. */
export function kimiSignedIn(home) {
  const name = kimiCredentialName(home);
  const token = name ? readToken(home, name) : null;
  return Boolean(token?.accessToken && token.refreshToken);
}

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new KimiAuthError("Kimi: not authenticated");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Kimi: HTTP ${response.status}`);
  }
  return response.json();
}

/** Who the account is: the address (or nickname) and the membership it bills against. */
export async function kimiAccount(home, { fetchImpl = fetch } = {}) {
  if (!kimiSignedIn(home)) return null;
  const token = await kimiAccessToken(home, { minSeconds: 60, fetchImpl });
  const data = await getJson(`${kimiEnds(home).baseUrl}/me`, token, fetchImpl);
  const email = typeof data.email === "string" && /@/.test(data.email) ? data.email : "";
  const plan = String(data.user_level_name || data.userLevelName || "").slice(0, 80);
  return { email: email.slice(0, 254), plan };
}

/** The models the subscription serves, as the CLI names them (`kimi-code/<id>`). */
export async function kimiModels(home, { fetchImpl = fetch } = {}) {
  const token = await kimiAccessToken(home, { minSeconds: 60, fetchImpl });
  const data = await getJson(`${kimiEnds(home).baseUrl}/models`, token, fetchImpl);
  return (Array.isArray(data.data) ? data.data : [])
    .map((model) => ({
      name: String(model.id || ""), label: String(model.display_name || model.name || model.id || ""),
      vision: model.supports_image_in === true || (Array.isArray(model.modalities?.input) && model.modalities.input.includes("image")),
    }))
    .filter((model) => /^[\w.:-]{1,80}$/.test(model.name));
}

/** The plan's windows, as /usages reports them: used ratio and reset time of the 5 h, weekly and monthly limits. */
export async function kimiUsage(home, { fetchImpl = fetch } = {}) {
  const token = await kimiAccessToken(home, { minSeconds: 60, fetchImpl });
  return getJson(`${kimiEnds(home).baseUrl}/usages`, token, fetchImpl);
}

export function kimiHomeReady(home) {
  return existsSync(join(home, "credentials"));
}
