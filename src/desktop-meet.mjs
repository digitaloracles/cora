// The agent's seat in a Google Meet call, run on its own desktop with nothing but Node:
// a Chromium of its own (its Google session lives in that profile), driven over the
// debugging port. It joins with microphone and camera off, records what the others say,
// notes who is speaking from Meet's captions, and leaves when the call is over.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CORA_MEET_CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = process.env.CORA_MEET_HOME || join(homedir(), ".cora-meet");
const PROFILE = join(HOME, "chromium");
const pulseSocket = join(HOME, "audio.sock");
const audioEnv = { ...process.env, PULSE_SERVER: "unix:" + pulseSocket, PULSE_SINK: "cora_meet" };
const BINARY = process.env.CORA_MEET_CHROMIUM || (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : "chromium");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function version() {
  try {
    const response = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

/** The Meet Chromium, started on the desktop the owner watches when it is not already there. */
async function browser() {
  let info = await version();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  try {
    execFileSync("pactl", ["info"], { env: audioEnv, stdio: "ignore", timeout: 3000 });
  } catch {
    if (!existsSync("/usr/bin/pulseaudio")) throw new Error("Aggiorna il desktop dell’agente per abilitare l’audio Meet.");
    execFileSync("pulseaudio", ["-n", "--daemonize=yes", "--use-pid-file=no", "--exit-idle-time=-1",
      "--load=module-null-sink sink_name=cora_meet rate=48000 channels=2",
      "--load=module-native-protocol-unix socket=" + pulseSocket], { stdio: "ignore", timeout: 10000 });
  }
  if (info) return info;
  if (!existsSync(join(PROFILE, "Default", "Preferences"))) {
    // A profile that never offers to keep the password someone types on the agent's desktop.
    mkdirSync(join(PROFILE, "Default"), { recursive: true });
    writeFileSync(join(PROFILE, "Default", "Preferences"), JSON.stringify({ credentials_enable_service: false, credentials_enable_autosignin: false, profile: { password_manager_enabled: false } }));
  }
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(PROFILE, lock), { force: true });
  const child = spawn(BINARY, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1",
    "--ozone-platform=x11", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--password-store=basic", "--test-type", "--autoplay-policy=no-user-gesture-required", "--lang=en-US",
    "--window-size=1100,720", "--window-position=40,40", "about:blank",
  ], { detached: true, stdio: "ignore", env: { ...audioEnv, DISPLAY: process.env.DISPLAY || ":1", LANGUAGE: "en_US" } });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500);
    info = await version();
    if (info) return info;
  }
  throw new Error("the Meet browser did not start");
}

/** One socket to the browser; every page is a session on it. */
async function connect() {
  const info = await browser();
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("cannot reach the Meet browser")), { once: true });
  });
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); } catch { return; }
    if (payload.id && waiting.has(payload.id)) {
      const { resolve, reject, method } = waiting.get(payload.id);
      waiting.delete(payload.id);
      if (payload.error) reject(new Error(`${method}: ${payload.error.message}`));
      else resolve(payload.result);
    } else if (payload.method) for (const listener of listeners) listener(payload);
  });
  socket.addEventListener("close", () => { for (const { reject, method } of waiting.values()) reject(new Error(`${method}: the Meet browser closed`)); waiting.clear(); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: timeout`)); }, 30000);
    waiting.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
  });
  return { send, on: (listener) => listeners.add(listener), close: () => socket.close(), get open() { return socket.readyState === 1; } };
}

async function openPage(cdp, url, { background = false } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    targetId, sessionId,
    send: (method, params) => cdp.send(method, params, sessionId),
    async evaluate(expression) {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "the page refused the script");
      return result.result?.value;
    },
    close: () => cdp.send("Target.closeTarget", { targetId }).catch(() => {}),
  };
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  if (url) await page.send("Page.navigate", { url });
  return page;
}

/** Which Google account this profile is signed in with: read from Google's own account page. */
async function account(cdp) {
  const page = await openPage(cdp, "https://myaccount.google.com/?hl=en", { background: true });
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(700);
      const seen = await page.evaluate(`(() => {
        if (document.readyState === "loading") return null;
        if (location.hostname === "accounts.google.com" || /^www\\.google\\.com$/.test(location.hostname)) return { email: "", name: "" };
        if (location.hostname !== "myaccount.google.com") return null;
        const labelled = [...document.querySelectorAll("a[aria-label], button[aria-label]")].map((node) => node.getAttribute("aria-label")).find((label) => /[^\\s(]+@[^\\s)]+/.test(label || ""));
        if (!labelled) return document.readyState === "complete" && document.querySelector('a[href*="ServiceLogin"], a[href*="signin"]') ? { email: "", name: "" } : null;
        const email = /[^\\s(]+@[^\\s)]+/.exec(labelled)[0];
        const name = (/:\\s*(.+?)\\s*\\(/.exec(labelled) || [])[1] || "";
        return { email, name };
      })()`).catch(() => null);
      if (seen) return seen;
    }
    return { email: "", name: "", unknown: true };
  } finally { await page.close(); }
}

const MEET_URL = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[\w-]+)(?:[?#].*)?$/i;

// Captions carry the participant name. Audio comes only from this browser's isolated output.
const READ_CAPTIONS = `(() => {
  const started = Date.now();
  const tell = (message) => window.__coraMeet(JSON.stringify(message));
  const said = new WeakMap();
  let nextBlock = 0;
  setInterval(() => {
    const region = document.querySelector('[role="region"][aria-label*="aption" i], [role="region"][aria-label*="ottotitol" i]');
    if (!region) return;
    for (const picture of region.querySelectorAll("img")) {
      const block = picture.parentElement?.parentElement;
      if (!block) continue;
      const lines = block.innerText.split("\\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const text = lines.slice(1).join(" ");
      const previous = said.get(block);
      if (previous?.text === text && previous.speaker === lines[0]) continue;
      const id = previous?.speaker === lines[0] ? previous.id : ++nextBlock;
      said.set(block, { id, speaker: lines[0], text });
      tell({ kind: "caption", block: id, at: (Date.now() - started) / 1000, speaker: lines[0].slice(0, 120), text: text.slice(-8000) });
    }
  }, 700);
  return true;
})()`;

const LOOK = `(() => {
  const text = document.body ? document.body.innerText : "";
  const labels = [...document.querySelectorAll("button, [role=button]")].map((node) => (node.getAttribute("aria-label") || "") + "\\n" + (node.innerText || "")).join("\\n");
  const tiles = [...document.querySelectorAll("[data-participant-id]")];
  return {
    url: location.href,
    // The waiting room has the hang-up button too: only the call itself offers captions, reactions and a raised hand.
    inCall: /Leave call|Abbandona (la )?chiamata|Esci dalla chiamata/i.test(labels) && /captions|Raise hand|Send a reaction|sottotitoli|Alza la mano|Invia una reazione/i.test(labels),
    waiting: /Leave call|Abbandona (la )?chiamata|Esci dalla chiamata/i.test(labels) || /Asking to be let in|Asking to join|let you in soon|lets you in|wait until a meeting host|Richiesta di partecipazione|ti faccia entrare|ti farà entrare|Attendi che un organizzatore/i.test(text),
    refused: /denied your request|You can't join this (video )?call|No one responded|rifiutato la tua richiesta|Non puoi partecipare|Nessuno ha risposto/i.test(text),
    missing: /Check your meeting code|Invalid video call name|Controlla il codice riunione|Nome della videochiamata non valido/i.test(text),
    ended: /You left the (meeting|call)|You've been removed|You were removed|The (call|meeting) has ended|ended the (call|meeting) for everyone|Hai abbandonato|Sei stato rimosso|è terminata/i.test(text),
    signIn: location.hostname === "accounts.google.com",
    people: new Set(tiles.map((tile) => tile.getAttribute("data-participant-id"))).size,
    names: [...new Set(tiles.map((tile) => tile.querySelector("span.notranslate")?.textContent?.trim()).filter(Boolean))].slice(0, 100),
    captions: Boolean(document.querySelector('[role="region"][aria-label*="aption" i], [role="region"][aria-label*="ottotitol" i]')),
    sample: text.slice(0, 600),
  };
})()`;

// A button is known by its aria-label or by any line of its text: Meet puts icon names and badges beside the words.
const FIND = `(source) => {
  const wanted = new RegExp(source, "i");
  for (const node of document.querySelectorAll("button, [role=button]")) {
    if (node.disabled || node.getAttribute("aria-disabled") === "true") continue;
    const labels = [node.getAttribute("aria-label") || "", ...(node.innerText || "").split("\\n")].map((label) => label.trim()).filter(Boolean);
    const label = labels.find((item) => wanted.test(item));
    if (!label) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    return { node, label };
  }
  return null;
}`;

/**
 * A real click on the first visible button whose label matches, so Meet sees a person's click.
 * When something else covers that point the button is clicked directly: a click must never land elsewhere.
 */
async function press(page, pattern) {
  const spot = await page.evaluate(`(() => {
    const found = (${FIND})(${JSON.stringify(pattern.source)});
    if (!found) return null;
    found.node.scrollIntoView({ block: "center" });
    const placed = found.node.getBoundingClientRect();
    const x = placed.left + placed.width / 2, y = placed.top + placed.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || !(found.node === top || found.node.contains(top))) { found.node.click(); return { label: found.label, direct: true }; }
    return { x, y, label: found.label };
  })()`).catch(() => null);
  if (!spot) return "";
  if (!spot.direct) for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: spot.x, y: spot.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  return spot.label;
}

async function has(page, pattern) {
  return Boolean(await page.evaluate(`Boolean((${FIND})(${JSON.stringify(pattern.source)}))`).catch(() => false));
}

const MIC_ON = /^(Turn off microphone|Disattiva (il )?microfono)/;
const CAMERA_ON = /^(Turn off camera|Disattiva (la )?(fotocamera|videocamera|video))/;
const NO_DEVICES = /Continue without (microphone|camera|mic)|Continua senza (microfono|videocamera|fotocamera)/;
// Never "Switch here": that would take the call away from the same account on another device.
const JOIN = /^(Ask to join|Join now|Join anyway|Join here too|Join|Chiedi di partecipare|Partecipa ora|Partecipa comunque|Partecipa anche qui|Partecipa)$/;
const LEAVE = /Leave call|Abbandona (la )?chiamata|Esci dalla chiamata/;
// The same Google account already in the call from another device: the agent sits beside it.
const TAKE_OVER = /^(Switch here|Passa qui)/;
const OTHER_WAYS = /^(Other ways to join|Altri modi per partecipare)/;
const BESIDE = /^(Join here too|Partecipa anche (da )?qui)/;

/** Meet's captions say who is speaking; the `c` shortcut turns them on, and would turn them off again. */
async function captions(page) {
  if ((await page.evaluate(LOOK).catch(() => null))?.captions !== false) return;
  await page.evaluate("document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.blur()").catch(() => {});
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, ...(type === "keyDown" ? { text: "c" } : {}) });
  await sleep(1500);
}

async function captionLanguage(page, language) {
  if (!language) return;
  await page.evaluate(`(() => {
    const combo = document.querySelector('[role="combobox"][aria-label="Meeting language"], [role="combobox"][aria-label="Lingua della riunione"]');
    const list = document.querySelector('[role="listbox"][aria-label="Meeting language"], [role="listbox"][aria-label="Lingua della riunione"]');
    const option = [...(list?.querySelectorAll('[role="option"][data-value]') || [])].find(n => n.dataset.value.toLowerCase().split("-")[0] === ${JSON.stringify(language)});
    if (!combo || !option || option.getAttribute("aria-selected") === "true") return;
    combo.click();
    option.click();
  })()`).catch(() => {});
}

/** Nobody hears or sees the agent: whatever Meet switched on is switched off. */
async function silence(page) {
  for (const control of [MIC_ON, CAMERA_ON]) if (await has(page, control)) { await press(page, control); await sleep(700); }
}

async function run(dir) {
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const statePath = join(dir, "state.json");
  const audioPath = join(dir, "audio.flac");
  const state = { phase: "starting", reason: "", startedAt: Date.now(), joinedAt: 0, endedAt: 0, recordingAt: 0, audioBytes: 0, captions: 0, people: 0, names: [], account: "", pid: process.pid, beat: Date.now() };
  const save = (change = {}) => {
    Object.assign(state, change, { beat: Date.now() });
    writeFileSync(`${statePath}.new`, JSON.stringify(state));
    renameSync(`${statePath}.new`, statePath);
  };
  const log = (line) => appendFileSync(join(dir, "log"), `${new Date().toISOString()} ${line}\n`);
  const stopAsked = () => existsSync(join(dir, "stop"));
  save();
  if (!MEET_URL.test(config.url)) return save({ phase: "failed", reason: "invalid-link", endedAt: Date.now() });
  let cdp, page, recorder, recorderDone;
  const finish = async (phase, reason) => {
    if (recorder) { recorder.kill("SIGTERM"); await recorderDone; }
    if (page) {
      await press(page, LEAVE).catch(() => {});
      await sleep(800);
      await page.close();
    }
    if (cdp?.open) {
      // The browser goes away with the call: it comes back for the next one, with the same session.
      await cdp.send("Browser.close").catch(() => {});
    }
    save({ phase, reason, endedAt: Date.now(), audioBytes: existsSync(audioPath) ? statSync(audioPath).size : 0 });
    log(`${phase} ${reason}`);
  };
  try {
    cdp = await connect();
    const who = await account(cdp);
    if (!who.email || (config.account && who.email.toLowerCase() !== config.account.toLowerCase())) return finish("failed", "sign-in");
    save({ account: who.email });
    log(`account ${who.email ? "signed in" : "none"}`);
    for (const name of ["microphone", "camera"]) {
      await cdp.send("Browser.setPermission", { permission: { name }, setting: "denied", origin: "https://meet.google.com" });
    }
    page = await openPage(cdp, "");
    await page.send("Runtime.addBinding", { name: "__coraMeet" });
    cdp.on((event) => {
      if (event.sessionId !== page.sessionId || event.method !== "Runtime.bindingCalled" || event.params.name !== "__coraMeet") return;
      let message;
      try { message = JSON.parse(event.params.payload); } catch { return; }
      if (message.kind === "caption") { appendFileSync(join(dir, "captions.jsonl"), `${JSON.stringify({ block: message.block, at: message.at, speaker: message.speaker, text: message.text })}\n`); state.captions += 1; }
    });
    const link = new URL(config.url);
    link.searchParams.set("hl", "en");
    link.searchParams.set("authuser", config.account);
    await page.send("Page.navigate", { url: link.href });
    await page.send("Page.bringToFront").catch(() => {});
    // Before the door: no microphone, no camera, then ask to come in.
    let asked = false, tries = 0;
    const doorBy = Date.now() + 240000;
    while (!asked && Date.now() < doorBy) {
      await sleep(1500);
      if (stopAsked()) return finish("ended", "stopped");
      const seen = await page.evaluate(LOOK).catch(() => null);
      if (!seen) continue;
      if (seen.signIn) return finish("failed", "sign-in");
      if (seen.missing) return finish("failed", "invalid-link");
      if (seen.refused) return finish("failed", "refused");
      if (seen.inCall || seen.waiting) { asked = true; break; }
      if (await press(page, NO_DEVICES)) { await sleep(1200); continue; }
      const guest = await page.evaluate(`Boolean(document.querySelector('input[type="text"][aria-label*="name" i],input[type="text"][aria-label*="nome" i]'))`);
      if (guest) return finish("failed", "sign-in");
      // A desktop has no microphone or camera to send; a switch Meet shows as on is turned off, three tries at most.
      if (tries < 3 && (await has(page, MIC_ON) || await has(page, CAMERA_ON))) { tries += 1; await silence(page); continue; }
      if (!(await has(page, JOIN)) && await has(page, TAKE_OVER) && await press(page, OTHER_WAYS)) { await sleep(1200); if (!(await has(page, BESIDE))) continue; }
      const door = await has(page, BESIDE) ? BESIDE : JOIN;
      if (await has(page, door)) {
        const pressed = await press(page, door);
        log(`door ${pressed}`);
        asked = Boolean(pressed);
        await sleep(2500);
      }
    }
    if (!asked) { log(`door not found: ${JSON.stringify((await page.evaluate(LOOK).catch(() => ({}))).sample || "")}`); return finish("failed", "no-door"); }
    save({ phase: "waiting" });
    const admitBy = Date.now() + Number(config.waitMinutes || 10) * 60000;
    let inside = false;
    while (Date.now() < admitBy) {
      if (stopAsked()) return finish("ended", "stopped");
      const seen = await page.evaluate(LOOK).catch(() => null);
      if (seen?.refused) return finish("failed", "refused");
      if (seen?.inCall) { inside = true; break; }
      save();
      await sleep(2000);
    }
    if (!inside) return finish("failed", "not-admitted");
    const joinedAt = Date.now();
    recorder = spawn("parec", ["--device=cora_meet.monitor", "--format=s16le", "--channels=1", "--rate=16000", "--file-format=flac", audioPath], { env: audioEnv, stdio: "ignore" });
    recorderDone = new Promise((resolve) => { recorder.once("close", resolve); recorder.once("error", resolve); });
    await sleep(400);
    if (recorder.exitCode !== null || !existsSync(audioPath)) throw new Error("Meet audio recorder did not start");
    save({ phase: "joined", joinedAt, recordingAt: joinedAt, audioFile: "audio.flac" });
    await page.evaluate(READ_CAPTIONS);
    log("joined");
    await silence(page);
    await press(page, /^(Got it|Dismiss|Ho capito|Ignora)$/).catch(() => {});
    await captions(page);
    await captionLanguage(page, config.language);
    const endBy = Date.now() + Number(config.maxMinutes || 240) * 60000;
    const aloneMs = Number(config.aloneSeconds || 90) * 1000;
    let aloneSince = 0, company = false, lost = 0, captionsAt = Date.now();
    while (true) {
      await sleep(3000);
      if (stopAsked()) return finish("ended", "stopped");
      if (Date.now() > endBy) return finish("ended", "too-long");
      const seen = await page.evaluate(LOOK).catch(() => null);
      if (!seen) { if (++lost > 5) return finish("ended", "page-lost"); continue; }
      lost = 0;
      if (recorder.exitCode !== null || recorder.signalCode) throw new Error("Meet audio recorder stopped");
      if (seen.ended || !seen.inCall) return finish("ended", "call-over");
      await silence(page);
      if (!seen.captions && Date.now() - captionsAt > 20000) { captionsAt = Date.now(); await captions(page); await captionLanguage(page, config.language); }
      const names = [...new Set([...state.names, ...seen.names])].slice(0, 200);
      save({ people: seen.people, names, audioBytes: existsSync(audioPath) ? statSync(audioPath).size : 0 });
      if (seen.people > 1) { company = true; aloneSince = 0; continue; }
      aloneSince ||= Date.now();
      if (Date.now() - aloneSince > (company ? aloneMs : Number(config.waitMinutes || 10) * 60000)) return finish("ended", company ? "alone" : "nobody-came");
    }
  } catch (error) {
    log(`error ${error.message}`);
    await finish("failed", "error").catch(() => save({ phase: "failed", reason: "error", endedAt: Date.now() }));
  }
}

const [command, argument, extra] = process.argv.slice(2);
const sessionDir = (id) => {
  if (!/^ms_[a-f0-9]{12}$/.test(String(id))) throw new Error("unknown call");
  return join(HOME, "sessions", id);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commands = {
  async signin() {
    const cdp = await connect();
    const page = await openPage(cdp, "https://accounts.google.com/ServiceLogin?hl=en&continue=https://myaccount.google.com/");
    await page.send("Page.bringToFront").catch(() => {});
    cdp.close();
    return { opened: true };
  },
  async account() {
    const running = Boolean(await version());
    const cdp = await connect();
    const who = await account(cdp);
    // A browser started only to look is closed again: the session stays in the profile.
    if (!running && argument !== "keep") await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    return who;
  },
  async signout() {
    const cdp = await connect();
    const page = await openPage(cdp, "https://accounts.google.com/Logout?hl=en", { background: true });
    await sleep(4000);
    await page.close();
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    return { signedOut: true };
  },
  async quit() {
    if (!(await version())) return { running: false };
    const cdp = await connect();
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    return { running: false };
  },
  /** The call runs on its own, apart from whoever started it: Cora may restart while the agent listens. */
  async start() {
    const dir = sessionDir(argument);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), Buffer.from(String(extra || ""), "base64").toString("utf8"));
    JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const child = spawn(process.execPath, [process.argv[1], "run", argument], { detached: true, stdio: "ignore" });
    child.unref();
    return { started: true };
  },
  async run() {
    await run(sessionDir(argument));
    return null;
  },
  async state() {
    const path = join(sessionDir(argument), "state.json");
    if (!existsSync(path)) return { phase: "missing" };
    const state = JSON.parse(readFileSync(path, "utf8"));
    return { ...state, alive: alive(state.pid), now: Date.now() };
  },
  async stop() {
    writeFileSync(join(sessionDir(argument), "stop"), "");
    return { stopping: true };
  },
  async captions() {
    const path = join(sessionDir(argument), "captions.jsonl");
    return { captions: existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-20000).map((line) => JSON.parse(line)) : [] };
  },
  async clean() {
    rmSync(sessionDir(argument), { recursive: true, force: true });
    return { cleaned: true };
  },
};
if (!Object.hasOwn(commands, command)) {
  console.error(`usage: meet <${Object.keys(commands).join("|")}> [call]`);
  process.exit(2);
}
commands[command]().then(
  (result) => { if (result) console.log(JSON.stringify(result)); process.exit(0); },
  (error) => { console.error(error.message); process.exit(1); },
);
