import { PREVIEW_GROUPS_KEY, PREVIEW_GUESTS_KEY, PREVIEW_TOOLS, PREVIEW_WINDOWS_KEY, PreviewWindow, previewGuestId } from "./preview.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { agentName, draftCard, readSite, runOnce } from "./preview-pipeline.js";
import { ownerRoom } from "./rooms.js";

export { PREVIEW_GROUPS_KEY };

/** The demo space's store as the pipeline's groups: guests, sealed agents and the hour of each company. */
export function storeGroups(app, { model, minutes }) {
  const { store } = app;
  const window = new PreviewWindow({ store, minutes });
  const guests = () => store.value(PREVIEW_GUESTS_KEY, []) || [];
  const admit = (entry, guest) => {
    const email = guest.email.toLowerCase();
    store.setValue(PREVIEW_GUESTS_KEY, [...guests().filter((item) => item.email !== email), { email, name: "", tokenHash: guest.tokenHash, group: entry.id, lang: guest.lang || entry.lang || "" }]);
    const policy = store.accessPolicy();
    if (!policy.emails.includes(email)) store.updateAccessPolicy({ emails: [...policy.emails, email] });
    return store.registerPanelUser({ id: previewGuestId(email), name: email, email, avatar: "", role: "member", emailVerified: true, source: "local" }).id;
  };
  const makeAgents = (entry, specs, owner, coOwners) => {
    const ids = [];
    try {
      for (const spec of specs) {
        const name = agentName(spec.name, entry.company, (lower) => store.agents().some((agent) => agent.name.toLowerCase() === lower));
        ids.push(store.createAgent({ name, personality: spec.personality, color: spec.color, model, language: spec.language || entry.lang || "", sealed: true, tools: false, enabled: true, brainSource: "internal", brainOwnerId: owner, coOwnerIds: coOwners, channelIds: [] }).id);
      }
    } catch (error) {
      for (const id of ids) store.deleteAgent(id);
      throw error;
    }
    return ids;
  };
  return {
    load: () => store.value(PREVIEW_GROUPS_KEY, []) || [],
    save: (entries) => store.setValue(PREVIEW_GROUPS_KEY, entries),
    create(entry, guest) {
      const owner = admit(entry, guest);
      return makeAgents(entry, entry.agents, owner, []);
    },
    addAgents(entry, specs) {
      const first = store.agent(entry.agentIds?.[0]);
      const ids = entry.guests.map((guest) => previewGuestId(guest.email));
      return makeAgents(entry, specs, first?.brainOwnerId || ids[0], ids.filter((id) => id !== (first?.brainOwnerId || ids[0])));
    },
    addGuest(entry, guest) {
      const id = admit(entry, guest);
      for (const agentId of entry.agentIds || []) {
        const agent = store.agent(agentId);
        if (agent && agent.brainOwnerId !== id && !agent.coOwnerIds.includes(id)) store.updateAgent(agentId, { coOwnerIds: [...agent.coOwnerIds, id] });
      }
    },
    /** The company's agents, chats, links and access go; the space's own people never notice. */
    remove(entry) {
      // An address that later asked for another company keeps that link: only the records of this group go.
      const emails = new Set(guests().filter((guest) => guest.group === entry.id).map((guest) => guest.email.toLowerCase()));
      const rooms = [...(entry.agentIds || []).map((id) => `web-${id}`), ...[...emails].map((email) => ownerRoom(previewGuestId(email)))];
      for (const id of entry.agentIds || []) { if (store.agent(id)) { store.deleteAgent(id); app.skills?.forget?.(id); } }
      for (const room of rooms) store.stmt("DELETE FROM messages WHERE channel_id = ?").run(room);
      store.setValue(PREVIEW_GUESTS_KEY, guests().filter((guest) => guest.group !== entry.id));
      const windows = { ...(store.value(PREVIEW_WINDOWS_KEY, {}) || {}) };
      delete windows[entry.id];
      store.setValue(PREVIEW_WINDOWS_KEY, windows);
      const policy = store.accessPolicy();
      store.updateAccessPolicy({ emails: policy.emails.filter((email) => !emails.has(email)) });
    },
    window: (entry) => { const state = window.groupState(entry.id); return state.startedAt ? state : null; },
  };
}

/**
 * After a restart: a guest's last message that the restart left without an answer is answered now, while that
 * company's hour is open. Preview agents have no tools, so the general resume of interrupted work skips them.
 */
export function answerLeftovers(app, { minutes, withinMs = 15 * 60000, now = () => Date.now() } = {}) {
  const { store, orchestrator } = app;
  const window = new PreviewWindow({ store, minutes });
  const rooms = [];
  for (const entry of store.value(PREVIEW_GROUPS_KEY, []) || []) {
    if (entry.removedAt || window.groupState(entry.id).ended) continue;
    for (const agentId of entry.agentIds || []) {
      if (!store.agent(agentId)?.enabled) continue;
      const room = `web-${agentId}`;
      const last = store.recentMessages(room, 1).at(-1);
      if (!last || last.agentId || !["owner", "human"].includes(last.kind) || now() - last.at > withinMs) continue;
      const state = orchestrator.state(room);
      rooms.push(room);
      orchestrator.ensureHistory(state).then(() => orchestrator.schedule(state, 400)).catch(() => {});
    }
  }
  return rooms;
}

/** Runs the pipeline every minute inside the demo space, one pass at a time. */
export function startPreviewPipeline(app, { cloudUrl, token, space, base, model, minutes, chat, mail, intervalMs = 60000, log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })) }) {
  const cloudCall = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${cloudUrl.replace(/\/$/, "")}/api/previews${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`usecora.space previews answered ${response.status}`);
    return response.json();
  };
  const deps = {
    now: () => Date.now(), log, chat, mail, space, base, site: (url) => readSite(url),
    groups: storeGroups(app, { model, minutes }),
    cloud: { list: async (status) => (await cloudCall(`?status=${status}`)).previews, update: (id, body) => cloudCall(`/${id}`, { method: "POST", body }), firstMessage: (id) => cloudCall(`/${id}/first-message`, { method: "POST" }) },
  };
  app.brain.previewTools = PREVIEW_TOOLS;
  // Agents made before their language was stored speak the language of their company's request.
  for (const entry of deps.groups.load().filter((item) => !item.removedAt)) {
    for (const id of entry.agentIds || []) {
      const agent = app.store.agent(id);
      if (agent && !agent.language && entry.lang) app.store.updateAgent(id, { language: entry.lang });
    }
  }
  let running = null;
  const pass = () => {
    if (running) return running;
    running = runOnce(deps).catch((error) => log({ type: "pipeline-error", error: error.message })).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  void pass();
  return { pass, stop: () => clearInterval(timer), deps };
}

/**
 * The onboarding's small agent, behind demo.usecora.space/_draft: usecora.space/try asks it with the pipeline
 * token for the card of the agent a company is setting up. It reads the site and makes one model call.
 */
export function startDraftDoor({ token, chat, read = readSite, port = 4371, host = "127.0.0.1", log = () => {} }) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(`${JSON.stringify(body)}\n`); };
    const given = Buffer.from(String(req.headers.authorization || ""));
    if (req.method !== "POST" || token.length < 32 || given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(404, { error: "not-found" });
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return reply(413, { error: "too-large" }); }
    let fields;
    try { fields = JSON.parse(body); } catch { return reply(400, { error: "body" }); }
    const raw = String(fields?.site || "").trim();
    const site = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const draft = await draftCard({ company: fields.company, site, archetype: fields.archetype, lang: fields.lang, wish: fields.wish }, { chat, read });
      log({ type: "preview-drafted", archetype: fields.archetype });
      return reply(200, { draft });
    } catch (error) {
      log({ type: "preview-draft-failed", error: String(error.message).slice(0, 120) });
      return reply(error.message === "archetype" ? 400 : 502, { error: error.message === "archetype" ? "archetype" : "draft" });
    }
  });
  server.listen(port, host);
  return server;
}
