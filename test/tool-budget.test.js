import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fitToolList, toolListSize } from "../src/tool-budget.js";

const words = (count, seed) => Array.from({ length: count }, (_, index) => `${seed}${index}`).join(" ");

function catalog() {
  const tools = [];
  for (let index = 0; index < 45; index += 1) {
    tools.push({
      name: `studio_tool_${index}`,
      description: `Studio, as the account that made the agent key. ${words(120, "take")}. Deletes for good: only on an explicit user request.`,
      inputSchema: { type: "object", additionalProperties: false, properties: {
        project_id: { type: "string", description: `Project id from studio_list_projects. ${words(12, "id")}` },
        mode: { type: "string", enum: ["a", "b"], description: words(20, "mode") },
      }, required: ["project_id"] },
    });
  }
  for (let index = 0; index < 40; index += 1) {
    tools.push({
      name: `core_tool_${index}`,
      description: `${words(250, "core")}. Never say it is published unless the receipt says PUBLISHED.`,
      inputSchema: { type: "object", properties: { path: { type: "string", description: words(15, "path") }, count: { type: "number", minimum: 0 } }, required: ["path"] },
    });
  }
  return tools;
}

const core = () => catalog().filter((tool) => tool.name.startsWith("core_")).map((tool) => tool.name);

test("a list under the budget is served unchanged", () => {
  const tools = catalog();
  assert.equal(fitToolList(tools, toolListSize(tools)), tools);
  assert.equal(fitToolList(tools, 0), tools);
});

test("an oversized list fits the budget and keeps every tool, type, enum and required field", () => {
  const tools = catalog();
  const budget = Math.floor(toolListSize(tools) * 0.6);
  const fit = fitToolList(tools, budget, core());
  assert.ok(toolListSize(fit) <= budget, `${toolListSize(fit)} > ${budget}`);
  assert.deepEqual(fit.map((tool) => tool.name), tools.map((tool) => tool.name));
  for (const [index, tool] of fit.entries()) {
    const original = tools[index].inputSchema;
    assert.deepEqual(tool.inputSchema.required, original.required);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), Object.keys(original.properties));
    for (const [name, property] of Object.entries(original.properties)) {
      assert.equal(tool.inputSchema.properties[name].type, property.type);
      assert.deepEqual(tool.inputSchema.properties[name].enum, property.enum);
      assert.equal(tool.inputSchema.properties[name].minimum, property.minimum);
    }
    assert.ok(tool.description.length > 0);
  }
});

test("core tools keep more text than connector tools and the family opening goes first", () => {
  const tools = catalog();
  const fit = fitToolList(tools, Math.floor(toolListSize(tools) * 0.6), core());
  const studio = fit.find((tool) => tool.name === "studio_tool_0");
  const own = fit.find((tool) => tool.name === "core_tool_0");
  assert.ok(!studio.description.startsWith("Studio, as the account"));
  assert.ok(studio.description.startsWith("take0 take1"));
  assert.ok(own.description.length >= studio.description.length * 2);
  assert.equal(studio.inputSchema.additionalProperties, undefined);
});

test("the stdio MCP server fits tools/list to CORA_TOOLS_BUDGET", async () => {
  const tools = catalog().map(({ inputSchema, ...tool }) => ({ ...tool, parameters: inputSchema }));
  const bridge = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tools }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const listed = async (env) => {
    const server = spawn(process.execPath, [fileURLToPath(new URL("../src/mcp-server.js", import.meta.url))], {
      env: { ...process.env, CORA_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`, CORA_BRIDGE_TOKEN: "t", ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const line = new Promise((resolve) => createInterface({ input: server.stdout }).once("line", resolve));
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const answer = JSON.parse(await line);
    server.kill();
    return answer.result.tools;
  };
  try {
    const full = await listed({});
    const budget = Math.floor(toolListSize(full) * 0.6);
    const fit = await listed({ CORA_TOOLS_BUDGET: String(budget), CORA_TOOLS_CORE: core().join(",") });
    assert.equal(fit.length, full.length);
    assert.ok(toolListSize(fit) <= budget);
    assert.ok(fit.find((tool) => tool.name === "core_tool_0").description.length > fit.find((tool) => tool.name === "studio_tool_0").description.length);
  } finally {
    bridge.close();
  }
});
