import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../bin/preview-space.mjs", import.meta.url));
const freePort = () => new Promise((done) => { const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); }); });

async function previewSpace(t, { minutes = 60 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cora-preview-"));
  const port = await freePort();
  const token = randomBytes(24).toString("base64url");
  const second = randomBytes(24).toString("base64url");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(dir, "spec.json"), JSON.stringify({
    slug: "acme", port, home: join(dir, "home"), company: "Acme", site: "https://acme.example", lang: "en", model: "ollama/gpt-oss:120b", minutes,
    agents: [{ name: "Ava", personality: "You help Acme." }, { name: "Leo", personality: "You write for Acme." }],
    guests: [{ email: "Anna@Acme.example", name: "Anna", tokenHash: hash(token) }, { email: "bo@acme.example", name: "Bo", tokenHash: hash(second) }],
  }));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", launcher, join(dir, "spec.json")], {
    env: { ...process.env, CORA_SESSION_KEY: randomBytes(32).toString("base64"), CORA_INSECURE_COOKIES: "1", CORA_OLLAMA_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((done) => child.once("exit", done)); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !/preview acme ready/.test(output); i++) await new Promise((done) => setTimeout(done, 150));
  assert.match(output, /preview acme ready/, output);
  const base = `http://127.0.0.1:${port}`;
  const db = () => new DatabaseSync(join(dir, "home", "cora.db"));
  const setStart = (startedAt) => { const conn = db(); conn.prepare("INSERT INTO settings(key, value) VALUES ('value:previewWindow', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ startedAt })); conn.close(); };
  const signIn = async (value) => {
    const res = await fetch(`${base}/auth/preview?token=${encodeURIComponent(value)}`, { redirect: "manual", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0], body: await res.text() };
  };
  const call = async (cookie, path, { method = "GET", body } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-cora": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  };
  return { token, second, signIn, call, setStart };
}

test("a preview space opens only through the mailed link, keeps its agents sealed and refuses writes after its hour", async (t) => {
  const space = await previewSpace(t);

  const refused = await space.signIn("not-the-token");
  assert.equal(refused.status, 403);
  assert.equal(refused.cookie, "");
  assert.equal((await space.call("", "/api/state")).status, 401, "nothing opens without the link");

  const entry = await space.signIn(space.token);
  assert.equal(entry.status, 200);
  assert.match(entry.cookie, /^cora_session=v2\./);
  assert.match(entry.body, /http-equiv="refresh" content="0;url=\/"/, "the cross-site arrival moves on from this origin so the Strict cookie is sent");

  const state = await space.call(entry.cookie, "/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.agents.map((agent) => [agent.name, agent.sealed]), [["Ava", true], ["Leo", true]]);
  assert.deepEqual(state.data.preview, { minutes: 60, startedAt: null, endsAt: null, ended: false });
  assert.notEqual((await space.call(entry.cookie, "/api/brain/pages")).status, 200, "the preview agents have no company brain to read");

  // The colleague with the second link reaches the same agents.
  const bo = await space.signIn(space.second);
  assert.equal(bo.status, 200);
  assert.equal((await space.call(bo.cookie, "/api/state")).data.agents.length, 2);

  // The first message starts the hour; a later one does not move it.
  const ava = state.data.agents[0].id;
  const first = await space.call(entry.cookie, `/api/rooms/web-${ava}/messages`, { method: "POST", body: { text: "Hello" } });
  assert.equal(first.status, 201);
  const started = (await space.call(entry.cookie, "/api/state")).data.preview;
  assert.ok(started.startedAt > Date.now() - 60000 && started.endsAt === started.startedAt + 3600000);
  assert.equal((await space.call(bo.cookie, `/api/rooms/web-${ava}/messages`, { method: "POST", body: { text: "Again" } })).status, 201);
  assert.equal((await space.call(entry.cookie, "/api/state")).data.preview.startedAt, started.startedAt);

  // 59 minutes in, writes still work; 61 minutes in, they are refused and the links stop working.
  space.setStart(Date.now() - 59 * 60000);
  assert.equal((await space.call(entry.cookie, `/api/rooms/web-${ava}/messages`, { method: "POST", body: { text: "Minute 59" } })).status, 201);
  space.setStart(Date.now() - 61 * 60000);
  const late = await space.call(entry.cookie, `/api/rooms/web-${ava}/messages`, { method: "POST", body: { text: "Minute 61" } });
  assert.equal(late.status, 403);
  assert.match(late.data.error, /anteprima è finita/);
  assert.equal((await space.call(entry.cookie, "/api/state")).data.preview.ended, true);
  assert.equal((await space.call(entry.cookie, `/api/agents/${ava}`, { method: "PUT", body: { name: "Changed" } })).status, 403);
  const closed = await space.signIn(space.token);
  assert.equal(closed.status, 410);
  assert.equal(closed.cookie, "");
});
