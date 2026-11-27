import assert from "node:assert/strict";
import { test } from "node:test";
import { panelHarness } from "./panel.js";

test("the panel refreshes without Discord and shows only enabled guilds when connected", async () => {
  let state = {};
  const panel = panelHarness({ fetch: async () => ({ ok: true, json: async () => state }) });
  await panel.run("loadState()");
  assert.equal(panel.run("transportInfo().where"), "nessun server acceso");
  assert.equal(panel.run("transportInfo().label"), "Discord");

  state = {
    transport: "discord",
    discord: { state: "ready" },
    guilds: [{ id: "on", name: "Casa" }, { id: "off", name: "Altro" }],
    settings: { guildIds: ["on"] },
  };
  await panel.run("loadState()");
  assert.equal(panel.run("transportInfo().where"), "Casa");
  assert.equal(panel.run("transportInfo().state"), "ready");

  delete state.settings;
  await panel.run("loadState()");
  assert.equal(panel.run("transportInfo().where"), "nessun server acceso");
});
