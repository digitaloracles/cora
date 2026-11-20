import assert from "node:assert/strict";
import { test } from "node:test";
import { higgsfieldWorld, HIGGSFIELD_ACCESS, HIGGSFIELD_REFRESH } from "./higgsfield-fixtures.js";
import { connectorCatalog, connectorForTool } from "../src/connectors/index.js";
import { coraName } from "../src/connectors/higgsfield.js";

const grant = (f, agents) => f.call("/api/connectors/keys/higgsfield", { method: "PUT", body: { agents } });

test("Higgsfield signs in with a dynamically registered public client, PKCE and the MCP resource", async (t) => {
  const f = await higgsfieldWorld(t);
  const card = connectorCatalog({ origin: "https://cora.test" }).find((item) => item.id === "higgsfield");
  assert.equal(card.secret, "CORA_HIGGSFIELD_TOKEN"); assert.ok(card.oauth); assert.equal(card.redirect, "https://cora.test/connectors/oauth/higgsfield/callback");
  const key = await f.call("/api/connectors/keys/higgsfield", { method: "POST", body: { mode: "key", token: "hf-key" } });
  assert.equal(key.status, 400, "there is no key mode: the MCP server takes only the account sign-in");
  assert.equal(f.app.store.vaultSecret("CORA_HIGGSFIELD_TOKEN"), null);
  const { record, url } = await f.connectOAuth();
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.higgsfield.ai/mcp");
  assert.equal(url.searchParams.get("scope"), "openid email offline_access");
  assert.equal(f.remote.registrations.length, 1);
  assert.equal(f.remote.registrations[0].token_endpoint_auth_method, "none");
  assert.deepEqual(f.remote.registrations[0].redirect_uris, [url.searchParams.get("redirect_uri")]);
  assert.ok(f.remote.tokens[0].code_verifier); assert.equal(f.remote.tokens[0].client_secret, undefined);
  assert.equal(record.status, "connected"); assert.equal(record.account, "owner@fixture.test"); assert.equal(record.remoteTools.length, 5, "the remote tool named call is skipped");
  const listed = JSON.stringify((await f.call("/api/connectors")).data);
  for (const secret of [HIGGSFIELD_ACCESS, HIGGSFIELD_REFRESH]) assert.ok(!listed.includes(secret));
});

test("Higgsfield shows its main tools whole, reaches the others through tool_info and call, only for authorised agents and never with the token", async (t) => {
  const f = await higgsfieldWorld(t); await f.connectOAuth();
  assert.deepEqual(f.connectors.toolsFor(f.agent), []);
  assert.match((await f.connectors.runTool(f.agent, "higgsfield_call", { name: "history" })).text, /not authorised/);
  await grant(f, [f.agent.id]);
  const tools = f.connectors.toolsFor(f.agent);
  assert.deepEqual(tools.map((tool) => tool.name), ["higgsfield_generate_image", "higgsfield_generate_video", "higgsfield_tool_info", "higgsfield_call"]);
  assert.equal(coraName("higgsfield_generate_image"), "higgsfield_generate_image");
  for (const name of ["higgsfield_generate_video", "higgsfield_tool_info", "higgsfield_call"]) assert.equal(connectorForTool(name).id, "higgsfield");
  assert.match(tools[0].description, /How Higgsfield works: Call list_models first, then higgsfield_generate_image\./);
  assert.match(tools[0].description, /credits/);
  assert.match(tools[2].description, /\(list_models, delete_generation, history\)/);
  assert.doesNotMatch(JSON.stringify(tools), /A remote tool whose Cora name/, "a remote tool cannot shadow the gateway");
  const listed = JSON.parse((await f.connectors.runTool(f.agent, "higgsfield_tool_info", {})).text);
  assert.deepEqual(listed.tools, [{ name: "list_models", readOnly: true }, { name: "delete_generation", destructive: true }, { name: "history", readOnly: true }]);
  const info = JSON.parse((await f.connectors.runTool(f.agent, "higgsfield_tool_info", { name: "list_models" })).text);
  assert.match(info.description, /pick one for higgsfield_generate_image/);
  assert.match(info.parameters.properties.kind.description, /as in generate_image$/);
  assert.equal(info.readOnly, true); assert.equal(info.spends, undefined);
  const destructive = JSON.parse((await f.connectors.runTool(f.agent, "higgsfield_tool_info", { name: "higgsfield_delete_generation" })).text);
  assert.match(destructive.destructive, /explicit user request/); assert.match(destructive.spends, /credits/);
  const written = [];
  const image = await f.connectors.runTool(f.agent, "higgsfield_generate_image", { prompt: "a fox" }, { writeFile: async (path, bytes) => written.push({ path, bytes }) });
  assert.match(image.text, /cdn\.fixture\.test\/gen_1\.png/);
  assert.doesNotMatch(image.text, new RegExp(HIGGSFIELD_ACCESS));
  assert.match(written[0].path, /^\/home\/agent\/work\/higgsfield\/generate_image-.*\.png$/);
  assert.equal(written[0].bytes.toString(), "fixture-png");
  const video = await f.connectors.runTool(f.agent, "higgsfield_generate_video", { prompt: "waves" });
  assert.match(video.text, /Generate-Video/, "the remote name is called as the server spells it");
  const deleted = JSON.parse((await f.connectors.runTool(f.agent, "higgsfield_call", { name: "delete_generation", arguments: { id: "gen_9" } })).text);
  assert.deepEqual(deleted, { name: "delete_generation", args: { id: "gen_9" } });
  const long = await f.connectors.runTool(f.agent, "higgsfield_call", { name: "higgsfield_history" }, { writeFile: async (path, bytes) => written.push({ path, bytes }) });
  assert.match(long.text, /full_answer/);
  assert.equal(JSON.parse(written.at(-1).bytes.toString()).items.length, 400);
  assert.match((await f.connectors.runTool(f.agent, "higgsfield_call", { name: "history", arguments: [1] })).text, /arguments must be an object/);
  for (const answer of [await f.connectors.runTool(f.agent, "higgsfield_call", { name: "nope" }), await f.connectors.runTool(f.agent, "higgsfield_tool_info", { name: "nope" }), await f.connectors.runTool(f.agent, "higgsfield_unknown", {})])
    assert.match(answer.text, /unavailable/);
  assert.equal(f.remote.calls.filter((call) => call.method === "tools/call" && call.params.name === "call").length, 0);
  await grant(f, []);
  assert.match((await f.connectors.runTool(f.agent, "higgsfield_call", { name: "history" })).text, /not authorised/);
});

test("Higgsfield renews the token once, reports credit refusals once and revokes the grant on disconnect", async (t) => {
  const f = await higgsfieldWorld(t); await f.connectOAuth();
  await grant(f, [f.agent.id]);
  f.connectors.access.get("CORA_HIGGSFIELD_TOKEN").expires_at = 0;
  const answers = await Promise.all([1, 2, 3].map(() => f.connectors.runTool(f.agent, "higgsfield_list_models", {})));
  assert.ok(answers.every((answer) => !answer.text.startsWith("error:")), answers.map((a) => a.text).join("\n"));
  assert.equal(f.remote.state.refreshCount, 1);
  for (const status of [402, 429]) {
    f.remote.state.refuse = status;
    const before = f.remote.calls.filter((call) => call.method === "tools/call").length;
    assert.match((await f.connectors.runTool(f.agent, "higgsfield_generate_image", { prompt: "x" })).text, /do not retry automatically/);
    assert.equal(f.remote.calls.filter((call) => call.method === "tools/call").length - before, 1);
  }
  f.remote.state.refuse = 0;
  const gone = await f.call("/api/connectors/keys/higgsfield", { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.equal(f.remote.revocations.at(-1).token, `${HIGGSFIELD_REFRESH}-rotated`);
  assert.equal(f.remote.revocations.at(-1).client_id, "fixture-higgsfield-client", "a public client names itself to the revocation endpoint");
  assert.equal(f.app.store.vaultSecret("CORA_HIGGSFIELD_TOKEN"), null);
  assert.equal(f.app.store.vaultSecret("CORA_HIGGSFIELD_TOKEN_CLIENT_ID"), null);
  assert.deepEqual(f.connectors.toolsFor(f.agent), []);
  assert.match((await f.connectors.runTool(f.agent, "higgsfield_list_models", {})).text, /not connected/);
});
