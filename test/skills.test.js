import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { parseFrontmatter, parseSource } from "../src/skills.js";
import { executeTool } from "../src/tools.js";
import { fakeCli, fakeDocker, fakeOllama, tempHome } from "./helpers.js";

const PASSWORD = "fixture-password";
const sha1 = (text) => createHash("sha1").update(text).digest("hex");

/** GitHub (API and raw files) and skills.sh, for one repository whose files a test can change. */
async function fakeSources() {
  const files = {
    "README.md": "# Acme skills\n",
    "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: >-\n  Use when the task needs ALPHA_CANARY\n  reports.\n---\n# Alpha\nRun scripts/run.sh then read references/guide.md.\n",
    "skills/alpha/scripts/run.sh": "#!/bin/sh\necho alpha\n",
    "skills/alpha/references/guide.md": "ALPHA_GUIDE_CANARY\n",
    "skills/beta/SKILL.md": "---\nname: beta\ndescription: \"Beta helper: formats things\"\n---\nBeta body\n",
    ".automations/triage/SKILL.md": "---\nname: triage\ndescription: internal automation\n---\n",
    "skills/huge/SKILL.md": "---\nname: huge\ndescription: too big\n---\n",
    "skills/huge/blob.bin": "x",
  };
  const state = { files, commit: "a".repeat(40), calls: [], audit: { alpha: { ath: { risk: "safe" }, socket: { risk: "safe", alerts: 0, score: 90 }, snyk: { risk: "medium" } } } };
  const tree = () => {
    const entries = [];
    const dirs = new Map();
    for (const [path, text] of Object.entries(state.files)) {
      entries.push({ path, mode: path.endsWith(".sh") ? "100755" : "100644", type: "blob", sha: sha1(text), size: path === "skills/huge/blob.bin" ? 3 * 1024 * 1024 : Buffer.byteLength(text) });
      const parts = path.split("/");
      for (let at = 1; at < parts.length; at++) {
        const dir = parts.slice(0, at).join("/");
        dirs.set(dir, sha1(`${dirs.get(dir) || dir}${path}${text}`));
      }
    }
    for (const [path, sha] of dirs) entries.push({ path, mode: "040000", type: "tree", sha });
    return { sha: sha1(JSON.stringify(entries)), truncated: false, tree: entries };
  };
  const server = http.createServer((req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/repos/acme/skills") return json(200, { default_branch: "main" });
    if (url.pathname === "/api/repos/acme/skills/commits/main") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(state.commit); }
    if (url.pathname === `/api/repos/acme/skills/git/trees/${state.commit}` || url.pathname === "/api/repos/acme/skills/git/trees/main") return json(200, tree());
    const raw = /^\/raw\/acme\/skills\/([a-f0-9]{40})\/(.+)$/.exec(url.pathname);
    if (raw && raw[1] === state.commit && state.files[decodeURIComponent(raw[2])] !== undefined) { res.writeHead(200); return res.end(state.files[decodeURIComponent(raw[2])]); }
    if (url.pathname === "/registry/api/search") return json(200, { skills: [{ id: "acme/skills/alpha", source: "acme/skills", skillId: "alpha", name: "alpha", installs: 1234 }] });
    if (url.pathname === "/audit") return json(200, url.searchParams.get("source") === "acme/skills" ? state.audit : {});
    json(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => server.close() };
}

async function world(t) {
  const sources = await fakeSources();
  const docker = fakeDocker();
  const cli = fakeCli();
  const ollama = await fakeOllama("ok");
  const home = tempHome();
  const app = startCora({ home, host: "127.0.0.1", port: 0, adminPassword: PASSWORD, sessionKey: "fixture-session-skills", insecureCookies: true,
    discordToken: "", telegramToken: "", ollamaUrl: ollama.url, ollamaKey: "k", orcaKey: "", claudeBin: "/missing/claude", codexBin: "/missing/codex",
    hermesBin: cli.hermes, hermesHome: join(home, "hermes-home"), hermesBaseUrl: `${ollama.url}/v1`,
    docker: docker.path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys",
    githubApi: `${sources.base}/api`, githubRaw: `${sources.base}/raw`, skillsApi: `${sources.base}/registry`, skillsAuditApi: `${sources.base}/audit`,
  });
  await app.ready;
  t.after(async () => { await app.stop(); sources.close(); await ollama.close?.(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, "X-Cora": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { app, call, sources, docker, cli };
}

test("sources and SKILL.md front matter are read as npx skills reads them", () => {
  assert.deepEqual(parseSource("acme/skills@alpha"), { owner: "acme", repo: "skills", ref: "", path: "", skill: "alpha" });
  assert.deepEqual(parseSource("https://github.com/acme/skills/tree/main/skills/alpha"), { owner: "acme", repo: "skills", ref: "main", path: "skills/alpha", skill: "" });
  assert.deepEqual(parseSource("https://skills.sh/acme/skills/alpha"), { owner: "acme", repo: "skills", ref: "", path: "", skill: "alpha" });
  assert.deepEqual(parseSource("npx skills add https://github.com/acme/skills --skill beta -g -y"), { owner: "acme", repo: "skills", ref: "", path: "", skill: "beta" });
  assert.throws(() => parseSource("https://github.com/acme/skills/tree/main/../etc"), /Percorso non valido/);
  assert.throws(() => parseSource("not a source"), /Sorgente non valida/);
  assert.deepEqual(parseFrontmatter("---\nname: x\ndescription: |\n  line one\n  line two\n---\n"), { name: "x", description: "line one line two" });
});

test("an agent's skills: installed from GitHub for every harness, verified, updated, adopted from the desktop and removed", async (t) => {
  const { app, call, sources, docker, cli } = await world(t);
  const agent = app.store.createAgent({ name: "Skilled", model: "hermes/test-model", tools: true });
  const desktop = docker.desktop(agent.id);

  const found = await call("/api/skills/search?q=alpha");
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.skills[0], { id: "acme/skills/alpha", name: "alpha", source: "acme/skills", skill: "alpha", installs: 1234 });
  const discovered = await call("/api/skills/discover", { method: "POST", body: { source: "acme/skills" } });
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.data.skills.map((skill) => skill.name).sort(), ["alpha", "beta", "huge"], "hidden automation folders are not offered");
  assert.equal(discovered.data.skills.find((skill) => skill.name === "alpha").description, "Use when the task needs ALPHA_CANARY reports.");

  assert.equal((await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills" } })).status, 409, "a source with several skills needs a choice");
  assert.equal((await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "missing" } })).status, 404);
  assert.equal((await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "huge" } })).status, 413);
  const installed = await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "alpha" } });
  assert.equal(installed.status, 201, JSON.stringify(installed.data));
  assert.equal(installed.data.skill.files, 3);
  assert.equal(installed.data.desktop.skills.alpha.present, true);
  assert.equal(readFileSync(join(desktop, ".agents/skills/alpha/references/guide.md"), "utf8"), "ALPHA_GUIDE_CANARY\n");
  assert.ok(statSync(join(desktop, ".agents/skills/alpha/scripts/run.sh")).mode & 0o100, "scripts keep their executable bit");
  for (const dir of [".claude/skills", ".grok/skills", ".hermes/skills", ".gemini/skills"]) {
    assert.ok(lstatSync(join(desktop, dir, "alpha")).isSymbolicLink(), `${dir} links the canonical copy`);
    assert.equal(readlinkSync(join(desktop, dir, "alpha")), "../../.agents/skills/alpha");
  }
  assert.equal((await call(`/api/agents/${agent.id}`)).data.skillCount, 1);

  let check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.deepEqual({ server: check.skills.alpha.server, desktop: check.skills.alpha.desktop, upstream: check.skills.alpha.upstream }, { server: "ok", desktop: "ok", upstream: "current" });
  assert.deepEqual(check.skills.alpha.links, { ".claude/skills": "ok", ".grok/skills": "ok", ".hermes/skills": "ok", ".gemini/skills": "ok" });
  assert.deepEqual(check.skills.alpha.audit, { ath: { risk: "safe" }, socket: { risk: "safe", alerts: 0 }, snyk: { risk: "medium" } });

  writeFileSync(join(desktop, ".agents/skills/alpha/SKILL.md"), "tampered");
  check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.equal(check.skills.alpha.desktop, "changed");
  assert.deepEqual(check.skills.alpha.changed, ["SKILL.md"]);
  await call(`/api/agents/${agent.id}/skills/sync`, { method: "POST" });
  assert.equal((await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data.skills.alpha.desktop, "ok", "rewriting the desktop restores it");

  // Every harness: the prompt names the skill and skill_read hands it over the MCP bridge.
  const prompt = app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true });
  assert.match(prompt, /## Le tue skill[\s\S]*- alpha: Use when the task needs ALPHA_CANARY reports\./);
  assert.match(prompt, /~\/\.agents\/skills/);
  const ctx = { agent: app.store.agent(agent.id), store: app.store, skills: app.skills, boxes: app.boxes };
  assert.match((await executeTool({ name: "skill_read", args: { name: "alpha" } }, ctx)).text, /# Alpha[\s\S]*Run scripts\/run\.sh/);
  assert.match((await executeTool({ name: "skill_read", args: { name: "alpha", file: "references/guide.md" } }, ctx)).text, /ALPHA_GUIDE_CANARY/);
  assert.match((await executeTool({ name: "skill_read", args: { name: "alpha", file: "../../etc/passwd" } }, ctx)).text, /^error: alpha has no file/);
  assert.match((await executeTool({ name: "skill_read", args: { name: "nope" } }, ctx)).text, /^error: no skill named nope; yours are: alpha/);
  cli.set({ tool: "skill_read", args: { name: "alpha", file: "references/guide.md" }, reply: "Letta." });
  const answer = await app.brain.chatTurn({ agent: app.store.agent(agent.id), forced: true, computer: false, history: [{ kind: "owner", authorId: "owner", authorName: "Owner", content: "Usa la skill alpha.", at: Date.now() }], channel: { id: `web-${agent.id}`, name: "QA" } });
  const run = cli.calls().findLast((item) => item.flavor === "hermes");
  assert.ok(run.tools.includes("skill_read"), "the CLI harness receives skill_read without the computer");
  assert.match(answer.text, /ALPHA_GUIDE_CANARY/);

  // The source moves on: the check sees it, the update brings it.
  sources.state.files["skills/alpha/SKILL.md"] = sources.state.files["skills/alpha/SKILL.md"].replace("# Alpha", "# Alpha v2");
  sources.state.commit = "b".repeat(40);
  check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.equal(check.skills.alpha.upstream, "behind");
  const updated = await call(`/api/agents/${agent.id}/skills/alpha/update`, { method: "POST" });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.updated, true);
  assert.match(readFileSync(join(desktop, ".agents/skills/alpha/SKILL.md"), "utf8"), /# Alpha v2/);
  assert.equal((await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data.skills.alpha.upstream, "current");
  assert.match((await call(`/api/agents/${agent.id}/skills/alpha/files`)).data.text, /# Alpha v2/);

  // A skill put on the desktop by hand is found, and taken under Cora for every model.
  mkdirSync(join(desktop, ".claude/skills/manual"), { recursive: true });
  writeFileSync(join(desktop, ".claude/skills/manual/SKILL.md"), "---\nname: manual\ndescription: MANUAL_CANARY steps\n---\nManual body\n");
  check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.deepEqual(check.found, [{ name: "manual", where: [".claude/skills"], linked: [], description: "MANUAL_CANARY steps" }]);
  const adopted = await call(`/api/agents/${agent.id}/skills/manual/adopt`, { method: "POST" });
  assert.equal(adopted.status, 201, JSON.stringify(adopted.data));
  assert.equal(adopted.data.skill.origin, "desktop");
  assert.equal(readFileSync(join(desktop, ".agents/skills/manual/SKILL.md"), "utf8").includes("MANUAL_CANARY"), true);
  assert.match(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: false }), /- manual: MANUAL_CANARY steps/);
  assert.equal((await call(`/api/agents/${agent.id}/skills/manual/update`, { method: "POST" })).status, 409, "a desktop skill has no source to update from");

  const removed = await call(`/api/agents/${agent.id}/skills/alpha`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(existsSync(join(desktop, ".agents/skills/alpha")), false);
  for (const dir of [".claude/skills", ".grok/skills"]) assert.equal(existsSync(join(desktop, dir, "alpha")), false);
  assert.deepEqual((await call(`/api/agents/${agent.id}/skills`)).data.skills.map((skill) => skill.name), ["manual"]);
  assert.doesNotMatch(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: false }), /ALPHA_CANARY/);
  await call(`/api/agents/${agent.id}/skills/manual`, { method: "DELETE" });
  assert.equal(existsSync(join(desktop, ".claude/skills/manual")), false, "an adopted desktop skill goes from everywhere");
  assert.doesNotMatch(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: false }), /## Le tue skill/);
});

test("skills wait for the desktop when it is off and are forgotten with the agent", async (t) => {
  const { app, call, docker } = await world(t);
  writeFileSync(join(docker.dir, "inspect"), '{"Running":false,"Status":"exited"}\t{}\tsha256:test\t/home/agent,/var/lib/cora,\t\n');
  const agent = app.store.createAgent({ name: "Offline", model: "ollama/test-model", tools: true });
  const installed = await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "https://skills.sh/acme/skills/beta" } });
  assert.equal(installed.status, 201, JSON.stringify(installed.data));
  assert.deepEqual(installed.data.desktop, { off: true, reason: "desktop spento" });
  const check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.equal(check.skills.beta.server, "ok");
  assert.equal(check.skills.beta.desktop, "off");
  const ctx = { agent: app.store.agent(agent.id), store: app.store, skills: app.skills };
  assert.match((await executeTool({ name: "skill_read", args: { name: "beta" } }, ctx)).text, /Beta body/, "skill_read works without any desktop");
  assert.equal((await call(`/api/agents/${agent.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(app.skills.list(agent.id), []);
  assert.equal(existsSync(join(app.skills.root, agent.id)), false);
});
