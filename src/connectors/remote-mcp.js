import { createHash } from "node:crypto";
import { defined, fail } from "./tooling.js";

const PROTOCOL = "2025-06-18";
const sessions = new Map();
const SESSION_MS = 10 * 60000;

const header = (headers, name) => {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : "";
};

/** The JSON-RPC answer inside a Streamable HTTP response: plain JSON, or the matching event of an SSE stream. */
export function rpcAnswer({ data, text: body, headers }, id) {
  if (data && typeof data === "object") return Array.isArray(data) ? data.find((item) => item?.id === id) || null : data.id === id ? data : null;
  const raw = typeof body === "string" ? body : "";
  if (!raw || !/event-stream/i.test(header(headers, "content-type")) && !/^\s*(event|data|id|:)/m.test(raw)) return null;
  let found = null;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const payload = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!payload) continue;
    let message;
    try { message = JSON.parse(payload); } catch { continue; }
    if (message?.id === id) found = message;
    if (message?.id === id) break;
  }
  return found;
}

/** Shared Streamable HTTP transport (also stateless servers that give no session id); credentials stay in the backend. */
export function mcpClient({ name, id, endpoint, headers: authorization = {}, request, writeFile = null, refusal }) {
  const key = createHash("sha256").update(`${name}\n${endpoint}\n${JSON.stringify(authorization)}`).digest("hex").slice(0, 32);
  let serial = 0;
  const post = (message, session = "", timeout = 30000) => request(endpoint, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: message, timeout,
  });
  const open = async () => {
    const cached = sessions.get(key);
    if (cached && cached.expires > Date.now()) return cached.id;
    const id = ++serial;
    const answer = await post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Cora", version: "1.0.0" } } });
    if (answer.status < 200 || answer.status >= 300) refusal(answer.status, answer.data);
    const reply = rpcAnswer(answer, id);
    if (!reply?.result) fail(`${name} did not open the MCP session${reply?.error?.message ? `: ${reply.error.message}` : ""}`);
    const session = header(answer.headers, "mcp-session-id");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    for (const [name, item] of sessions) if (item.expires < Date.now()) sessions.delete(name);
    sessions.set(key, { id: session, expires: Date.now() + SESSION_MS, server: reply.result });
    return session;
  };
  const rpc = async (method, params, timeout) => {
    for (let attempt = 0; ; attempt += 1) {
      const session = await open();
      const id = ++serial;
      const answer = await post({ jsonrpc: "2.0", id, method, params }, session, timeout);
      // An expired session answers 404: open a new one once.
      if (answer.status === 404 && session && attempt === 0) { sessions.delete(key); continue; }
      if (answer.status < 200 || answer.status >= 300) { if (answer.status === 401) sessions.delete(key); refusal(answer.status, answer.data); }
      const reply = rpcAnswer(answer, id);
      if (!reply) fail(`${name} gave no answer to the call`);
      if (reply.error) fail(`${name}: ${String(reply.error.message || reply.error.code || "error").slice(0, 1500)}`);
      sessions.set(key, { ...sessions.get(key), id: session, expires: Date.now() + SESSION_MS });
      return reply.result ?? {};
    }
  };
  /** Calls one remote tool and answers its structured result; images go to the agent's computer. */
  const tool = async (toolName, args = {}, { timeout = 60000 } = {}) => {
    const result = await rpc("tools/call", { name: toolName, arguments: defined(args) }, timeout);
    const content = Array.isArray(result.content) ? result.content : [];
    const words = content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (result.isError) fail(`${name}: ${words.slice(0, 2000) || "the tool failed"}`);
    let data = result.structuredContent;
    if (data === undefined && words) { try { data = JSON.parse(words); } catch { data = { text: words }; } }
    for (const [kind, field, fallback] of [["image", "images", "png"], ["audio", "audio", "wav"]]) {
      const media = content.filter((part) => part.type === kind && part.data);
      if (!media.length) continue;
      const saved = [];
      for (const [index, item] of media.entries()) {
        if (!writeFile) break;
        const extension = (String(item.mimeType || `${kind}/${fallback}`).split("/")[1] || fallback).replace(/^x-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 5) || fallback;
        const path = `/home/agent/work/${id}/${toolName}-${Date.now()}-${index + 1}.${extension}`;
        try { await writeFile(path, Buffer.from(item.data, "base64")); saved.push(path); } catch { /* the text answer is still useful */ }
      }
      data = { ...(data && typeof data === "object" && !Array.isArray(data) ? data : { result: data }), [field]: saved.length ? saved : `${media.length} ${kind} file(s) not saved` };
    }
    for (const part of content.filter((item) => item.type === "resource_link" || item.type === "resource")) {
      data = { ...(data && typeof data === "object" && !Array.isArray(data) ? data : { result: data }), resources: [...(data?.resources || []), defined({ uri: part.uri || part.resource?.uri, name: part.name, text: part.resource?.text?.slice(0, 20000) })] };
    }
    return data ?? {};
  };
  /** What the server said when the session opened: serverInfo and instructions. */
  const server = () => sessions.get(key)?.server || null;
  return { rpc, tool, server };
}
