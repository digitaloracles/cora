import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS } from "../src/panel-mcp-tools.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test("the space owner sets the panel's look for everyone; members only read it", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  const owner = f.admin;

  const initial = await f.request(owner, "/api/appearance");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, { theme: "cora", mode: "light", accent: "#264cd6", sidebar: "#121a3a", name: "", logo: "" });

  const refused = await f.request(f.alice, "/api/appearance", { method: "PUT", body: { theme: "studio" } });
  assert.equal(refused.status, 403);
  assert.equal((await f.request(f.alice, "/api/appearance")).data.theme, "cora", "a member's attempt changes nothing");

  const custom = await f.request(owner, "/api/appearance", { method: "PUT", body: { theme: "custom", mode: "dark", accent: "#1DB954", sidebar: "#191414", name: "  Acme   Studio " } });
  assert.equal(custom.status, 200);
  assert.deepEqual({ ...custom.data, logo: undefined }, { theme: "custom", mode: "dark", accent: "#1db954", sidebar: "#191414", name: "Acme Studio", logo: undefined });

  for (const body of [{ theme: "neon" }, { mode: "sepia" }, { accent: "green" }, { sidebar: "#12345" }, { name: "<b>Acme</b>" }, { name: "x".repeat(41) }, []]) {
    const bad = await f.request(owner, "/api/appearance", { method: "PUT", body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  const kept = await f.request(f.bob, "/api/state");
  assert.equal(kept.status, 200);
  assert.deepEqual({ theme: kept.data.appearance.theme, accent: kept.data.appearance.accent, name: kept.data.appearance.name }, { theme: "custom", accent: "#1db954", name: "Acme Studio" }, "refused changes leave the saved look as it was, and members see it in the state");

  const partial = await f.request(owner, "/api/appearance", { method: "PUT", body: { theme: "dopamina" } });
  assert.equal(partial.data.theme, "dopamina");
  assert.equal(partial.data.accent, "#1db954", "fields left out stay as they are");
});

test("the space logo is an image read by its bytes, served only to signed-in people", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  const owner = f.admin;

  assert.equal((await fetch(f.base + "/api/appearance/logo", { headers: owner.headers })).status, 404);
  assert.equal((await f.request(f.alice, "/api/appearance/logo", { method: "PUT", body: { image: PNG.toString("base64") } })).status, 403);

  const svg = await f.request(owner, "/api/appearance/logo", { method: "PUT", body: { image: "data:image/png;base64," + SVG.toString("base64") } });
  assert.equal(svg.status, 400, "an SVG is refused whatever it claims to be");
  const big = await f.request(owner, "/api/appearance/logo", { method: "PUT", body: { image: Buffer.concat([PNG, Buffer.alloc(520 * 1024)]).toString("base64") } });
  assert.equal(big.status, 400);

  const saved = await f.request(owner, "/api/appearance/logo", { method: "PUT", body: { image: "data:image/png;base64," + PNG.toString("base64") } });
  assert.equal(saved.status, 200);
  assert.match(saved.data.logo, /^[0-9a-f]{16}$/);

  const served = await fetch(f.base + "/api/appearance/logo?v=" + saved.data.logo, { headers: f.alice.headers });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("content-security-policy"), /sandbox/);
  assert.match(served.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.match((await fetch(f.base + "/api/appearance/logo?v=old", { headers: f.alice.headers })).headers.get("cache-control"), /no-cache/);
  assert.equal((await fetch(f.base + "/api/appearance/logo")).status, 401, "nobody outside the space gets it");

  const removed = await f.request(owner, "/api/appearance/logo", { method: "DELETE" });
  assert.equal(removed.data.logo, "");
  assert.equal((await fetch(f.base + "/api/appearance/logo", { headers: owner.headers })).status, 404);
});

test("the panel MCP offers the appearance as specific tools", () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));
  assert.deepEqual(["cora_appearance_get", "cora_appearance_set", "cora_appearance_logo_set", "cora_appearance_logo_remove"].map((name) => [byName[name]?.method, byName[name]?.path]),
    [["GET", "/api/appearance"], ["PUT", "/api/appearance"], ["PUT", "/api/appearance/logo"], ["DELETE", "/api/appearance/logo"]]);
  assert.deepEqual(byName.cora_appearance_set.body.theme.enum, ["cora", "giorno", "notte", "studio", "dopamina", "custom"]);
});
