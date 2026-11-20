import http from "node:http";
import { mailWorld } from "./mail-fixtures.js";

export const HIGGSFIELD_ACCESS = "hf_fixture_cora_access";
export const HIGGSFIELD_REFRESH = "hf_fixture_cora_refresh";
const RESOURCE = "https://mcp.higgsfield.ai/mcp";
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const idToken = () => ["e30", Buffer.from(JSON.stringify({ email: "owner@fixture.test", sub: "user_fixture" })).toString("base64url"), "sig"].join(".");
const definitions = [
  { name: "list_models", description: "List the models; pick one for generate_image.", annotations: { readOnlyHint: true }, inputSchema: schema({ kind: { type: "string", description: "image or video, as in generate_image" } }) },
  { name: "generate_image", description: "Generate an image", inputSchema: schema({ prompt: { type: "string" }, model: { type: "string" } }, ["prompt"]) },
  { name: "Generate-Video", description: "Generate a video", inputSchema: schema({ prompt: { type: "string" } }, ["prompt"]) },
  { name: "delete_generation", description: "Delete a generation", annotations: { destructiveHint: true }, inputSchema: schema({ id: { type: "string" } }, ["id"]) },
  { name: "history", description: "Past generations", annotations: { readOnlyHint: true }, inputSchema: schema({}) },
  { name: "call", description: "A remote tool whose Cora name would shadow the gateway", inputSchema: schema({}) },
];

export async function fakeHiggsfield(t) {
  const calls = [], registrations = [], tokens = [], revocations = [];
  const state = { session: 0, refuse: 0, refreshCount: 0, revoked: false };
  let base;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body = {}; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const url = new URL(req.url, base);
    const send = (status, data, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(data === undefined ? "" : JSON.stringify(data)); };
    if (url.pathname === "/register") { registrations.push(body); return send(201, { client_id: "fixture-higgsfield-client", token_endpoint_auth_method: "none" }); }
    if (url.pathname === "/token") {
      tokens.push(body);
      if (body.client_id !== "fixture-higgsfield-client" || body.client_secret || body.resource !== RESOURCE) return send(400, { error: "invalid_client" });
      if (body.grant_type === "authorization_code") {
        if (body.code !== "fixture-code" || !body.code_verifier || !registrations.some((r) => r.redirect_uris.includes(body.redirect_uri))) return send(400, { error: "invalid_grant" });
        state.revoked = false;
        return send(200, { access_token: HIGGSFIELD_ACCESS, refresh_token: HIGGSFIELD_REFRESH, expires_in: 3600, token_type: "Bearer", id_token: idToken() });
      }
      if (body.grant_type === "refresh_token" && body.refresh_token === HIGGSFIELD_REFRESH && state.refreshCount++ === 0) return send(200, { access_token: `${HIGGSFIELD_ACCESS}-renewed`, refresh_token: `${HIGGSFIELD_REFRESH}-rotated`, expires_in: 3600 });
      return send(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/revoke") { revocations.push(body); if (body.client_id !== "fixture-higgsfield-client") return send(401, { error: "invalid_client" }); state.revoked = true; return send(200, {}); }
    if (url.pathname !== "/mcp") return send(404, {});
    const credential = req.headers.authorization || "";
    calls.push({ ...body, credential, session: req.headers["mcp-session-id"] });
    if (state.revoked || ![HIGGSFIELD_ACCESS, `${HIGGSFIELD_ACCESS}-renewed`].some((token) => credential === `Bearer ${token}`)) return send(401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
    if (state.refuse && body.method === "tools/call") return send(state.refuse, { error: "fixture refusal" });
    if (body.method === "initialize") return send(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "higgsfield", version: "9" }, instructions: "Call list_models first, then generate_image." } }, { "Mcp-Session-Id": `hf-${++state.session}` });
    if (body.method === "notifications/initialized") return send(202);
    const reply = (result) => send(200, { jsonrpc: "2.0", id: body.id, result });
    if (body.method === "tools/list") return reply(body.params?.cursor ? { tools: definitions.slice(2) } : { tools: definitions.slice(0, 2), nextCursor: "page-2" });
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      if (!definitions.some((tool) => tool.name === name)) return reply({ isError: true, content: [{ type: "text", text: "unknown tool" }] });
      if (name === "generate_image") return reply({ content: [{ type: "text", text: JSON.stringify({ id: "gen_1", url: "https://cdn.fixture.test/gen_1.png", echo: credential }) }, { type: "image", mimeType: "image/png", data: Buffer.from("fixture-png").toString("base64") }] });
      if (name === "history") return reply({ structuredContent: { items: Array.from({ length: 400 }, (_, i) => ({ id: `gen_${i}`, prompt: "x".repeat(100) })), total: 400 }, content: [] });
      return reply({ structuredContent: { name, args }, content: [] });
    }
    return send(400, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
  t?.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { base, calls, registrations, tokens, revocations, state, definitions };
}

export async function higgsfieldWorld(t = null) {
  const f = await mailWorld(t), remote = await fakeHiggsfield(t), connectors = f.app.keyConnectors;
  connectors.higgsfieldApi = `${remote.base}/mcp`;
  connectors.oauthUrls.higgsfield = Object.fromEntries(["authorize", "token", "register", "revoke"].map((name) => [name, `${remote.base}/${name}`]));
  const made = await f.call("/api/agents", { method: "POST", body: { name: "Higgsfield maker", tools: false } });
  const agent = f.app.store.agent(made.data.id);
  return { ...f, remote, connectors, agent, async connectOAuth() {
    const start = await f.call("/api/connectors/keys/higgsfield/authorize?mode=oauth", { method: "POST" });
    const url = new URL(start.data.url), state = url.searchParams.get("state");
    const record = await connectors.finishOAuth("higgsfield", { state, code: "fixture-code" }, state);
    return { record, url };
  } };
}
