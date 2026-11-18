import { test } from "node:test";
import assert from "node:assert/strict";
import { Brain } from "../src/brain.js";
import { issueKeys, sameChannel, threadLeak, threadTopics, sharesTopic, topicPlace } from "../src/thread-topics.js";

const G = "1521874685690642564";
const channels = [
  { id: "1", name: "lab", guildId: G, thread: false },
  { id: "1569622836681904228", name: "REF-23 handover", guildId: G, thread: true, parentId: "1" },
  { id: "1569410375882121336", name: "REF-62 — razionalizzazione pagine Admin", guildId: G, thread: true, parentId: "1" },
  { id: "5", name: "ACD-73 pipeline", guildId: G, thread: true, parentId: "1" },
  { id: "6", name: "REF-62 altrove", guildId: "other", thread: true, parentId: "9" },
];
const at = (id) => threadTopics(channels, channels.find((item) => item.id === id));

test("issue keys: real keys only, once each", () => {
  assert.deepEqual(issueKeys("REF-62, REF-66 e ACD-73; ancora REF-62"), ["REF-62", "REF-66", "ACD-73"]);
  assert.deepEqual(issueKeys("UTF-8, ISO-8601, SHA-256, GPT-4, COVID-19, PR-12, ref-62, XREF-62a"), []);
});

test("a thread's topic comes from its name; the same server's other threads own their issues", () => {
  const handover = at("1569622836681904228");
  assert.deepEqual(handover.topic, ["REF-23"]);
  assert.deepEqual([...handover.others.keys()], ["REF-62", "ACD-73"], "another server's thread is not a place for this one");
  assert.deepEqual(at("1").topic, [], "a channel is not a thread: no topic");
});

test("another thread's work is a leak; this thread's issue, a question asked here and a short pointer are not", () => {
  const handover = at("1569622836681904228");
  assert.equal(threadLeak("Briefings chiusa su REF-62, ora Source Health.", handover).key, "REF-62");
  assert.equal(threadLeak("REF-23: REF-25 chiusa, REF-62 lo seguo di là", handover), null);
  assert.equal(threadLeak("REF-62 è In Progress.", { ...handover, asked: ["REF-62"] }), null);
  assert.equal(threadLeak("REF-62 la seguo qui: https://discord.com/channels/1521874685690642564/1569410375882121336", handover), null);
  assert.equal(threadLeak("REF-99 non ha un thread", handover), null);
  assert.equal(threadLeak("Briefings chiusa su REF-62", at("1")), null, "a channel without a topic is never refused");
});

function contextFixture(here, other) {
  const agent = { id: "nico", name: "Nico" };
  const brain = Object.create(Brain.prototype);
  brain.timezone = "Europe/Rome";
  brain.channels = { info: (id) => [here, other].find((item) => item.id === id), list: () => [here, other] };
  brain.channelIdsFor = () => [here.id, other.id];
  brain.channelLabel = (id) => brain.channels.info(id).name;
  brain.store = { recentElsewhere: () => [{ channelId: other.id, messages: [{ kind: "agent", agentId: agent.id, authorName: "Nico", at: Date.now(), content: "FOREIGN_WORK: continuo la ricerca segreti" }] }] };
  return { brain, agent };
}

test("thread boundaries use identity, not issue codes, titles or transport", () => {
  for (const [here, other] of [
    [{ id: "handover", name: "Refracto autogestito", parentId: "lab" }, { id: "secrets", name: "Ricerca segreti", thread: true }],
    [{ id: "handover", name: "REF-23 handover", thread: true }, { id: "secrets", name: "REF-23 secondo thread", thread: true }],
    [{ id: "sl:C12345:1760000000.123456", name: "lab", parentId: "sl:C12345", kind: "slack" }, { id: "secrets", name: "Ricerca segreti" }],
    [{ id: "general", name: "lab" }, { id: "sl:C12345:1760000000.123456", name: "lab", parentId: "sl:C12345", kind: "slack" }],
  ]) {
    const { brain, agent } = contextFixture(here, other);
    assert.doesNotMatch(brain.elsewhere(agent, here.id, brain.threadMap(agent, here.id)), /FOREIGN_WORK/);
  }
});

test("a resumed thread drops legacy elsewhere transcripts but keeps its own request and steps", async () => {
  const here = { id: "handover", name: "Refracto autogestito", parentId: "lab" };
  const { brain, agent } = contextFixture(here, { id: "secrets", name: "Ricerca segreti", parentId: "lab" });
  let input;
  brain.loop = async (args) => { input = args; return { text: "ok" }; };
  await brain.resumeTurn({ agent, channel: here, trace: { kind: "chat", startedAt: new Date().toISOString(), prompt: '<altrove dove="Ricerca segreti">FOREIGN_WORK: sidebar</altrove>\n<chat>\nSeb ★: verifica Refracto CURRENT_WORK\n</chat>', steps: [{ type: "text", text: "CURRENT_STEP" }] } });
  assert.doesNotMatch(input.user, /FOREIGN_WORK/);
  assert.match(input.user, /CURRENT_WORK/);
  assert.match(input.user, /CURRENT_STEP/);
  assert.match(input.user, /Tema di questo thread: «Refracto autogestito»/);
  assert.ok(input.topics, "resumed tools keep the same thread boundary as a fresh turn");
});

test("archived thread metadata still isolates context when the live channel cache misses", () => {
  const here = { id: "handover", name: "handover" };
  const other = { id: "secrets", name: "secrets" };
  const { brain, agent } = contextFixture(here, other);
  brain.store.value = () => ({ handover: { name: "Refracto autogestito", parentId: "lab", thread: true } });
  assert.equal(brain.threadMap(agent, here.id).current.name, "Refracto autogestito");
  assert.doesNotMatch(brain.elsewhere(agent, here.id, brain.threadMap(agent, here.id)), /FOREIGN_WORK/);
  brain.store.value = () => ({ secrets: { name: "Ricerca segreti", parentId: "lab", thread: true } });
  assert.doesNotMatch(brain.elsewhere(agent, here.id, brain.threadMap(agent, here.id)), /FOREIGN_WORK/);
});

test("a job without an issue key speaks of a thread's topic only when it shares a word of its title", () => {
  const title = "NOT-43 · voce e lavoro in chiamata";
  assert.equal(sharesTopic("Controlla il registro della chiamata vocale", title), true);
  assert.equal(sharesTopic("Guarda i log della voce di Seb", title), true);
  assert.equal(sharesTopic("Verificare la disponibilità dei domini per musicfun", title), false);
  assert.equal(sharesTopic("Procedere con il lavoro su REF-73", title), false, "plain words and other keys do not count");
  assert.equal(sharesTopic("Controlla la chiamata", ""), false);
});

test("a job without a key finds the place whose title speaks of it, never a generic one", () => {
  const places = [
    { id: "10", name: "NOT-43 · voce e lavoro in chiamata", guildId: G, thread: true, parentId: "1" },
    { id: "11", name: "Google Drive · verifica integrazione", guildId: G, thread: true, parentId: "1" },
    { id: "12", name: "ragusapass", guildId: G, thread: false },
    { id: "13", name: "Controllare se Claire e Sarax hanno accesso al locale, verificando i permessi effettivi", guildId: G, thread: true, parentId: "1" },
    { id: "14", name: "Google Drive", guildId: "other", thread: true, parentId: "9" },
  ];
  const here = places[0];
  assert.equal(topicPlace(places, here, "Verificare che l'integrazione con Google Drive funzioni, provando l'accesso e una lettura reale")?.id, "11");
  assert.equal(topicPlace(places, here, "Verificare che Claire e Sarax abbiano accesso al locale podcast (non 843), controllando i permessi effettivi")?.id, "13", "a correction of a job goes to the job's thread");
  assert.equal(topicPlace(places, here, "Controlla il login di RagusaPass su Safari")?.id, "12", "a one-word channel named after the project");
  assert.equal(topicPlace(places, here, "Verificare e riportare l'esito con le prove reali"), null, "words every job uses tie it to nothing");
  assert.equal(topicPlace(places, here, "Controlla il registro della voce in chiamata"), null, "the place it was asked in is not a candidate");
  assert.equal(topicPlace(places, { id: "x", guildId: "none" }, "Google Drive"), null, "only the same server");
});

// NOT-63: «Aggiornamento documentazione» under #cora was read as the MTRO thread of another channel.
const CORA = "1563845389705023658", MTRO = "1564000000000000001";
const server = [
  { id: CORA, name: "cora", guildId: G, thread: false },
  { id: MTRO, name: "mtro", guildId: G, thread: false },
  { id: "1572632704892276776", name: "Aggiornamento documentazione", guildId: G, thread: true, parentId: CORA },
  { id: "1570419225351299212", name: "NOT-14 verifica Ada", guildId: G, thread: true, parentId: CORA },
  { id: "1572632445658861699", name: "Rilascio in produzione e documentazione", guildId: G, thread: true, parentId: MTRO },
  { id: "1564611871020023878", name: "MTR-1400", guildId: G, thread: true, parentId: MTRO },
];
const docsThread = { ...server[2], parentName: "cora" };

test("a thread's neighbours are the threads of its own channel; another channel's issues are only routed by exact key", () => {
  const map = threadTopics(server, docsThread);
  assert.deepEqual(map.current, { id: docsThread.id, name: "Aggiornamento documentazione", parentId: CORA, parentName: "cora" });
  assert.deepEqual([...map.others.keys()], ["NOT-14"], "MTR-1400 lives in #mtro: not a neighbour of a #cora thread");
  assert.deepEqual([...map.owners.keys()], ["NOT-14", "MTR-1400"]);
  assert.equal(sameChannel(server[4], docsThread), false);
  assert.equal(sameChannel(server[3], docsThread), true);
  assert.equal(sameChannel(server[0], docsThread), true, "the parent channel is the same subject");
  const notThread = threadTopics(server, { id: "t63", name: "NOT-63 parent channel", guildId: G, thread: true, parentId: CORA });
  assert.equal(threadLeak("MTR-1400 deploy fatto", notThread).key, "MTR-1400", "work on an exact foreign key is still sent to its thread");
});

test("the topic line names the parent channel and lists only the issues of that channel", () => {
  const brain = Object.create(Brain.prototype);
  const note = brain.topicNote(threadTopics(server, docsThread));
  assert.match(note, /Tema di questo thread: «Aggiornamento documentazione» \(channel_id "1572632704892276776"\) nel canale #cora \(channel_id del canale "1563845389705023658"\)/);
  assert.match(note, /un thread di un altro canale è un altro argomento/);
  assert.match(note, /Le altre issue di #cora hanno il loro thread: NOT-14/);
  assert.doesNotMatch(note, /MTR-1400|Rilascio in produzione/);
  const keyed = brain.topicNote(threadTopics(server, { ...server[3], parentName: "cora" }));
  assert.match(keyed, /Tema di questo thread: NOT-14 \(«NOT-14 verifica Ada»\) nel canale #cora/);
});

function serverBrain(recent) {
  const agent = { id: "radix", name: "Radix" };
  const brain = Object.create(Brain.prototype);
  brain.timezone = "Europe/Rome";
  const byId = new Map(server.map((item) => [item.id, item]));
  brain.channels = { info: (id) => byId.get(id) || (id.startsWith("web-") ? { id, kind: "web", name: "chat privata" } : null), list: () => server, listFor: () => server };
  brain.channelIdsFor = () => [...byId.keys(), "web-radix"];
  brain.channelLabel = (id) => {
    const info = byId.get(id);
    return info?.parentId ? `#${byId.get(info.parentId).name} › ${info.name}` : info ? `#${info.name}` : id;
  };
  brain.store = { recentElsewhere: (_agent, ids) => recent.filter((place) => ids.includes(place.channelId)) };
  return { brain, agent };
}

test("other conversations shown in a thread come only from its own channel, plus the panel and private chats", () => {
  const message = (content) => [{ kind: "agent", agentId: "radix", authorName: "Radix", at: Date.now(), content }];
  const { brain, agent } = serverBrain([
    { channelId: "1572632445658861699", messages: message("MTRO docs") },
    { channelId: "1564611871020023878", messages: message("MTR-1400") },
    { channelId: "1570419225351299212", messages: message("NOT-14") },
    { channelId: "web-radix", messages: message("panel") },
  ]);
  const text = brain.elsewhere(agent, docsThread.id, brain.threadMap(agent, docsThread.id));
  assert.doesNotMatch(text, /Rilascio in produzione|MTR-1400|#mtro/);
  assert.match(text, /#cora › NOT-14 verifica Ada/);
  assert.match(text, /chat privata|web-radix/);
});

test("list_channels gives every thread its parent channel", () => {
  const { brain, agent } = serverBrain([]);
  const channels = brain.postingChannels(agent, docsThread);
  assert.deepEqual(channels.find((item) => item.id === docsThread.id), { id: docsThread.id, name: "Aggiornamento documentazione", kind: "web", thread: true, parent_id: CORA, parent_name: "cora" });
  assert.deepEqual(channels.find((item) => item.id === "1572632445658861699"), { id: "1572632445658861699", name: "Rilascio in produzione e documentazione", kind: undefined, thread: true, parent_id: MTRO, parent_name: "mtro" });
  assert.deepEqual(channels.find((item) => item.id === CORA), { id: CORA, name: "cora", kind: undefined });
});

test("words never pick a thread of another channel, even with the same title", () => {
  const places = [
    { id: "a", name: "NOT-63 parent channel", guildId: G, thread: true, parentId: CORA },
    { id: "b", name: "Rilascio in produzione e documentazione", guildId: G, thread: true, parentId: MTRO },
    { id: "c", name: "Documentazione e rilascio", guildId: G, thread: true, parentId: CORA },
  ];
  assert.equal(topicPlace(places, places[0], "Aggiorna la documentazione del rilascio")?.id, "c");
  assert.equal(topicPlace(places.slice(0, 2), places[0], "Aggiorna la documentazione del rilascio"), null);
});
