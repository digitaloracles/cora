import http from "node:http";
import { mailWorld } from "./mail-fixtures.js";

export const EARENDIL_KEY = "earendil_fixture-cora-studio-key";
export const EARENDIL_UNPAID = "earendil_fixture-unpaid-account";
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const projectId = { type: "string", description: "Project id from list_projects or create_project." };
const definitions = [
  { name: "list_projects", description: "Lists the projects.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "generate_speech", description: "Generates a take; then get_transcript and view_waveform, not listen_more.", inputSchema: schema({ project_id: projectId, text: { type: "string" } }, ["project_id", "text"]) },
  { name: "listen", description: "Listens to the mix and attaches the audio.", inputSchema: schema({ project_id: projectId, wait: { type: "boolean" } }, ["project_id"]) },
  { name: "view_waveform", description: "Returns a PNG.", inputSchema: schema({ project_id: projectId }, ["project_id"]) },
  { name: "get_transcript", description: "Every sentence with times.", inputSchema: schema({ project_id: projectId }, ["project_id"]) },
  { name: "video_add_picture", description: "Adds a picture from url or base64 data.", inputSchema: schema({ kind: { type: "string", enum: ["character", "backdrop"] }, url: { type: "string" }, data: { type: "string" }, name: { type: "string" } }, ["kind"]) },
  { name: "video_delete", description: "Deletes pictures or videos.", inputSchema: schema({ ids: { type: "array", items: { type: "string" } } }, ["ids"]), annotations: { destructiveHint: true } },
];

/** A stateless Streamable HTTP server like earendil.studio/api/mcp: no session id, 401 without a valid key, 402 without a plan. */
export async function fakeEarendil(t) {
  const calls = [], pictures = [];
  const state = { refuse: 0, revoked: false };
  let base;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
    if (req.url !== "/api/mcp" || req.method !== "POST") return send(405, { error: "POST only" });
    const credential = req.headers.authorization || "";
    calls.push({ method: body.method, name: body.params?.name, credential, session: req.headers["mcp-session-id"] });
    if (!credential.startsWith("Bearer earendil_")) return send(401, { error: "An Eärendil agent key is required" });
    if (credential === `Bearer ${EARENDIL_UNPAID}`) return send(402, { error: "An active subscription is required.", code: "subscription_required" });
    if (credential !== `Bearer ${EARENDIL_KEY}` || state.revoked) return send(401, { error: "This agent key is revoked or expired." });
    if (state.refuse) return send(state.refuse, { error: "fixture refusal" });
    if (body.method === "initialize") return send(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "earendil-studio", title: "Eärendil studio", version: "1.4.0+fixture" }, instructions: "Workflow: list_projects or create_project → generate_speech → listen." } });
    if (body.method?.startsWith("notifications/")) { res.writeHead(202); res.end(); return; }
    const reply = (result) => send(200, { jsonrpc: "2.0", id: body.id, result });
    const ok = (data, media = []) => reply({ content: [{ type: "text", text: JSON.stringify(data) }, ...media], structuredContent: data, isError: false });
    if (body.method === "tools/list") return reply({ tools: definitions });
    if (body.method !== "tools/call") return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    const { name, arguments: args = {} } = body.params;
    if (name === "list_projects") return ok({ projects: [{ id: "p1", name: "Guida" }], echo: credential });
    if (name === "generate_speech") return reply({ content: [{ type: "text", text: "Unknown voice." }], isError: true });
    if (name === "listen") return ok({ heard: "mix", words: [["Ciao", 0, 0.4]] }, [{ type: "audio", data: Buffer.from("RIFF-fixture-wav").toString("base64"), mimeType: "audio/wav" }]);
    if (name === "view_waveform") return ok({ width: 1600 }, [{ type: "image", data: Buffer.from("fixture-png").toString("base64"), mimeType: "image/png" }]);
    if (name === "get_transcript") return ok({ sentences: Array.from({ length: 900 }, (_, i) => ({ text: `Frase numero ${i} della guida audio.`, start: i, end: i + 0.9 })), duration: 900 });
    if (name === "video_add_picture") { pictures.push(args); return ok({ picture: { id: "pic1", name: args.name } }); }
    return ok({ name, args });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
  t?.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { base, endpoint: `${base}/api/mcp`, calls, pictures, state, definitions };
}

export async function earendilWorld(t = null) {
  const f = await mailWorld(t), remote = await fakeEarendil(t), connectors = f.app.keyConnectors;
  connectors.earendilApi = remote.endpoint;
  const made = await f.call("/api/agents", { method: "POST", body: { name: "Earendil reviewer", tools: false } });
  return { ...f, remote, connectors, agent: f.app.store.agent(made.data.id) };
}
