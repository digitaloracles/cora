import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { passKeys, signPass } from "../src/pass.js";
import { fakeDocker, tempHome } from "./helpers.js";

const keys = passKeys("fixture-mcp-gateway-signing-seed-0123456789abcdef");
const owner = { sub: "ac_owner", role: "owner", name: "Owner", email: "owner@example.test", emailVerified: true };
const member = { sub: "ac_member", role: "member", name: "Alice", email: "alice@company.test", emailVerified: true };
const CREDENTIAL_TOOLS = ["cora_connector_connect", "cora_provider_key_set", "cora_credential_create", "cora_subscription_code", "cora_secret_set", "cora_secret_update", "cora_agent_discord_bot_set", "cora_mail_account_connect"];

async function fixture(t) {
  const app = startCora({ home: tempHome(), host: "127.0.0.1", port: 0, insecureCookies: true,
    adminPassword: "fixture-password", sessionKey: "fixture-session-gateway", useResidentSubscriptions: false,
    cloudUrl: "https://usecora.test", cloudKey: keys.publicKey, cloudSpace: "alpha", mcpGateways: ["https://gateway.test"],
    discordToken: "", telegramToken: "", ollamaKey: "", orcaKey: "", claudeBin: "/missing/claude", codexBin: "/missing/codex", hermesBin: "/missing/hermes",
    botTokenFor: () => "", docker: fakeDocker().path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys",
  });
  await app.ready;
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const pass = (identity, aud = "mcp:alpha.usecora.test") => signPass(keys.privateKey, { aud, ...identity });
  const rpc = async (token, method, params = {}, headers = {}) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Cora-Mcp-Pass": token, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  const login = async (identity) => (await fetch(`${base}/auth/cloud?${new URLSearchParams({ pass: signPass(keys.privateKey, { aud: "alpha.usecora.test", ...identity }) })}`, { redirect: "manual" })).headers.get("set-cookie")?.split(";")[0] || "";
  return { app, base, pass, rpc, login };
}

test("the usecora.space gateway pass opens the public tool profile for an allowed person", async (t) => {
  const f = await fixture(t);
  const init = await f.rpc(f.pass(owner), "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  assert.equal(init.status, 200);
  assert.match(init.body.result.instructions, /^Cora is a team of AI agents/);
  assert.doesNotMatch(init.body.result.instructions, /never|always|must/i);

  const listed = await f.rpc(f.pass(owner), "tools/list");
  const tools = listed.body.result.tools;
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has("talk_to_agent") && names.has("cora_agents_list") && names.has("cora_configurations"));
  assert.equal(names.has("cora_request"), false);
  for (const name of CREDENTIAL_TOOLS) assert.equal(names.has(name), false, name);
  for (const tool of tools) {
    assert.ok(tool.title && tool.name.length <= 64, tool.name);
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name} ${hint}`);
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
  assert.equal(tools.find((tool) => tool.name === "cora_agent_update").annotations.destructiveHint, true);

  const called = await f.rpc(f.pass(owner), "tools/call", { name: "cora_agents_list", arguments: {} });
  assert.equal(called.body.result.isError, false);
  const map = await f.rpc(f.pass(owner), "tools/call", { name: "cora_configurations", arguments: { area: "secrets" } });
  const secretTools = JSON.parse(map.body.result.content[0].text).areas[0].tools.map((tool) => tool.name);
  assert.ok(secretTools.includes("cora_secrets_list"));
  assert.equal(secretTools.includes("cora_secret_set"), false);
  const refused = await f.rpc(f.pass(owner), "tools/call", { name: "cora_request", arguments: { path: "/api/state" } });
  assert.equal(refused.body.error.code, -32602);
  const user = f.app.store.panelUser(owner.sub);
  assert.equal(user.role, "owner");
  assert.equal(user.source, "cloud");
});

test("a gateway pass works once, only for this space, and only for people the space admits", async (t) => {
  const f = await fixture(t);
  const once = f.pass(owner);
  assert.equal((await f.rpc(once, "tools/list")).status, 200);
  assert.equal((await f.rpc(once, "tools/list")).status, 401);
  assert.equal((await f.rpc(f.pass(owner, "mcp:beta.usecora.test"), "tools/list")).status, 401);
  assert.equal((await f.rpc(f.pass(owner, "alpha.usecora.test"), "tools/list")).status, 401);
  assert.equal((await f.rpc(`${f.pass(owner)}x`, "tools/list")).status, 401);
  assert.equal((await f.rpc(f.pass(member), "tools/list")).status, 401);
  assert.equal((await f.rpc(f.pass({ ...member, emailVerified: false }), "tools/list")).status, 401);

  f.app.store.updateAccessPolicy({ domains: ["company.test"], emails: [] });
  const listed = await f.rpc(f.pass(member), "tools/list");
  assert.equal(listed.status, 200);
  assert.equal(f.app.store.panelUser(member.sub).role, "member");
  const denied = await f.rpc(f.pass(member), "tools/call", { name: "cora_settings_update", arguments: { historySize: 30 } });
  assert.equal(denied.body.result.isError, true);
  assert.equal(denied.body.result.structuredContent.status, 403);
});

test("without a pass or a token the MCP answers 401", async (t) => {
  const f = await fixture(t);
  const init = await f.rpc("", "initialize", {}, {});
  assert.equal(init.status, 401);
});

test("an installation grants an MCP gateway a public-profile token after the person signs in and approves", async (t) => {
  const f = await fixture(t);
  const verifier = "fixture-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ redirect_uri: "https://gateway.test/oauth/installation/callback", state: "st-1", code_challenge: challenge, client: "Claude" });
  const authorize = (query, cookie = "") => fetch(`${f.base}/mcp/authorize?${query}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });

  const hop = await authorize(params);
  assert.equal(hop.status, 200);
  assert.match(await hop.text(), /http-equiv="refresh" content="0;url=\/mcp\/authorize\?[^"]*hop=1/);
  const toLogin = await authorize(`${params}&hop=1`);
  assert.equal(toLogin.status, 302);
  assert.match(toLogin.headers.get("location"), /^https:\/\/usecora\.test\/go\/alpha\?next=%2Fmcp%2Fauthorize/);
  const elsewhere = new URLSearchParams({ ...Object.fromEntries(params), redirect_uri: "https://evil.test/cb" });
  assert.equal((await authorize(elsewhere)).status, 400);

  const cookie = await f.login(owner);
  const consent = await authorize(params, cookie);
  assert.equal(consent.status, 200);
  const page = await consent.text();
  assert.match(consent.headers.get("content-security-policy"), /form-action 'self' https:\/\/gateway\.test/);
  assert.match(page, /gateway\.test/);
  assert.match(page, /owner@example\.test/);
  const form = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
  const post = (fields, origin = f.base) => fetch(`${f.base}/mcp/authorize`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  assert.equal((await post({ ...form, decision: "allow" }, "https://evil.test")).status, 403);
  assert.equal((await post({ ...form, csrf: "forged", decision: "allow" })).status, 400);
  const denied = new URL((await post({ ...form, decision: "deny" })).headers.get("location"));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  const allowed = new URL((await post({ ...form, decision: "allow" })).headers.get("location"));
  assert.equal(allowed.origin + allowed.pathname, "https://gateway.test/oauth/installation/callback");
  assert.equal(allowed.searchParams.get("state"), "st-1");
  const code = allowed.searchParams.get("code");

  const token = (body) => fetch(`${f.base}/mcp/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await token({ code, code_verifier: "wrong-verifier", redirect_uri: params.get("redirect_uri") })).status, 400);
  const second = new URL((await post({ ...form, decision: "allow" })).headers.get("location")).searchParams.get("code");
  const issued = await token({ code: second, code_verifier: verifier, redirect_uri: params.get("redirect_uri") });
  assert.equal(issued.status, 200);
  const { access_token: access } = await issued.json();
  assert.match(access, /^cora_mcp_/);
  assert.equal((await token({ code: second, code_verifier: verifier, redirect_uri: params.get("redirect_uri") })).status, 400);

  const call = async (method) => (await fetch(`${f.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) })).json();
  assert.match((await call("initialize")).result.instructions, /^Cora is a team of AI agents/);
  const names = (await call("tools/list")).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("talk_to_agent"));
  assert.equal(names.includes("cora_request"), false);
  assert.equal(names.includes("cora_secret_set"), false);
  const records = f.app.store.value("panelMcpTokens", []);
  assert.equal(records.filter((record) => record.name === "Claude via gateway.test").length, 1);
  assert.equal(records.find((record) => record.name === "Claude via gateway.test").profile, "public");
});
