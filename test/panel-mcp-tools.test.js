import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS, AREAS } from "../src/panel-mcp-tools.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

async function mcpWorld(t) {
  const f = await knowledgeWorld(); t.after(f.close);
  const issue = async (actor, body = {}) => {
    const response = await f.request(actor, "/api/mcp/tokens", { method: "POST", body: { name: "Specific tools client", ...body } });
    assert.equal(response.status, 201); return response.data;
  };
  const rpc = async (access, method, params = {}, path = "/mcp") => {
    const response = await fetch(f.base + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${access.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const call = async (access, name, args = {}) => {
    const reply = await rpc(access, "tools/call", { name, arguments: args });
    assert.equal(reply.status, 200);
    if (reply.data.error) return { rpcError: reply.data.error };
    return reply.data.result;
  };
  return { ...f, issue, rpc, call };
}

test("the panel MCP lists one specific tool per panel action with its own input schema", async (t) => {
  const f = await mcpWorld(t), access = await f.issue(f.alice), reader = await f.issue(f.alice, { readOnly: true });
  const tools = (await f.rpc(access, "tools/list")).data.result.tools;
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names are unique");
  assert.ok(tools.length > 150, `specific tools: ${tools.length}`);
  for (const name of ["cora_agents_list", "cora_agent_overview", "cora_agent_update", "cora_agent_skill_install", "cora_agent_skill_set_enabled", "cora_connectors_list", "cora_connector_set_agents", "cora_provider_key_set", "cora_subscription_login", "cora_settings_update", "cora_activity", "cora_trace_get", "cora_routine_create", "cora_artifact_upload", "cora_secret_set", "cora_configurations", "cora_request"]) assert.ok(names.includes(name), name);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 40, tool.name);
  }
  const update = tools.find((tool) => tool.name === "cora_agent_update");
  assert.deepEqual(update.inputSchema.required, ["agent_id"]);
  for (const field of ["name", "personality", "character", "model", "subscriptionId", "effort", "tools", "enabled", "voice", "channelIds"]) assert.ok(update.inputSchema.properties[field], field);
  assert.equal(update.inputSchema.additionalProperties, false);
  assert.deepEqual(tools.find((tool) => tool.name === "cora_agent_skill_set_enabled").inputSchema.required, ["agent_id", "skill", "enabled"]);
  assert.equal(tools.find((tool) => tool.name === "cora_agent_delete").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "cora_activity").annotations.readOnlyHint, true);

  const readTools = (await f.rpc(reader, "tools/list")).data.result.tools;
  const writes = TOOLS.filter((tool) => tool.method !== "GET" && !tool.composite).map((tool) => tool.name);
  assert.ok(!readTools.some((tool) => writes.includes(tool.name)), "a read-only access lists no write tool");
  assert.ok(readTools.some((tool) => tool.name === "cora_agent_overview"));
  const refused = await f.call(reader, "cora_agent_create", { name: "Nope" });
  assert.match(refused.rpcError.message, /Unknown Cora tool/);

  const guide = JSON.parse((await f.call(access, "cora_configurations", { area: "skills" })).content[0].text);
  assert.deepEqual(guide.areas.map((area) => area.id), ["skills"]);
  assert.ok(guide.areas[0].tools.some((tool) => tool.name === "cora_agent_skill_set_enabled" && tool.method === "PATCH"));
  assert.equal(JSON.parse((await f.call(access, "cora_configurations")).content[0].text).areas.length, AREAS.length);

  const scoped = (await f.rpc(access, "tools/list", {}, "/mcp?areas=skills,logs")).data.result.tools;
  assert.ok(scoped.every((tool) => ["skills", "logs"].includes(TOOLS.find((item) => item.name === tool.name)?.area) || ["cora_configurations", "cora_request"].includes(tool.name)));
  assert.ok(scoped.some((tool) => tool.name === "cora_activity") && !scoped.some((tool) => tool.name === "cora_agent_update"));
  assert.equal((await f.rpc(access, "tools/list", {}, "/mcp?areas=nothing")).status, 400);
  assert.equal((await f.rpc(access, "tools/call", { name: "cora_agent_update", arguments: { agent_id: "x" } }, "/mcp?areas=skills")).data.error.code, -32602);
});

test("an external agent drives and reads a whole agent through the specific tools, as the panel would", async (t) => {
  const f = await mcpWorld(t), alice = await f.issue(f.alice), bob = await f.issue(f.bob), owner = await f.issue(f.admin);
  const created = await f.call(alice, "cora_agent_create", { name: "Remote", personality: "Set from outside", tools: false, enabled: false, effort: "high", character: { enabled: true, scores: { analysis: 17 } } });
  assert.equal(created.structuredContent.status, 201, JSON.stringify(created.structuredContent));
  const agent = created.structuredContent.data;
  assert.equal(f.app.store.agent(agent.id).personality, "Set from outside");
  assert.equal(f.app.store.agent(agent.id).character.scores.analysis, 17);

  const updated = await f.call(alice, "cora_agent_update", { agent_id: agent.id, chattiness: 0.2, voiceLanguage: "en" });
  assert.equal(updated.isError, false);
  assert.equal(f.app.store.agent(agent.id).chattiness, 0.2);
  assert.equal(f.app.store.agent(agent.id).personality, "Set from outside", "fields left out stay");
  assert.equal((await f.call(alice, "cora_agent_update", { agent_id: agent.id, unknownField: 1 })).structuredContent.status, 200, "undeclared fields never reach the API");
  assert.equal(f.app.store.agent(agent.id).unknownField, undefined);
  assert.equal((await f.call(alice, "cora_agent_update", {})).rpcError.code, -32602);
  assert.equal((await f.call(alice, "cora_agent_get", { agent_id: "../settings" })).rpcError.code, -32602);

  assert.equal((await f.call(bob, "cora_agent_get", { agent_id: agent.id })).structuredContent.status, 403, "another person's private agent stays closed");
  assert.equal((await f.call(bob, "cora_agent_update", { agent_id: agent.id, personality: "hijack" })).structuredContent.status, 403);

  const routine = await f.call(alice, "cora_routine_create", { agent_id: agent.id, kind: "routine", name: "Daily check", schedule: "0 9 * * 1-5", channelId: "web-" + agent.id, prompt: "Check the inbox" });
  assert.equal(routine.structuredContent.status, 201, JSON.stringify(routine.structuredContent));
  const listed = await f.call(alice, "cora_routines_list", { agentId: agent.id });
  assert.deepEqual(listed.structuredContent.data.routines.map((item) => item.name), ["Daily check"]);
  assert.equal((await f.call(alice, "cora_routine_update", { routine_id: routine.structuredContent.data.id, enabled: false })).structuredContent.data.enabled, false);

  const memory = await f.call(alice, "cora_agent_memory_add", { agent_id: agent.id, text: "Remote fact", pinned: true });
  assert.equal(memory.structuredContent.status, 201);

  const overview = (await f.call(alice, "cora_agent_overview", { agent_id: agent.id })).structuredContent;
  assert.equal(overview.status, 200);
  assert.equal(overview.data.profile.name, "Remote");
  assert.ok(Array.isArray(overview.data.connectors));
  assert.deepEqual(overview.data.routines.map((item) => item.name), ["Daily check"]);
  assert.ok(JSON.stringify(overview.data.memory).includes("Remote fact"));
  for (const section of ["owners", "permissions", "skills", "brain", "email", "mailbox", "desktop", "github", "goals", "turns"]) assert.ok(section in overview.data, section);
  assert.equal((await f.call(bob, "cora_agent_overview", { agent_id: agent.id })).structuredContent.status, 403);

  const agents = (await f.call(alice, "cora_agents_list")).structuredContent.data.agents.map((item) => item.id);
  assert.ok(agents.includes(agent.id));
  assert.ok(!(await f.call(bob, "cora_agents_list")).structuredContent.data.agents.some((item) => item.id === agent.id));

  assert.equal((await f.call(alice, "cora_settings_update", { language: "en" })).structuredContent.status, 403, "space settings stay with the space owner");
  assert.equal((await f.call(alice, "cora_provider_key_set", { provider: "ollama", key: "fixture-key" })).structuredContent.status, 403);
  const settings = await f.call(owner, "cora_settings_update", { language: "en", historySize: 40 });
  assert.equal(settings.structuredContent.status, 200);
  assert.equal(f.app.store.settings.language, "en"); assert.equal(f.app.store.settings.historySize, 40);
  assert.equal((await f.call(owner, "cora_settings_get")).structuredContent.data.settings.historySize, 40);

  const models = (await f.call(alice, "cora_models_list")).structuredContent.data;
  assert.ok(Array.isArray(models.models) && models.providers && "keys" in models);
  const connectors = (await f.call(alice, "cora_connectors_list")).structuredContent.data;
  assert.ok(connectors.catalog.some((item) => item.id === "linear"));
  assert.ok(Array.isArray((await f.call(alice, "cora_activity")).structuredContent.data));
  assert.ok(Array.isArray((await f.call(alice, "cora_agent_traces", { agent_id: agent.id, limit: 5 })).structuredContent.data));
  assert.equal((await f.call(alice, "cora_usage", { days: 30 })).structuredContent.data.days, 30);
  assert.equal((await f.call(alice, "cora_cron_preview", { expr: "0 9 * * 1-5" })).structuredContent.data.next.length, 3);

  assert.equal((await f.call(alice, "cora_routine_delete", { routine_id: routine.structuredContent.data.id })).structuredContent.status, 200);
  assert.equal(f.app.store.routine(routine.structuredContent.data.id), null);
  assert.equal((await f.call(alice, "cora_agent_delete", { agent_id: agent.id })).structuredContent.status, 200);
  assert.equal(f.app.store.agent(agent.id), null);
});

test("artifacts and secrets through the specific tools: upload a commit, read a file back, store a secret without ever returning it", async (t) => {
  const f = await mcpWorld(t), owner = await f.issue(f.admin);
  const folder = await f.call(owner, "cora_artifact_folder_create", { path: "mcp/report", title: "Report", description: "MCP test", kind: "files", policy: "direct" });
  assert.equal(folder.structuredContent.status, 201, JSON.stringify(folder.structuredContent));
  const folderId = folder.structuredContent.data.id;
  const upload = await f.call(owner, "cora_artifact_upload", { folder_id: folderId, files: [{ path: "notes/readme.md", content: "# Hello from MCP\n" }, { path: "data.bin", base64: Buffer.from([1, 2, 3]).toString("base64") }], message: "First upload" });
  assert.equal(upload.structuredContent.status, 201, JSON.stringify(upload.structuredContent));
  const read = (await f.call(owner, "cora_artifact_folder_get", { folder_id: folderId })).structuredContent.data;
  assert.deepEqual(read.tree.map((file) => file.path).sort(), ["data.bin", "notes/readme.md"]);
  const commitId = read.commits[0].id;
  const file = await f.call(owner, "cora_artifact_file_read", { commit_id: commitId, file_path: "notes/readme.md" });
  assert.equal(file.structuredContent.status, 200);
  assert.match(JSON.stringify(file.structuredContent.data), /Hello from MCP/);
  assert.equal((await f.call(owner, "cora_artifact_upload", { folder_id: folderId, files: [{ path: "x" }] })).rpcError.code, -32602);

  const secret = await f.call(owner, "cora_secret_set", { name: "MCP_FIXTURE_KEY", value: "never-returned-canary", description: "fixture" });
  assert.ok(secret.structuredContent.status < 400, JSON.stringify(secret.structuredContent));
  const secrets = await f.call(owner, "cora_secrets_list");
  assert.ok(JSON.stringify(secrets).includes("MCP_FIXTURE_KEY"));
  assert.ok(!JSON.stringify(secrets).includes("never-returned-canary"));
  assert.equal((await f.call(owner, "cora_secret_delete", { name: "MCP_FIXTURE_KEY" })).structuredContent.status, 200);
});

test("an external orchestrator delegates to a Cora agent as its subagent and gets the result, its question, or the work still running", async (t) => {
  const f = await mcpWorld(t), alice = await f.issue(f.alice), bob = await f.issue(f.bob), reader = await f.issue(f.alice, { readOnly: true });
  const init = await f.rpc(alice, "initialize", { protocolVersion: "2025-06-18" });
  assert.match(init.data.result.instructions, /subagent[\s\S]*cora_delegate[\s\S]*cora_delegation_wait/);
  const tools = (await f.rpc(alice, "tools/list", {}, "/mcp?areas=subagents")).data.result.tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => name.startsWith("cora_delegat")), ["cora_delegate", "cora_delegation_wait"]);
  const readTools = (await f.rpc(reader, "tools/list")).data.result.tools.map((tool) => tool.name);
  assert.ok(!readTools.includes("cora_delegate") && readTools.includes("cora_delegation_wait"), "a read-only access waits but never delegates");

  const agent = (await f.call(alice, "cora_agent_create", { name: "Worker", tools: false })).structuredContent.data;
  let questions = 0;
  f.state.answer = (body) => {
    const text = JSON.stringify(body.messages.at(-1)?.content || "");
    if (/Nothing to answer here/.test(text)) return { content: "PASS" };
    if (/Which report/.test(text) && body.tools?.length) return questions++ ? { content: "PASS" } : { tool_calls: [{ function: { name: "ask_owner", arguments: { question: "Report for Q3 or Q4?", choices: ["Q3", "Q4"] } } }] };
    if (/Sum 40 and 2/.test(text)) return { content: "The result is 42." };
    return { content: "PASS" };
  };
  const done = (await f.call(alice, "cora_delegate", { agent_id: agent.id, task: "Sum 40 and 2 and return only the number.", wait_seconds: 60 })).structuredContent;
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(done.data.status, "done", JSON.stringify(done.data));
  assert.match(done.data.replies.map((reply) => reply.text).join("\n"), /42/);
  assert.deepEqual(done.data.running, []);
  const room = f.app.store.recentMessages("web-" + agent.id, 20);
  assert.ok(room.some((message) => message.id === done.data.message_id && message.kind === "owner" && /Sum 40 and 2/.test(message.content)), "the task is a direct message in the agent's private chat");

  const again = (await f.call(alice, "cora_delegation_wait", { agent_id: agent.id, after: done.data.message_id, wait_seconds: 0 })).structuredContent.data;
  assert.equal(again.status, "done");
  assert.deepEqual(again.replies.map((reply) => reply.id), done.data.replies.map((reply) => reply.id));

  const asked = (await f.call(alice, "cora_delegate", { agent_id: agent.id, task: "Which report should I prepare? Ask me first.", wait_seconds: 60 })).structuredContent.data;
  assert.equal(asked.status, "waiting_for_you", JSON.stringify(asked));
  assert.deepEqual(asked.replies.find((reply) => reply.question).question.choices, ["Q3", "Q4"]);
  f.app.orchestrator.postWeb(f.app.store.agent(agent.id), f.app.orchestrator.state("web-" + agent.id), "I asked which quarter: I start as soon as you answer.", undefined, undefined, { silent: true });
  const still = (await f.call(alice, "cora_delegation_wait", { agent_id: agent.id, after: asked.message_id, wait_seconds: 0 })).structuredContent.data;
  assert.equal(still.replies.at(-1).text, "I asked which quarter: I start as soon as you answer.");
  assert.equal(still.status, "waiting_for_you", "a word added after the question keeps it open");
  assert.match(asked.next, /cora_delegate/);

  const queued = (await f.call(alice, "cora_delegate", { agent_id: agent.id, task: "Nothing to answer here.", wait_seconds: 0 })).structuredContent.data;
  assert.equal(queued.status, "working");
  assert.match(queued.next, new RegExp(`cora_delegation_wait[\\s\\S]*${queued.message_id}`));

  assert.equal((await f.call(bob, "cora_delegate", { agent_id: agent.id, task: "Do my work", wait_seconds: 0 })).structuredContent.status, 403, "nobody delegates to another person's agent");
  assert.equal((await f.call(alice, "cora_delegate", { agent_id: agent.id, task: "", wait_seconds: 0 })).rpcError.code, -32602);
  assert.equal((await f.call(alice, "cora_delegation_wait", { agent_id: agent.id, after: "web_missing", wait_seconds: 0 })).structuredContent.status, 404);
});

test("an external client talks with a Cora agent by name, in the agent-communication area that comes first", async (t) => {
  const f = await mcpWorld(t), alice = await f.issue(f.alice), bob = await f.issue(f.bob), reader = await f.issue(f.alice, { readOnly: true });
  const init = await f.rpc(alice, "initialize", { protocolVersion: "2025-06-18" });
  assert.match(init.data.result.instructions, /^TALK TO THE AGENTS[\s\S]*talk_to_agent[\s\S]*word for word[\s\S]*Never say you cannot reach an agent/);
  const all = (await f.rpc(alice, "tools/list")).data.result.tools.map((tool) => tool.name);
  assert.deepEqual(all.slice(0, 4), ["talk_to_agent", "wait_for_agent_reply", "cora_delegate", "cora_delegation_wait"]);
  const area = (await f.rpc(alice, "tools/list", {}, "/mcp?areas=agent-communication")).data.result.tools.map((tool) => tool.name);
  const legacy = (await f.rpc(alice, "tools/list", {}, "/mcp?areas=subagents")).data.result.tools.map((tool) => tool.name);
  assert.deepEqual(legacy, area, "the old subagents area id still selects the same tools");
  const readTools = (await f.rpc(reader, "tools/list")).data.result.tools.map((tool) => tool.name);
  assert.ok(!readTools.includes("talk_to_agent") && readTools.includes("wait_for_agent_reply"), "a read-only access never writes to an agent");
  const map = JSON.parse((await f.call(alice, "cora_configurations", { area: "agent-communication" })).content[0].text);
  assert.equal(map.areas[0].id, "agent-communication");

  const clara = (await f.call(alice, "cora_agent_create", { name: "Clara", tools: false })).structuredContent.data;
  await f.call(alice, "cora_agent_create", { name: "Clarissa", tools: false });
  f.state.answer = (body) => {
    const text = JSON.stringify(body.messages.at(-1)?.content || "");
    if (/Ciao Clara, sei libera/.test(text)) return { content: "Ciao! Sì, sono libera: dimmi pure." };
    return { content: "PASS" };
  };
  const talked = (await f.call(alice, "talk_to_agent", { agent: "clara", message: "Ciao Clara, sei libera oggi?", wait_seconds: 60 })).structuredContent;
  assert.equal(talked.status, 200, JSON.stringify(talked));
  assert.equal(talked.data.status, "done", JSON.stringify(talked.data));
  assert.deepEqual(talked.data.agent, { id: clara.id, name: "Clara" });
  assert.equal(talked.data.reply, "Ciao! Sì, sono libera: dimmi pure.");
  assert.match(talked.data.next, /word for word[\s\S]*talk_to_agent/);
  const room = f.app.store.recentMessages("web-" + clara.id, 20);
  assert.ok(room.some((message) => message.id === talked.data.message_id && message.kind === "owner" && message.content === "Ciao Clara, sei libera oggi?"), "the person's words reach the agent's private chat as written");
  const again = (await f.call(alice, "wait_for_agent_reply", { agent: "@Clara", after: talked.data.message_id, wait_seconds: 0 })).structuredContent.data;
  assert.equal(again.status, "done");
  assert.equal(again.reply, talked.data.reply);

  const ambiguous = (await f.call(alice, "talk_to_agent", { agent: "Clar", message: "Hi", wait_seconds: 0 })).structuredContent;
  assert.equal(ambiguous.status, 404);
  assert.match(ambiguous.data.error, /More than one agent/);
  const missing = (await f.call(alice, "talk_to_agent", { agent: "Zorro", message: "Hi", wait_seconds: 0 })).structuredContent;
  assert.equal(missing.status, 404);
  assert.ok(missing.data.agents.includes("Clara") && /talk_to_agent/.test(missing.data.next), "an unknown name lists who you can talk to");
  assert.equal((await f.call(bob, "talk_to_agent", { agent: clara.id, message: "Hi", wait_seconds: 0 })).structuredContent.status, 404, "another person's private agent is not among the agents to talk to");
  assert.equal((await f.call(alice, "talk_to_agent", { agent: "Clara", message: " ", wait_seconds: 0 })).rpcError.code, -32602);
});
