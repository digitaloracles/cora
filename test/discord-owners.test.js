import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL, OWNER, STRANGER, TG_GROUP } from "./helpers.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

test("Discord owner settings list chat names and retain IDs for people who have not written", async (t) => {
  const f = await knowledgeWorld();
  t.after(f.close);
  const { store } = f.app;
  const unknown = "123456789012345678";
  const message = { id: "older-owner", kind: "owner", authorId: OWNER, authorName: "Former display name", content: "Hello", at: Date.now() };
  store.updateSettings({ ownerIds: [OWNER, unknown] });
  store.appendArchive(CHANNEL, message);
  store.appendArchive(CHANNEL, { ...message, id: "owner", authorName: "Discord Owner", at: message.at + 1 });
  store.appendArchive(CHANNEL, { ...message, id: "other", authorId: STRANGER, kind: "human", authorName: "Discord Member" });
  store.appendArchive(CHANNEL, { ...message, id: "bot", authorId: "100000", kind: "bot", authorName: "Discord Bot" });
  store.appendArchive("tg:" + TG_GROUP, { ...message, id: "telegram", authorName: "Telegram Owner" });

  const path = "/api/settings/discord/people";
  const result = await f.request(f.admin, path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.people, [
    { id: OWNER, name: "Discord Owner" },
    { id: STRANGER, name: "Discord Member" },
    { id: unknown, name: unknown },
  ]);
  assert.equal((await f.request(f.alice, path)).status, 403);
  assert.deepEqual(store.settings.ownerIds, [OWNER, unknown]);

  const update = await f.request(f.admin, "/api/settings", { method: "PUT", body: { ownerIds: [OWNER, unknown, STRANGER] } });
  assert.equal(update.status, 200);
  assert.deepEqual(store.settings.ownerIds, [OWNER, unknown, STRANGER]);
  assert.deepEqual((await f.request(f.admin, path)).data.people, result.data.people);
});
