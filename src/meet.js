import { encryptedOnly, encryptedFolder } from "./encrypted-space.js";
import { privateRoom } from "./rooms.js";
import { randomBytes } from "node:crypto";

/**
 * Google Meet for an agent: switched on from its settings, signed in to Google on its own
 * desktop, sent into a call from the panel or from chat. The seat itself is
 * `desktop-meet.mjs`, a process on the agent's desktop that outlives a restart of Cora; this
 * class starts it, follows it, and turns what it recorded into a transcript in Artifacts.
 */
export const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]\S*)?$/i;
const MEETING_LANGUAGES = ["it", "en", "es", "fr", "de", "pt"];
const ACTIVE = new Set(["starting", "waiting", "joined", "transcribing"]);
const FOLDER = /^meetings\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3}$/;
const AUDIO_LIMIT = 300 * 1024 * 1024;
const KEEP = 12;
const SETUP = new Set(["running", "needs-human", "done", "failed"]);

/** A password Google accepts: letters, digits and symbols, never starting with a dash. */
const googlePassword = () => `Cm${randomBytes(15).toString("base64url")}#7`;

/** What the agent does in the Meet browser after meet_setup start, in its own hands. */
const setupSteps = ({ email, secret, created, name }) => [
  "The Meet browser window on your desktop shows Google sign-in. Work only in that window, with screenshot and mouse/keyboard; never drive it over its debugging port and never open another browser for this.",
  `Type ${email} and continue.`,
  `If Google finds the account, enter the password and go on. If it cannot find it, choose Create account, For my personal use: first name ${name}, last name Cora; for birthday and gender use what the owner set for you, otherwise 1 January 2000 and Rather not say. At the address step choose Use your existing email and type ${email}.`,
  "Google's confirmation code arrives in your mailbox: find the message with ambox inbox, click the code field, then type the code without showing it: ambox read <message-id> | grep -oE '\\b[0-9]{6}\\b' | head -1 | xargs -r xdotool type --delay 60 --. Never print, repeat or post a code.",
  `Password fields: click the field, then type it only with: hush run --name ${secret} --env P --redact -- sh -c 'xdotool type --delay 60 -- "$P"'. Never print, read or write it anywhere else.${created ? " This password is new: use it for a new account. If the account already exists with another password, call meet_setup with step needs-human." : ""}`,
  "Skip what is optional: phone number, recovery email, Not now, Skip. Accept the terms.",
  "If Google insists on something only a person can give (a phone, a QR code to scan, a personal verification, a captcha you cannot pass), leave the page as it is and call meet_setup with step needs-human and a one-line note: the panel shows the person your desktop and asks for that one step. Do not post screenshots, QR codes or codes in chat. When they are done, call meet_setup with step check and go on from where Google is.",
  `When the page shows your Google Account, call meet_setup with step check: you are done only when it returns status done with ${email}. Then say it in one line.`,
];

export class MeetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const WORDS = {
  it: {
    title: "Riunione Google Meet", when: "Quando", length: "Durata", people: "Partecipanti", link: "Link", written: "Trascritta da", unknown: "Persona",
    empty: "Nessuno ha parlato durante la registrazione.", minutes: "min",
    reasons: {
      "sign-in": "l'account Google non è collegato", "invalid-link": "il link non è una riunione Meet valida", refused: "Meet ha rifiutato l'ingresso", "not-admitted": "nessuno lo ha fatto entrare",
      "no-door": "la pagina della riunione non si è aperta", error: "il browser della riunione si è fermato", "nobody-came": "non è arrivato nessuno", stopped: "fermato su richiesta", alone: "sono usciti tutti",
      "call-over": "la riunione è finita", "too-long": "durata massima raggiunta", "page-lost": "la pagina della riunione si è chiusa", crashed: "il desktop ha interrotto la riunione",
    },
  },
  en: {
    title: "Google Meet call", when: "When", length: "Length", people: "Participants", link: "Link", written: "Transcribed by", unknown: "Speaker",
    empty: "Nobody spoke while it was recording.", minutes: "min",
    reasons: {
      "sign-in": "the Google account is not signed in", "invalid-link": "the link is not a valid Meet call", refused: "Meet refused the request to join", "not-admitted": "nobody let it in",
      "no-door": "the call page did not open", error: "the call browser stopped", "nobody-came": "nobody came", stopped: "stopped on request", alone: "everyone left",
      "call-over": "the call ended", "too-long": "maximum length reached", "page-lost": "the call page closed", crashed: "the desktop interrupted the call",
    },
  },
};
const words = (language) => WORDS[language] || WORDS.en;

/** Soniox's tokens as turns: one per stretch of the same voice, split again on a long pause. */
export function turnsFrom(tokens) {
  const turns = [];
  for (const token of tokens || []) {
    const text = String(token.text || "");
    if (!text) continue;
    const speaker = String(token.speaker ?? "");
    const start = Number(token.start_ms ?? 0) / 1000;
    const end = Number(token.end_ms ?? token.start_ms ?? 0) / 1000;
    const last = turns.at(-1);
    if (last && last.speaker === speaker && start - last.end < 20) {
      last.text += text;
      last.end = Math.max(last.end, end);
    } else turns.push({ speaker, start, end, text });
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.replace(/\s+/g, " ").trim() })).filter((turn) => turn.text);
}

/**
 * Who each recorded voice is: the name Meet's captions showed most while that voice spoke.
 * A voice the captions never named is the only other participant when there is exactly one,
 * otherwise a numbered person.
 */
export function nameSpeakers(turns, captions = [], others = [], unknown = "Speaker") {
  const votes = new Map();
  for (const turn of turns) {
    for (const caption of captions) {
      if (caption.at < turn.start - 1 || caption.at > turn.end + 4) continue;
      const tally = votes.get(turn.speaker) || new Map();
      tally.set(caption.speaker, (tally.get(caption.speaker) || 0) + 1);
      votes.set(turn.speaker, tally);
    }
  }
  const names = new Map();
  let numbered = 0;
  for (const speaker of [...new Set(turns.map((turn) => turn.speaker))]) {
    const tally = votes.get(speaker);
    const voted = tally ? [...tally].sort((a, b) => b[1] - a[1])[0][0] : "";
    names.set(speaker, voted || (others.length === 1 ? others[0] : `${unknown} ${++numbered}`));
  }
  return names;
}

const clock = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor((whole % 3600) / 60)).padStart(hours ? 2 : 1, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

export function transcriptMarkdown({ language = "it", timezone = "Europe/Rome", agentName, link, startedAt, endedAt, people = [], turns = [] }) {
  const text = words(language);
  const when = new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", { dateStyle: "long", timeStyle: "short", timeZone: timezone }).format(new Date(startedAt));
  const head = [
    `# ${text.title} · ${when}`,
    "",
    `- **${text.when}:** ${when}`,
    `- **${text.length}:** ${Math.max(1, Math.round((endedAt - startedAt) / 60000))} ${text.minutes}`,
    ...(people.length ? [`- **${text.people}:** ${people.join(", ")}`] : []),
    `- **${text.link}:** ${link}`,
    `- **${text.written}:** ${agentName}`,
    "",
  ];
  const body = turns.length ? turns.map((turn) => `**${turn.name}** · ${clock(turn.start)}\n${turn.text}`) : [text.empty];
  return `${head.join("\n")}\n${body.join("\n\n")}\n`;
}

export function captionTurns(captions) {
  const turns = [], blocks = new Map();
  for (const { block, at, speaker, text } of captions) {
    if (!speaker || !text || !Number.isFinite(at)) continue;
    const words = text.trim().split(/\s+/);
    let previous = blocks.get(block);
    if (!previous || previous.speaker !== speaker || at - previous.at >= 20) {
      // Meet sometimes appends a new utterance to the same speaker's previous caption.
      // Drop the shared prefix, including punctuation that Meet revised in the meantime.
      const normalize = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const shared = previous && words.length > previous.words.length && previous.words.every((word, i) => normalize(word) === normalize(words[i]));
      previous = { speaker, skip: shared ? previous.words.length : 0, turn: { name: speaker, start: at, text: "" } };
      turns.push(previous.turn);
    }
    previous.turn.text = words.slice(previous.skip).join(" ");
    previous.at = at;
    previous.words = words;
    if (block != null) blocks.set(block, previous);
  }
  return turns.filter((turn) => turn.text);
}

export class Meet {
  constructor({ store, boxes, voice = null, artifacts = null, log = () => {}, emit = () => {}, notice = null, instanceUrl = "", timezone = "Europe/Rome", pollMs = 4000, limits = {} }) {
    this.store = store;
    this.boxes = boxes;
    this.voice = voice;
    this.artifacts = artifacts;
    this.log = log;
    this.emit = emit;
    this.notice = notice;
    this.instanceUrl = instanceUrl;
    this.timezone = timezone;
    this.pollMs = pollMs;
    this.limits = { waitMinutes: 10, aloneSeconds: 90, maxMinutes: 240, ...limits };
    this.timer = null;
    this.busy = new Set();
    this.checking = new Map();
    this.starting = new Set();
  }

  get language() { return this.store.settings.language === "it" ? "it" : this.store.settings.language ? "en" : "it"; }

  config(agentId) {
    return { enabled: false, account: null, ...(this.store.value(`meet:${agentId}`) || {}) };
  }

  save(agentId, change) {
    const next = { ...this.config(agentId), ...change };
    this.store.setValue(`meet:${agentId}`, next);
    return next;
  }

  sessions(agentId) { return this.store.value(`meetSessions:${agentId}`, []); }

  session(agentId) { return this.sessions(agentId).find((item) => ACTIVE.has(item.phase)) || null; }

  write(session) {
    const rest = this.sessions(session.agentId).filter((item) => item.id !== session.id);
    this.store.setValue(`meetSessions:${session.agentId}`, [session, ...rest].slice(0, KEEP));
    this.emit({ type: "meet", agentId: session.agentId, session: this.sessionView(session) });
    return session;
  }

  /** Whether the agent may be sent into a call at all: switched on, with a desktop to sit at. */
  available(agent) { return Boolean(agent?.enabled && agent.tools && this.config(agent.id).enabled); }

  folders(agent, user) {
    return (this.artifacts ? this.store.artifactFolders() : []).filter((folder) => FOLDER.test(folder.path) && !encryptedFolder(this.store, folder.id) && this.artifacts.canWrite(folder, agent) && (!user || this.artifacts.canUpload(folder, user))).map((folder) => ({ id: folder.id, path: folder.path, title: folder.title }));
  }

  sessionView(session) {
    if (!session) return null;
    const text = words(this.language);
    return {
      id: session.id, phase: session.phase, reason: session.reason || "", why: session.reason ? text.reasons[session.reason] || session.reason : "",
      link: session.link, folder: session.folder, by: session.by?.name || "", startedAt: session.startedAt, joinedAt: session.joinedAt || 0, endedAt: session.endedAt || 0,
      people: session.people || 0, names: session.names || [], heard: Boolean(session.audioBytes > 4000), transcript: session.transcript || null, error: session.error || "",
    };
  }

  view(agent, user = null) {
    const config = this.config(agent.id);
    const sessions = this.sessions(agent.id);
    return {
      enabled: config.enabled,
      language: MEETING_LANGUAGES.includes(agent.voiceLanguage) ? agent.voiceLanguage : this.language,
      account: config.account,
      setup: this.setupView(config),
      desktop: Boolean(agent.tools),
      onAir: Boolean(agent.enabled),
      transcription: Boolean(this.voice?.enabled),
      artifacts: Boolean(this.artifacts),
      folders: this.folders(agent, user),
      active: this.sessionView(sessions.find((item) => ACTIVE.has(item.phase))),
      recent: sessions.filter((item) => !ACTIVE.has(item.phase)).slice(0, 5).map((item) => this.sessionView(item)),
    };
  }

  setupView(config) {
    const setup = config.setup;
    if (!setup) return null;
    const routine = config.setupRoutineId && this.store.routine(config.setupRoutineId, { archived: true });
    const pending = routine?.enabled && !routine.archivedAt && [null, "running", "skipped"].includes(routine.lastStatus);
    if (setup.status === "running" && config.setupRoutineId && !pending) return { status: "failed" };
    return { status: setup.status, note: setup.note || "" };
  }

  async queueSetup(agent) {
    await this.desk(agent);
    if (this.session(agent.id) || this.starting.has(agent.id)) throw new MeetError("Esci prima dalla riunione attiva.", 409);
    const mailbox = this.store.value(`agentMailbox:${agent.id}`);
    if (mailbox?.status !== "ready" || !mailbox.email) throw new MeetError("L’agente deve avere una casella email configurata.", 409);
    this.store.tx(() => {
      const config = this.config(agent.id);
      const existing = config.setupRoutineId && this.store.routine(config.setupRoutineId);
      if (existing?.enabled && [null, "running", "skipped"].includes(existing.lastStatus)) return;
      const runAt = new Date().toISOString();
      const input = {
        kind: "reminder", enabled: true, runAt, name: "Google Meet · account", channelId: privateRoom(agent.id),
        prompt: "Connect Google Meet using your own currently configured mailbox. First use meet_setup check to verify the signed-in identity. If setup is required, use meet_setup start and follow its instructions to sign in or register using that mailbox. Reuse any existing account and progress. Obtain mailbox verification yourself. Only request a specific action if Google requires a human. Never include passwords or verification codes in chat. Finish only when meet_setup check confirms the expected address. Report the outcome here.",
      };
      const routine = existing ? this.store.updateRoutine(existing.id, input) : this.store.createRoutine(agent.id, input);
      this.save(agent.id, { setupRoutineId: routine.id, setup: { ...config.setup, email: mailbox.email, note: "", status: "running" } });
    });
  }

  setEnabled(agent, enabled) {
    if (this.session(agent.id) || this.starting.has(agent.id)) throw new MeetError("Esci prima dalla riunione attiva.", 409);
    if (enabled && !agent.tools) throw new MeetError("Per entrare in una riunione l'agente usa il suo computer: accendi «Usa il suo computer» nel Cervello.", 409);
    if (!enabled) this.cancelQueuedSetup(agent);
    this.save(agent.id, { enabled: Boolean(enabled) });
    this.log({ type: "meet", agentId: agent.id, text: `Google Meet ${enabled ? "acceso" : "spento"} per ${agent.name}` });
    return this.view(agent);
  }

  cancelQueuedSetup(agent) {
    const id = this.config(agent.id).setupRoutineId;
    const routine = id && this.store.routine(id);
    if (routine?.lastStatus === "running") throw new MeetError("Il collegamento a Google è in corso.", 409);
    if (routine) this.store.deleteRoutine(id);
    this.save(agent.id, { setup: null, setupRoutineId: null });
  }

  async desk(agent) {
    if (!agent.enabled || encryptedOnly(this.store, agent)) throw new MeetError("Questo agente non può registrare riunioni.", 409);
    if (!agent.tools) throw new MeetError("Questo agente non ha un computer: accendilo nel Cervello.", 409);
    if (!this.config(agent.id).enabled) throw new MeetError("Google Meet è spento per questo agente: accendilo nelle sue impostazioni.", 409);
    try { await this.boxes.ensure(agent); } catch (error) { throw new MeetError(`Il desktop dell'agente non parte: ${error.message}`, 503); }
  }

  /** Opens Google's sign-in on the agent's desktop, where the person types the account's password themselves. */
  async signIn(agent) {
    await this.desk(agent);
    if (this.session(agent.id) || this.starting.has(agent.id)) throw new MeetError("L’agente sta entrando in una riunione o è già dentro.", 409);
    await this.boxes.meet(agent.id, ["signin"]);
    return this.view(agent);
  }

  /** Reads which Google account the agent's Meet browser holds, and remembers it. */
  check(agent) {
    if (this.checking.has(agent.id)) return this.checking.get(agent.id);
    const job = (async () => {
      await this.desk(agent);
      const seen = await this.boxes.meet(agent.id, ["account", this.session(agent.id) ? "keep" : ""].filter(Boolean), { timeoutMs: 90000 });
      if (seen.unknown) throw new MeetError("Google non ha risposto: riprova tra poco.", 502);
      this.save(agent.id, { account: seen.email ? { email: seen.email, name: seen.name || "", checkedAt: Date.now() } : null });
      return this.view(agent);
    })().finally(() => this.checking.delete(agent.id));
    this.checking.set(agent.id, job);
    return job;
  }

  /** The vault name of the agent's Google password when nobody chose another. */
  setupSecret(agent) {
    const base = String(agent.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
    return `GOOGLE_${base || "AGENT"}_PASSWORD`;
  }

  recordSetup(agent, change) {
    const setup = { ...(this.config(agent.id).setup || {}), ...change, updatedAt: Date.now() };
    this.save(agent.id, { setup });
    this.emit({ type: "meet", agentId: agent.id, setup });
    return setup;
  }

  /**
   * The agent signs its own Google account into its Meet browser: start prepares the
   * password in the vault and the sign-in page, the agent does the rest on its desktop,
   * check confirms the account the browser holds is the agent's own address.
   */
  async setup(agent, { step = "start", email = "", secret = "", note = "", vault = null } = {}) {
    const current = this.config(agent.id).setup || {};
    const expected = String(email || current.email || "").trim().toLowerCase();
    if (step === "needs-human" || step === "failed") {
      const text = String(note || "").trim().slice(0, 300);
      if (!text) throw new MeetError("Say in one line what is missing.", 400);
      const setup = this.recordSetup(agent, { status: step, note: text });
      this.log({ type: "meet", agentId: agent.id, text: `Google Meet di ${agent.name}: ${step === "failed" ? "accesso fallito" : "serve una persona"} (${text})` });
      return { status: setup.status, note: setup.note };
    }
    if (!expected) throw new MeetError("You have no mailbox of your own, and the Google account uses it: ask the owner to set up your email.", 409);
    if (step === "check") {
      const account = (await this.check(agent)).account;
      const done = Boolean(account?.email && account.email.toLowerCase() === expected);
      const setup = this.recordSetup(agent, done ? { status: "done", email: expected, note: "", doneAt: Date.now() } : { status: SETUP.has(current.status) && current.status !== "done" ? current.status : "running", email: expected });
      if (done) this.log({ type: "meet", agentId: agent.id, text: `${agent.name} ha collegato ${expected} a Google Meet` });
      return { status: setup.status, account: account?.email || null, expected, ...(done ? {} : { next: account?.email ? `The Meet browser holds ${account.email}, not ${expected}.` : "The Meet browser is not signed in yet: finish Google's steps, then check again." }) };
    }
    if (step !== "start") throw new MeetError("step is start, check, needs-human or failed.", 400);
    await this.desk(agent);
    if (this.session(agent.id) || this.starting.has(agent.id)) throw new MeetError("You are in a call or joining one: leave it first.", 409);
    const signed = (await this.check(agent)).account;
    if (signed?.email?.toLowerCase() === expected) {
      this.recordSetup(agent, { status: "done", email: expected, note: "", doneAt: Date.now() });
      return { status: "done", account: signed.email, expected };
    }
    if (signed?.email) {
      const setup = this.recordSetup(agent, { status: "needs-human", email: expected, note: `Il browser Meet è collegato a ${signed.email}` });
      return { status: setup.status, account: signed.email, expected, next: `The Meet browser is signed in as ${signed.email}, not your address: tell the person and ask whether to sign it out from Settings → Google Meet.` };
    }
    if (!vault?.enabled) throw new MeetError("The vault is off in this space, and the Google password lives there.", 409);
    const name = secret ? vault.cleanName(secret) : this.setupSecret(agent);
    if (secret && !this.store.vaultSecret(name)) throw new MeetError(`There is no secret ${name}: secret_list shows the names.`, 404);
    const created = !this.store.vaultSecret(name);
    if (created) vault.put({ name, value: googlePassword(), description: `Password Google di ${agent.name} (${expected}) per Google Meet`, agents: [agent.id], by: { kind: "agent", id: agent.id, name: agent.name }, source: "meet" });
    await vault.importInto(agent, name);
    await this.boxes.meet(agent.id, ["signin"]);
    this.recordSetup(agent, { status: "running", email: expected, secret: name, note: "", startedAt: Date.now(), doneAt: 0 });
    this.log({ type: "meet", agentId: agent.id, text: `${agent.name} collega ${expected} a Google Meet` });
    return { status: "running", email: expected, secret: name, newPassword: created, steps: setupSteps({ email: expected, secret: name, created, name: agent.name }) };
  }

  async signOut(agent) {
    await this.desk(agent);
    if (this.session(agent.id) || this.starting.has(agent.id)) throw new MeetError("L’agente sta entrando in una riunione o è già dentro.", 409);
    this.cancelQueuedSetup(agent);
    await this.boxes.meet(agent.id, ["signout"], { timeoutMs: 60000 });
    this.save(agent.id, { account: null });
    this.log({ type: "meet", agentId: agent.id, text: `account Google scollegato da ${agent.name}` });
    return this.view(agent);
  }

  async join(agent, options = {}) {
    if (this.starting.has(agent.id)) throw new MeetError("Un ingresso è già in corso.", 409);
    this.starting.add(agent.id);
    try { return await this.startCall(agent, options); }
    finally { this.starting.delete(agent.id); }
  }

  async startCall(agent, { link, folder, language = "", by = null, channelId = "", memberUserId = "", panelOrigin = "" } = {}) {
    const spokenLanguage = language || (MEETING_LANGUAGES.includes(agent.voiceLanguage) ? agent.voiceLanguage : this.language);
    if (!MEETING_LANGUAGES.includes(spokenLanguage)) throw new MeetError("Lingua della riunione non supportata.");
    const url = String(link || "").trim();
    if (!MEET_LINK.test(url)) throw new MeetError("Serve un link di Google Meet, come https://meet.google.com/abc-defg-hij.");
    await this.desk(agent);
    if (!this.artifacts) throw new MeetError("Gli artefatti non sono attivi su questo spazio.", 409);
    if (this.session(agent.id)) throw new MeetError("L'agente è già in una riunione: fallo uscire prima di mandarlo in un'altra.", 409);
    const path = String(folder || "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!FOLDER.test(path)) throw new MeetError("La trascrizione va in una cartella meetings/<progetto-o-cliente>, per esempio meetings/acme.");
    const target = this.store.artifactFolderByPath(path);
    if (!target || !this.artifacts.canWrite(target, agent) || encryptedFolder(this.store, target.id)) throw new MeetError("Scegli una cartella meetings/ disponibile per questo agente.", 404);
    this.artifacts.checkMember(target, memberUserId, true);
    const account = (await this.check(agent)).account;
    if (!account) throw Object.assign(new MeetError("L'agente non è collegato a Google: senza un account Meet rifiuta l'ingresso. Collegalo in Impostazioni → Google Meet.", 409), { code: "sign-in" });
    const session = {
      id: `ms_${randomBytes(6).toString("hex")}`, agentId: agent.id, memberUserId, panelOrigin, language: spokenLanguage, link: url.split(/[?#]/)[0], folder: path, folderId: target.id, by, channelId: String(channelId || ""),
      phase: "starting", reason: "", startedAt: Date.now(), joinedAt: 0, endedAt: 0, people: 0, names: [], audioBytes: 0, account: account.email, self: account.name || "",
    };
    const settings = { url: session.link, name: agent.name, account: account.email, language: spokenLanguage, ...this.limits };
    this.write(session);
    try { await this.boxes.meet(agent.id, ["start", session.id, Buffer.from(JSON.stringify(settings)).toString("base64")]); }
    finally { this.start(); }
    this.log({ type: "meet", agentId: agent.id, text: `${agent.name} entra in ${session.link}${by?.name ? ` (chiesto da ${by.name})` : ""}` });
    return this.sessionView(session);
  }

  async leave(agent) {
    const session = this.session(agent.id);
    if (!session) throw new MeetError("L'agente non è in nessuna riunione.", 409);
    if (session.phase !== "transcribing") await this.boxes.meet(agent.id, ["stop", session.id]);
    return this.sessionView(session);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Calls that were going when Cora stopped are followed again; one caught mid-transcript starts over. */
  resume() {
    let any = false;
    for (const agent of this.store.agents()) {
      const session = this.session(agent.id);
      if (!session) continue;
      any = true;
      if (session.phase === "transcribing") this.write({ ...session, phase: "joined" });
    }
    if (any) this.start();
  }

  async poll() {
    let any = false;
    for (const agent of this.store.agents()) {
      const session = this.session(agent.id);
      if (!session) continue;
      any = true;
      if (this.busy.has(session.id)) continue;
      this.busy.add(session.id);
      try { await this.follow(agent, session); } catch (error) { this.log({ type: "error", agentId: agent.id, text: `Meet: ${error.message}` }); } finally { this.busy.delete(session.id); }
    }
    if (!any) this.stop();
  }

  async follow(agent, session) {
    if (session.phase === "transcribing") return;
    let state;
    try { state = await this.boxes.meet(agent.id, ["state", session.id], { timeoutMs: 20000 }); } catch (error) {
      // A desktop that is restarting answers nothing for a while; a call nobody can reach for five minutes is over.
      const silent = Date.now() - (session.seenAt || session.startedAt);
      if (silent > 5 * 60000) return this.finish(agent, { ...session, endedAt: Date.now(), reason: "crashed" }, "crashed");
      return;
    }
    const dead = state.phase === "missing" ? Date.now() - session.startedAt > 60000 : !state.alive && !["ended", "failed"].includes(state.phase);
    const next = {
      ...session, seenAt: Date.now(), audioFile: state.audioFile === "audio.flac" ? "audio.flac" : session.audioFile, joinedAt: state.joinedAt || session.joinedAt, people: state.people ?? session.people,
      names: state.names?.length ? state.names : session.names, audioBytes: state.audioBytes ?? session.audioBytes, recordingAt: state.recordingAt || session.recordingAt || 0,
    };
    if (dead) return this.finish(agent, { ...next, endedAt: Date.now() }, "crashed");
    if (state.phase === "ended" || state.phase === "failed") return this.finish(agent, { ...next, endedAt: state.endedAt || Date.now() }, state.reason || "call-over");
    if (["starting", "waiting", "joined"].includes(state.phase) && (state.phase !== session.phase || next.people !== session.people || next.names.length !== session.names.length || next.joinedAt !== session.joinedAt)) {
      if (state.phase === "joined" && session.phase !== "joined") this.log({ type: "meet", agentId: agent.id, text: `${agent.name} è nella riunione ${session.link}` });
      this.write({ ...next, phase: state.phase });
    } else this.store.setValue(`meetSessions:${agent.id}`, this.sessions(agent.id).map((item) => item.id === next.id ? { ...next, phase: session.phase } : item));
  }

  /** After the call: the transcript in Artifacts when anyone was heard, and a word in the conversation that asked. */
  async finish(agent, session, reason) {
    const text = words(this.language);
    if (!session.joinedAt || !session.recordingAt) {
      const done = this.write({ ...session, phase: session.joinedAt ? "ended" : "failed", reason });
      await this.boxes.meet(agent.id, ["clean", session.id]).catch(() => {});
      this.log({ type: "meet", agentId: agent.id, text: `${agent.name}: riunione ${session.link} chiusa senza trascrizione (${text.reasons[reason] || reason})` });
      await this.tell(done, this.language === "it"
        ? `📞 ${agent.name} ${session.joinedAt ? "è uscito dalla riunione" : "non è entrato nella riunione"} ${session.link}: ${text.reasons[reason] || reason}.${session.joinedAt ? " Non c'è niente da trascrivere." : ""}`
        : `📞 ${agent.name} ${session.joinedAt ? "left the call" : "did not get into the call"} ${session.link}: ${text.reasons[reason] || reason}.${session.joinedAt ? " There is nothing to transcribe." : ""}`);
      return done;
    }
    let current = this.write({ ...session, phase: "transcribing", reason });
    try {
      const target = this.store.artifactFolder(session.folderId);
      if (!target || encryptedOnly(this.store, agent) || encryptedFolder(this.store, target.id) || !this.artifacts.canWrite(target, agent)) throw new MeetError("Cartella non disponibile.", 403);
      this.artifacts.checkMember(target, session.memberUserId, true);
      const { captions } = await this.boxes.meet(agent.id, ["captions", session.id], { timeoutMs: 30000 });
      const others = (session.names || []).filter((name) => name && name !== session.self);
      let named;
      if (this.voice?.enabled) {
        const filename = session.audioFile === "audio.flac" ? "audio.flac" : "audio.webm";
        const audio = await this.boxes.readFile(agent.id, `/home/agent/.cora-meet/sessions/${session.id}/${filename}`, AUDIO_LIMIT);
        const heard = await this.voice.transcribeCall(audio, { filename, languages: [session.language || this.language], reference: `cora-meet-${session.id}` });
        const turns = turnsFrom(heard.tokens);
        const names = nameSpeakers(turns, captions, others, text.unknown);
        named = turns.map((turn) => ({ ...turn, name: names.get(turn.speaker) }));
        if (!named.length && captions.length) named = captionTurns(captions);
      } else {
        named = captionTurns(captions);
        if (!named.length) throw new MeetError("Meet non ha restituito sottotitoli. Per trascrivere dalla registrazione, collega Soniox e riprova.");
      }
      const markdown = transcriptMarkdown({ language: this.language, timezone: this.timezone, agentName: agent.name, link: session.link, startedAt: session.recordingAt, endedAt: session.endedAt, people: others, turns: named });
      const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(session.recordingAt)).replace(" ", "-").replace(":", "");
      const name = `${stamp}-${session.id}`;
      const root = `/home/agent/work/meetings/${session.folder.slice("meetings/".length)}/${name}`;
      await this.boxes.writeFile(agent.id, `${root}/transcript.md`, Buffer.from(markdown, "utf8"));
      const pushed = await this.artifacts.push({ agent, folder: session.folder, path: root, to: name, message: `${text.title} ${stamp}: ${named.length ? `${Math.max(1, Math.round((session.endedAt - session.recordingAt) / 60000))} ${text.minutes}` : text.empty}`.slice(0, 280), channelId: session.channelId, memberUserId: session.memberUserId, announceToChannel: false });
      const commit = pushed.commit || pushed.pending || (pushed.nothing && this.store.artifactCommit(target.head));
      if (!commit) throw new Error("Ricevuta artefatto mancante.");
      current = this.write({
        ...current, phase: "ended",
        transcript: { folderId: session.folderId, folder: session.folder, path: `${name}/transcript.md`, commit: commit?.id || "", status: commit?.status || "", turns: named.length, speakers: [...new Set(named.map((turn) => turn.name))], url: `${this.instanceUrl || session.panelOrigin || ""}/#/artefatti/${session.folderId}/c/${commit.id}` },
      });
      await this.boxes.meet(agent.id, ["clean", session.id]).catch(() => {});
      this.log({ type: "meet", agentId: agent.id, text: `${agent.name} ha trascritto la riunione ${session.link} in ${session.folder}/${name}` });
      const state = commit?.status === "published" ? (this.language === "it" ? "pubblicata" : "published") : (this.language === "it" ? "in attesa di revisione" : "waiting for review");
      await this.tell(current, this.language === "it"
        ? `📞 ${agent.name} è uscito dalla riunione ${session.link} (${text.reasons[reason] || reason}). Trascrizione in **${session.folder}**, ${state}: ${named.length} ${named.length === 1 ? "intervento" : "interventi"}${others.length ? ` di ${[...new Set(named.map((turn) => turn.name))].join(", ")}` : ""}.${current.transcript.url ? ` ${current.transcript.url}` : ""}`
        : `📞 ${agent.name} left the call ${session.link} (${text.reasons[reason] || reason}). Transcript in **${session.folder}**, ${state}: ${named.length} turns.${current.transcript.url ? ` ${current.transcript.url}` : ""}`);
    } catch (error) {
      // The recording stays on the desktop: the transcript can be made again from the panel.
      current = this.write({ ...current, phase: "ended", error: String(error.message || error).slice(0, 300) });
      this.log({ type: "error", agentId: agent.id, text: `Meet: trascrizione di ${session.link} non riuscita: ${current.error}` });
      await this.tell(current, this.language === "it" ? `📞 ${agent.name} è uscito dalla riunione ${session.link}, ma la trascrizione non è riuscita: ${current.error}. La registrazione resta sul suo desktop: riprova dalle sue impostazioni, in Google Meet.` : `📞 ${agent.name} left the call ${session.link}, but the transcript failed: ${current.error}. The recording stays on its desktop: try again from its settings, under Google Meet.`);
    }
    return current;
  }

  /** A transcript that failed is made again from the recording still on the desktop. */
  async retry(agent, id) {
    const session = this.sessions(agent.id).find((item) => item.id === id);
    if (!session || !session.error || session.transcript) throw new MeetError("Non c'è una trascrizione da rifare.", 404);
    if (this.session(agent.id)) throw new MeetError("L'agente è in una riunione: aspetta che finisca.", 409);
    await this.desk(agent);
    if (this.session(agent.id) || this.busy.has(session.id)) throw new MeetError("Trascrizione già in corso.", 409);
    const { error, ...rest } = session;
    this.busy.add(session.id);
    try { return this.sessionView(await this.finish(agent, rest, session.reason || "call-over")); } finally { this.busy.delete(session.id); }
  }

  async tell(session, text) {
    if (session.channelId && this.notice) {
      try { await this.notice(session.channelId, text); } catch (error) { this.log({ type: "error", agentId: session.agentId, text: `Meet chat: ${error.message}` }); }
    }
  }
}
