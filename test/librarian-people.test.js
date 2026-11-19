import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";

const GROUP = "tg:-5000000001";
const VIRGINIA = "6200000001";
const STRANGER = "6200000002";

test("the librarian and the agents keep what is said by the people allowed to talk to the owner's agents, and nobody else's", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  f.app.boxes.inspect = async () => ({ exists: false });
  const create = async (actor, name) => {
    const result = await f.request(actor, "/api/agents", { method: "POST", body: { tools: false, name } });
    assert.equal(result.status, 201); return f.app.store.agent(result.data.id);
  };
  const aliceCrew = await create(f.alice, "Alice crew");
  const bobCrew = await create(f.bob, "Bob crew");
  const { store, knowledge } = f.app;
  store.updateSettings({ permissions: [{ id: `telegram:${VIRGINIA}`, name: "Virginia", agents: [aliceCrew.id] }] });

  const now = Date.now();
  const said = (id, authorId, authorName, content, at) => {
    store.appendArchive(GROUP, { id, kind: "human", authorId, authorName, at, content });
    return { id, channelId: GROUP, kind: "human", authorId, authorName, at, content };
  };
  const before = said("tg-v-old", VIRGINIA, "Virginia", "PEOPLE_VIRGINIA_BEFORE la tappa 6 è Palazzo Barone", now - 60000);
  said("tg-s-old", STRANGER, "Stranger", "PEOPLE_STRANGER_BEFORE", now - 59000);
  // The librarian had already read past these two before the fix: they come back once, as a backfill.
  await knowledge.ownerBrain(f.alice.user.id).setState("lastRun", { until: now - 30000 });
  await knowledge.ownerBrain(f.bob.user.id).setState("lastRun", { until: now - 30000 });
  said("tg-v-new", VIRGINIA, "Virginia", "PEOPLE_VIRGINIA_AFTER togli Terravecchia", now - 1000);
  said("tg-s-new", STRANGER, "Stranger", "PEOPLE_STRANGER_AFTER", now - 900);

  assert.equal(knowledge.ownsMessage(aliceCrew, before), true, "the agent remembers a person it is allowed to talk to");
  assert.equal(knowledge.ownsMessage(bobCrew, before), false, "another owner's agent does not");
  assert.equal(knowledge.ownsMessage(aliceCrew, { ...before, authorId: STRANGER }), false);
  assert.equal(knowledge.ownerAuthorized(f.alice.user.id, before), true);
  assert.equal(knowledge.ownerAuthorized(f.bob.user.id, before), false);
  assert.deepEqual(knowledge.authorizedContacts(f.alice.user.id), [`telegram:${VIRGINIA}`]);
  assert.deepEqual(knowledge.authorizedContacts(f.bob.user.id), []);

  const first = await f.app.librarian.forOwner(f.alice.user.id).run();
  assert.equal(first.status, "done");
  assert.equal(first.messages, 2, "the new message and the backfilled one");
  const archive = JSON.stringify(await knowledge.ownerBrain(f.alice.user.id).searchArchive("PEOPLE"));
  assert.match(archive, /PEOPLE_VIRGINIA_BEFORE/); assert.match(archive, /PEOPLE_VIRGINIA_AFTER/);
  assert.doesNotMatch(archive, /PEOPLE_STRANGER/);
  assert.deepEqual(await knowledge.ownerBrain(f.alice.user.id).state("authorizedPeopleBackfill", []), [`telegram:${VIRGINIA}`]);

  await f.app.librarian.forOwner(f.bob.user.id).run();
  assert.doesNotMatch(JSON.stringify(await knowledge.ownerBrain(f.bob.user.id).searchArchive("PEOPLE")), /PEOPLE_/);

  // The backfill happens once: the next run reads only what is new.
  said("tg-v-later", VIRGINIA, "Virginia", "PEOPLE_VIRGINIA_LATER", Date.now());
  const second = await f.app.librarian.forOwner(f.alice.user.id).run();
  assert.equal(second.messages, 1);

  // A person granted later is recovered once too, and only them.
  store.updateSettings({ permissions: [{ id: `telegram:${VIRGINIA}`, name: "Virginia", agents: [aliceCrew.id] }, { id: `telegram:${STRANGER}`, name: "Enrico", agents: [aliceCrew.id] }] });
  const third = await f.app.librarian.forOwner(f.alice.user.id).run();
  assert.equal(third.messages, 2, "the two earlier messages of the newly granted person");
  assert.match(JSON.stringify(await knowledge.ownerBrain(f.alice.user.id).searchArchive("PEOPLE")), /PEOPLE_STRANGER_BEFORE/);
  assert.equal((await f.app.librarian.forOwner(f.alice.user.id).run()).messages, 0);

  // A revoked grant stops the reading.
  store.updateSettings({ permissions: [] });
  assert.equal(knowledge.ownsMessage(aliceCrew, before), false);
  assert.equal(knowledge.ownerAuthorized(f.alice.user.id, before), false);
});
