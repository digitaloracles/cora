import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { Skills, parseFrontmatter, parseSource } from "../src/skills.js";
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
  mkdirSync(join(desktop, ".grok/skills/manual"), { recursive: true });
  writeFileSync(join(desktop, ".grok/skills/manual/SKILL.md"), "---\nname: manual\ndescription: GROK_OWN_CANARY\n---\n");
  const adopted = await call(`/api/agents/${agent.id}/skills/manual/adopt`, { method: "POST" });
  assert.equal(adopted.status, 201, JSON.stringify(adopted.data));
  assert.equal(adopted.data.skill.origin, "desktop");
  assert.equal(readFileSync(join(desktop, ".agents/skills/manual/SKILL.md"), "utf8").includes("MANUAL_CANARY"), true);
  assert.ok(lstatSync(join(desktop, ".claude/skills/manual")).isSymbolicLink(), "the identical hand-made copy becomes a link to the canonical one");
  assert.match(readFileSync(join(desktop, ".grok/skills/manual/SKILL.md"), "utf8"), /GROK_OWN_CANARY/, "a different copy in a harness folder is never overwritten");
  assert.deepEqual(adopted.data.desktop.skills.manual.links, { ".claude/skills": "ok", ".grok/skills": "copy", ".hermes/skills": "ok", ".gemini/skills": "ok" });
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
  assert.match(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: false }), /## Le tue skill\nNon hai skill attive[\s\S]*skill_install/, "without skills the agent still learns to install them through Cora");
  assert.doesNotMatch(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: false }), /- manual: MANUAL_CANARY/);
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

test("GitHub is read once for listing then installing, with the optional token, and an update reads it again", async () => {
  const calls = [];
  const fetch = async (url, { headers }) => {
    calls.push({ url, auth: headers.Authorization || "" });
    const json = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/repos/acme/kit")) return json({ default_branch: "main" });
    if (url.includes("/commits/")) return new Response("c".repeat(40), { status: 200 });
    if (url.includes("/git/trees/")) return json({ sha: "t", tree: [{ type: "blob", path: "SKILL.md", size: 30 }] });
    return new Response("---\nname: kit\ndescription: d\n---\n", { status: 200 });
  };
  let clock = 0;
  const skills = new Skills({ store: null, home: "/nonexistent", githubApi: "https://gh.test", githubRaw: "https://raw.test", githubToken: "tok", fetch, now: () => clock });
  await skills.discover("acme/kit");
  await skills.discover("acme/kit");
  const api = () => calls.filter((call) => call.url.startsWith("https://gh.test/"));
  assert.equal(api().length, 3, "repository, commit and tree once");
  assert.ok(api().every((call) => call.auth === "Bearer tok"), "the token goes to the GitHub API");
  assert.ok(calls.filter((call) => call.url.startsWith("https://raw.test/")).every((call) => !call.auth), "never to raw files");
  clock = 5 * 60 * 1000;
  await skills.discover("acme/kit");
  assert.equal(api().length, 6, "after five minutes GitHub is read again");
});

test("a skill is switched off and on per agent: off it leaves the prompt, skill_read and the desktop, but stays installed", async (t) => {
  const { app, call, docker } = await world(t);
  const agent = app.store.createAgent({ name: "Toggled", model: "hermes/test-model", tools: true });
  const other = app.store.createAgent({ name: "Other", model: "hermes/test-model", tools: true });
  const desktop = docker.desktop(agent.id);
  for (const id of [agent.id, other.id]) assert.equal((await call(`/api/agents/${id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "alpha" } })).status, 201);
  assert.equal((await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "beta" } })).status, 201);
  assert.deepEqual((await call(`/api/agents/${agent.id}/skills`)).data.skills.map((skill) => [skill.name, skill.enabled]), [["alpha", true], ["beta", true]]);

  assert.equal((await call(`/api/agents/${agent.id}/skills/alpha`, { method: "PATCH", body: {} })).status, 400);
  assert.equal((await call(`/api/agents/${agent.id}/skills/nope`, { method: "PATCH", body: { enabled: false } })).status, 404);
  const off = await call(`/api/agents/${agent.id}/skills/alpha`, { method: "PATCH", body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.skill.enabled, false);
  assert.equal(existsSync(join(desktop, ".agents/skills/alpha")), false, "off: the desktop copy goes");
  for (const dir of [".claude/skills", ".grok/skills", ".hermes/skills", ".gemini/skills"]) assert.equal(existsSync(join(desktop, dir, "alpha")), false, `off: no ${dir} link`);
  assert.ok(existsSync(join(desktop, ".agents/skills/beta/SKILL.md")), "the other skill stays");
  assert.ok(existsSync(join(app.skills.root, agent.id, "alpha", "SKILL.md")), "Cora keeps its copy");

  const prompt = app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true });
  assert.doesNotMatch(prompt, /ALPHA_CANARY/);
  assert.match(prompt, /- beta: Beta helper/);
  assert.match(app.brain.systemPrompt(app.store.agent(other.id), { place: "test", computer: true }), /ALPHA_CANARY/, "only this agent loses it");
  const ctx = { agent: app.store.agent(agent.id), store: app.store, skills: app.skills };
  assert.match((await executeTool({ name: "skill_read", args: { name: "alpha" } }, ctx)).text, /^error: alpha is switched off for you by the owner; yours are: beta/);
  assert.match((await call(`/api/agents/${agent.id}/skills/alpha/files`)).data.text, /# Alpha/, "the panel still previews it");

  let check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.equal(check.skills.alpha.server, "ok");
  assert.equal(check.skills.alpha.desktop, "disabled");
  assert.deepEqual(check.found, [], "a skill switched off is not offered as a desktop skill to adopt");
  await call(`/api/agents/${agent.id}/skills/sync`, { method: "POST" });
  assert.equal(existsSync(join(desktop, ".agents/skills/alpha")), false, "rewriting the desktop keeps it off");
  assert.equal((await call(`/api/agents/${agent.id}/skills`, { method: "POST", body: { source: "acme/skills", skill: "alpha" } })).data.skill.enabled, false, "a reinstall keeps the switch");

  await call(`/api/agents/${agent.id}/skills/beta`, { method: "PATCH", body: { enabled: false } });
  assert.doesNotMatch(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true }), /- beta: Beta helper/);
  assert.match(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true }), /Non hai skill attive/);

  const on = await call(`/api/agents/${agent.id}/skills/alpha`, { method: "PATCH", body: { enabled: true } });
  assert.equal(on.data.skill.enabled, true);
  assert.equal(readFileSync(join(desktop, ".agents/skills/alpha/references/guide.md"), "utf8"), "ALPHA_GUIDE_CANARY\n", "on: written back");
  assert.ok(lstatSync(join(desktop, ".claude/skills/alpha")).isSymbolicLink());
  assert.match((await executeTool({ name: "skill_read", args: { name: "alpha" } }, { ...ctx, agent: app.store.agent(agent.id) })).text, /# Alpha/);
  check = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.equal(check.skills.alpha.desktop, "ok");
  assert.equal(check.skills.beta.desktop, "disabled");
});

test("a skill an agent puts on its desktop outside Cora shows in its Skill tab: taken under Cora after its commands, kept off when the owner switched it off", async (t) => {
  const { app, call, docker } = await world(t);
  const agent = app.store.createAgent({ name: "Installer", model: "hermes/test-model", tools: true });
  const desktop = docker.desktop(agent.id);
  const put = (dir, name, text, extra = {}) => {
    mkdirSync(join(desktop, dir, name, "scripts"), { recursive: true });
    writeFileSync(join(desktop, dir, name, "SKILL.md"), text);
    for (const [path, body] of Object.entries(extra)) writeFileSync(join(desktop, dir, name, path), body);
  };
  // What a tool's own installer does: a canonical copy and a second real copy for Claude Code.
  for (const dir of [".agents/skills", ".claude/skills"]) put(dir, "kit", "---\nname: kit\ndescription: KIT_CANARY montaggio\n---\nKit body\n", { "scripts/run.sh": "#!/bin/sh\necho kit\n" });
  put(".claude/skills", "kit-old", "---\nname: kit\ndescription: an older kit\n---\n");
  put(".agents/skills", "heavy", "---\nname: heavy\ndescription: HEAVY_CANARY\n---\n", { "blob.bin": "x".repeat(3 * 1024 * 1024) });

  // Every command on the desktop asks for a look once it has been quiet.
  const watched = [];
  const ctx = { agent: app.store.agent(agent.id), store: app.store, boxes: { ensure: async () => {}, shell: async () => ({ code: 0, output: "done" }) }, skills: { watch: (who) => watched.push(who.id) } };
  assert.match((await executeTool({ name: "shell", args: { command: "npx skills add acme/kit -g -y" } }, ctx)).text, /exit 0/);
  assert.deepEqual(watched, [agent.id]);

  app.skills.scanDelayMs = 20;
  app.skills.watch(app.store.agent(agent.id));
  app.skills.watch(app.store.agent(agent.id));
  for (let at = 0; at < 200 && !app.skills.find(agent.id, "kit"); at++) await new Promise((resolve) => setTimeout(resolve, 25));
  await app.skills.runningScans.get(agent.id);
  const kit = app.skills.find(agent.id, "kit");
  assert.ok(kit, "the skill installed outside Cora is now Cora's");
  assert.equal(kit.origin, "desktop");
  assert.deepEqual(kit.installedBy, { kind: "agent", id: agent.id, name: "Installer" });
  assert.ok(lstatSync(join(desktop, ".claude/skills/kit")).isSymbolicLink(), "the identical second copy becomes a link to the canonical one");
  assert.match(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true }), /- kit: KIT_CANARY montaggio/);
  const view = (await call(`/api/agents/${agent.id}/skills`)).data;
  assert.deepEqual(view.skills.map((skill) => [skill.name, skill.enabled]), [["kit", true]], "it shows in the Skill tab, switched on");
  assert.deepEqual(view.check.found.map((entry) => [entry.name, entry.error]), [["heavy", "desktop: skill too large to adopt (200 files, 4 MB)"], ["kit-old", "copia di kit, già gestita da Cora"]], "what cannot be taken stays listed, and a copy never overwrites the managed skill");
  assert.ok(Number.isFinite(view.check.checkedAt), "the automatic scan leaves a verification time for the Skill tab");
  const recheck = (await call(`/api/agents/${agent.id}/skills/check`, { method: "POST" })).data;
  assert.deepEqual(recheck.found.map((entry) => [entry.name, entry.error]), [["heavy", "desktop: skill too large to adopt (200 files, 4 MB)"], ["kit-old", "copia di kit, già gestita da Cora"]], "a manual check keeps the reason it cannot be taken");
  assert.match(readFileSync(join(desktop, ".agents/skills/kit/SKILL.md"), "utf8"), /KIT_CANARY/);

  // A second look with nothing new changes nothing.
  const again = await app.skills.scan(agent.id);
  assert.deepEqual(again.adopted, []);
  assert.deepEqual(app.skills.list(agent.id).map((skill) => skill.name), ["kit"]);

  // Switched off by the owner, then put back by the agent: it stays off and leaves the desktop again.
  assert.equal((await call(`/api/agents/${agent.id}/skills/kit`, { method: "PATCH", body: { enabled: false } })).status, 200);
  assert.equal(existsSync(join(desktop, ".agents/skills/kit")), false);
  put(".agents/skills", "kit", "---\nname: kit\ndescription: KIT_CANARY montaggio\n---\nKit body\n");
  const off = await app.skills.scan(agent.id);
  assert.deepEqual(off.off, ["kit"]);
  assert.equal(existsSync(join(desktop, ".agents/skills/kit")), false, "the owner's switch wins");
  assert.equal(app.skills.find(agent.id, "kit").disabled, true);
  assert.doesNotMatch(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true }), /KIT_CANARY/);
});

test("skill_install installs through Cora only on the owner's request", async (t) => {
  const { app } = await world(t);
  const agent = app.store.createAgent({ name: "Asked", model: "hermes/test-model", tools: true });
  const ctx = (requester) => ({ agent: app.store.agent(agent.id), store: app.store, skills: app.skills, requester });
  for (const requester of [null, { kind: "authorized", id: "u2", name: "Guest" }]) {
    assert.match((await executeTool({ name: "skill_install", args: { source: "acme/skills", skill: "beta" } }, ctx(requester))).text, /^error: skills are installed only on the owner's request/);
  }
  assert.deepEqual(app.skills.list(agent.id), []);
  assert.match((await executeTool({ name: "skill_install", args: { source: "acme/skills" } }, ctx({ kind: "owner", id: "u1", name: "Seb" }))).text, /^error: acme\/skills contiene 3 skill: scegline una\./);
  const done = (await executeTool({ name: "skill_install", args: { source: "npx skills add https://github.com/acme/skills --skill beta -g -y" } }, ctx({ kind: "owner", id: "u1", name: "Seb" }))).text;
  assert.match(done, /^INSTALLED: beta \(1 files, from acme\/skills\), in your Skill tab; on your desktop in ~\/\.agents\/skills/);
  const beta = app.skills.find(agent.id, "beta");
  assert.deepEqual(beta.installedBy, { kind: "agent", id: agent.id, name: "Asked", requestedBy: "Seb" });
  assert.equal(beta.origin, "github");
  assert.match(app.brain.systemPrompt(app.store.agent(agent.id), { place: "test", computer: true }), /- beta: Beta helper/);
});

test("an external MCP client manages an agent's skills with one tool per action, including switching one off", async (t) => {
  const { app, call } = await world(t);
  const agent = app.store.createAgent({ name: "Remote skills", model: "hermes/test-model", tools: true });
  const access = (await call("/api/mcp/tokens", { method: "POST", body: { name: "Skills client" } })).data;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const tool = async (name, args = {}) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${access.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return (await response.json()).result.structuredContent;
  };
  assert.equal((await tool("cora_skills_search", { q: "alpha" })).data.skills[0].name, "alpha");
  assert.deepEqual((await tool("cora_skills_discover", { source: "acme/skills" })).data.skills.map((skill) => skill.name).sort(), ["alpha", "beta", "huge"]);
  const installed = await tool("cora_agent_skill_install", { agent_id: agent.id, source: "acme/skills", skill: "alpha" });
  assert.equal(installed.status, 201, JSON.stringify(installed.data));
  assert.ok((await tool("cora_agent_skills_list", { agent_id: agent.id })).data.skills.some((skill) => skill.name === "alpha"));
  const off = await tool("cora_agent_skill_set_enabled", { agent_id: agent.id, skill: "alpha", enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(app.skills.view(agent.id).skills.find((skill) => skill.name === "alpha").enabled, false);
  assert.equal((await tool("cora_agent_skill_set_enabled", { agent_id: agent.id, skill: "alpha", enabled: true })).status, 200);
  assert.equal(app.skills.view(agent.id).skills.find((skill) => skill.name === "alpha").enabled, true);
  assert.match((await tool("cora_agent_skill_read", { agent_id: agent.id, skill: "alpha", path: "references/guide.md" })).data.text || "", /ALPHA_GUIDE_CANARY/);
  assert.equal((await tool("cora_agent_skills_check", { agent_id: agent.id })).data.skills.alpha.server, "ok");
  assert.equal((await tool("cora_agent_skill_remove", { agent_id: agent.id, skill: "alpha" })).status, 200);
  assert.ok(!app.skills.view(agent.id).skills.some((skill) => skill.name === "alpha"));
});
