import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { imageMime } from "./images.js";

/**
 * Loopback HTTP endpoint that the MCP server (spawned by the Claude Code or
 * Codex CLI) calls to run cora's tools inside the right agent context. It
 * listens on its own random port, never on the panel's port, and every run
 * gets its own random token that dies with the run.
 */
export class ToolBridge {
  constructor() {
    this.runs = new Map();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.url = "";
  }

  start() {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => {
      this.url = `http://127.0.0.1:${this.server.address().port}`;
      resolve(this.url);
    }));
  }

  stop() {
    this.runs.clear();
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(resolve));
  }

  /**
   * Register a run: `tools` are definitions, `execute(name, args)` returns {text, image?}.
   * `relay` ({ base, token(), headers? }) lets the run's CLI reach a model endpoint through
   * `<url>/relay/…` with the run's token as its key: Cora swaps in the account's own fresh
   * token, so a subscription login never sits in a CLI's environment or outlives the run.
   */
  register({ tools = [], execute = async () => ({ text: "" }), ttlMs = 20 * 60 * 1000, relay = null }) {
    const token = randomBytes(32).toString("hex");
    const timer = setTimeout(() => this.runs.delete(token), ttlMs);
    this.runs.set(token, { tools, execute, relay });
    return { token, url: this.url, relayUrl: relay ? `${this.url}/relay` : "", dispose: () => { clearTimeout(timer); this.runs.delete(token); } };
  }

  find(req) {
    const header = String(req.headers.authorization || req.headers["x-api-key"] || "");
    const given = Buffer.from(header.replace(/^Bearer /, ""));
    for (const [token, run] of this.runs) {
      const expected = Buffer.from(token);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return run;
    }
    return null;
  }

  async handle(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (String(req.url || "").startsWith("/relay/")) return this.relay(req, res, reply);
    if (req.url === "/mcp") return this.mcp(req, res, reply);
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });
    const run = this.find(req);
    if (!run) return reply(401, { error: "unknown run" });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return reply(400, { error: "invalid JSON" }); }
    if (req.url === "/tools/list") return reply(200, { tools: run.tools });
    if (req.url === "/tools/call") {
      const name = String(body.name || "");
      if (!run.tools.some((tool) => tool.name === name)) return reply(200, { text: `error: the tool ${name} is not available now` });
      try {
        const out = await run.execute(name, body.arguments && typeof body.arguments === "object" ? body.arguments : {});
        return reply(200, { text: out.text, image: out.image || null, ...(out.image ? { mimeType: out.mimeType || imageMime(out.image) } : {}) });
      } catch (error) {
        return reply(200, { text: `error: ${error.message}` });
      }
    }
    return reply(404, { error: "not found" });
  }

  /**
   * The run's tools as an MCP server over Streamable HTTP (JSON answers, no sessions), for a CLI
   * that connects to a URL instead of starting src/mcp-server.js: the same tools, the same token.
   */
  async mcp(req, res, reply) {
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });
    const run = this.find(req);
    if (!run) return reply(401, { error: "unknown run" });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    if (message.id === undefined || message.id === null) {
      res.writeHead(202);
      return res.end();
    }
    const answer = (result) => reply(200, { jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text) => reply(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    if (message.method === "initialize") return answer({ protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cora", version: "0.1.0" } });
    if (message.method === "ping") return answer({});
    if (message.method === "tools/list") return answer({ tools: run.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
    if (message.method === "tools/call") {
      const name = String(message.params?.name || "");
      const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
      if (!run.tools.some((tool) => tool.name === name)) return answer({ content: [{ type: "text", text: `error: the tool ${name} is not available now` }], isError: true });
      let out;
      try { out = await run.execute(name, args); } catch (error) { out = { text: `error: ${error.message}` }; }
      const content = [{ type: "text", text: String(out.text ?? "") }];
      if (out.image) content.push({ type: "image", data: out.image, mimeType: out.mimeType || imageMime(out.image) || "image/jpeg" });
      return answer({ content, isError: String(out.text).startsWith("error:") });
    }
    return fail(-32601, `method not found: ${message.method}`);
  }

  /** One model request of a run, forwarded to its endpoint with the account's token; the answer streams back as it comes. */
  async relay(req, res, reply) {
    const run = this.find(req);
    if (!run?.relay) return reply(401, { error: "unknown run" });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "method not allowed" });
    const path = String(req.url).slice("/relay".length);
    if (!/^\/[\w./-]*(\?[^#]*)?$/.test(path) || path.includes("..")) return reply(400, { error: "invalid path" });
    let token;
    try { token = await run.relay.token(); }
    catch (error) { return reply(401, { error: { message: error.message || "account not available" } }); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...(run.relay.headers || {}), Authorization: `Bearer ${token}` };
    for (const name of ["content-type", "accept", "user-agent", "anthropic-version", "openai-beta"]) if (req.headers[name]) headers[name] = req.headers[name];
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    let upstream;
    try {
      upstream = await fetch(`${String(run.relay.base).replace(/\/$/, "")}${path}`, {
        method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined, signal: controller.signal,
      });
    } catch (error) {
      if (res.headersSent) return res.end();
      return reply(502, { error: { message: `upstream unreachable: ${error.message}` } });
    }
    const out = {};
    for (const name of ["content-type", "retry-after", "x-request-id"]) { const value = upstream.headers.get(name); if (value) out[name] = value; }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    try { for await (const chunk of upstream.body) res.write(chunk); } catch {}
    res.end();
  }
}
