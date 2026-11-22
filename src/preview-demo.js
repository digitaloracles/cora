import { PREVIEW_GROUPS_KEY, PREVIEW_GUESTS_KEY, PREVIEW_TOOLS, PREVIEW_WINDOWS_KEY, PreviewWindow, previewGuestId } from "./preview.js";
import { agentName, readSite, runOnce } from "./preview-pipeline.js";
import { ownerRoom } from "./rooms.js";

export { PREVIEW_GROUPS_KEY };

/** The demo space's store as the pipeline's groups: guests, sealed agents and the hour of each company. */
export function storeGroups(app, { model, minutes }) {
  const { store } = app;
  const window = new PreviewWindow({ store, minutes });
  const guests = () => store.value(PREVIEW_GUESTS_KEY, []) || [];
  const admit = (entry, guest) => {
    const email = guest.email.toLowerCase();
    store.setValue(PREVIEW_GUESTS_KEY, [...guests().filter((item) => item.email !== email), { email, name: "", tokenHash: guest.tokenHash, group: entry.id }]);
    const policy = store.accessPolicy();
    if (!policy.emails.includes(email)) store.updateAccessPolicy({ emails: [...policy.emails, email] });
    return store.registerPanelUser({ id: previewGuestId(email), name: email, email, avatar: "", role: "member", emailVerified: true, source: "local" }).id;
  };
  const makeAgents = (entry, specs, owner, coOwners) => {
    const ids = [];
    try {
      for (const spec of specs) {
        const name = agentName(spec.name, entry.company, (lower) => store.agents().some((agent) => agent.name.toLowerCase() === lower));
        ids.push(store.createAgent({ name, personality: spec.personality, color: spec.color, model, sealed: true, tools: false, enabled: true, brainSource: "internal", brainOwnerId: owner, coOwnerIds: coOwners, channelIds: [] }).id);
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
      const emails = new Set(entry.guests.map((guest) => guest.email.toLowerCase()));
      const rooms = [...(entry.agentIds || []).map((id) => `web-${id}`), ...[...emails].map((email) => ownerRoom(previewGuestId(email)))];
      for (const id of entry.agentIds || []) { if (store.agent(id)) { store.deleteAgent(id); app.skills?.forget?.(id); } }
      for (const room of rooms) store.stmt("DELETE FROM messages WHERE channel_id = ?").run(room);
      store.setValue(PREVIEW_GUESTS_KEY, guests().filter((guest) => guest.group !== entry.id && !emails.has(guest.email)));
      const windows = { ...(store.value(PREVIEW_WINDOWS_KEY, {}) || {}) };
      delete windows[entry.id];
      store.setValue(PREVIEW_WINDOWS_KEY, windows);
      const policy = store.accessPolicy();
      store.updateAccessPolicy({ emails: policy.emails.filter((email) => !emails.has(email)) });
    },
    window: (entry) => { const state = window.groupState(entry.id); return state.startedAt ? state : null; },
  };
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
