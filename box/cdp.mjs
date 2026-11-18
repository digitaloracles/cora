#!/usr/bin/env node
// Talk to the Chromium the owner can see, over its debugging port: the same window,
// the same session, no automation flags. Pixels come from the computer tool; this is
// for what pixels cannot say — the DOM, the page's own data, where the requests went.
// Cookie values and storage values are never printed: a session is not evidence.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.CORA_CDP_PORT || "9222";
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 60000;

const [action, ...rest] = process.argv.slice(2);
const argument = rest.join(" ");

async function targets({ browserMayBeClosed = false } = {}) {
  const response = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) }).catch((error) => {
    if (browserMayBeClosed && error.cause?.code === "ECONNREFUSED") return null;
    throw error;
  });
  if (!response) return [];
  if (!response.ok) throw new Error(`chromium is not listening on ${PORT}`);
  return (await response.json()).filter((target) => target.type === "page");
}

/** The page in front, or the one whose url was asked for. */
async function page(match = "") {
  const pages = await targets();
  if (!pages.length) throw new Error("no page open");
  const wanted = match ? pages.find((target) => target.url.includes(match)) : null;
  return wanted || pages[0];
}

function send(target, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${method}: timeout`)); }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      let payload;
      try { payload = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); } catch { return; }
      if (payload.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (payload.error) reject(new Error(`${method}: ${payload.error.message}`));
      else resolve(payload.result);
    });
    socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error(method + ": browser disconnected")); });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${method}: cannot reach the page`)); });
  });
}

async function browserEndpoint() {
  const response = await fetch(BASE + "/json/version", { signal: AbortSignal.timeout(1000) }).catch((error) => {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw error;
  });
  if (!response) return null;
  if (!response.ok) throw new Error("chromium debugging endpoint failed on " + PORT);
  return response.json();
}

async function startBrowser() {
  const existing = await browserEndpoint();
  if (existing) return existing;
  const chromium = spawn("chromium", ["about:blank"], { detached: true, stdio: "ignore" });
  let failure;
  chromium.on("error", (error) => { failure = error; });
  chromium.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(250);
    if (failure) throw failure;
    const endpoint = await browserEndpoint();
    if (endpoint) return endpoint;
  }
  throw new Error("chromium is not listening on " + PORT);
}

async function closeTabs(ids) {
  const options = { browserMayBeClosed: true };
  const pages = (await targets(options)).filter((target) => ids.has(target.id));
  if (!pages.length) return 0;
  // Page.close lets Chromium protect unsaved changes with its normal beforeunload dialog.
  await Promise.allSettled(pages.map((target) => send(target, "Page.close", {}, 2000)));
  let remaining;
  for (let attempt = 0; attempt < 8; attempt++) {
    remaining = (await targets(options)).filter((target) => ids.has(target.id)).length;
    if (!remaining) break;
    await delay(125);
  }
  return remaining;
}

async function evaluate(target, expression) {
  const result = await send(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "the page refused the script");
  return result.result?.value;
}

const cut = (text) => String(text ?? "").slice(0, LIMIT);

const actions = {
  async targets() {
    return (await targets()).map((target) => ({ id: target.id, title: target.title, url: target.url }));
  },
  async open() {
    const url = new URL(argument);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must start with http:// or https://");
    const { targetId } = await send(await startBrowser(), "Target.createTarget", { url: url.href });
    return { id: targetId, url: argument };
  },
  async close() {
    return { closed: await closeTabs(new Set([argument])) === 0 };
  },
  async cleanup() {
    return { remaining: await closeTabs(new Set(JSON.parse(argument))) };
  },
  async text() {
    const target = await page();
    return {
      url: target.url,
      title: target.title,
      text: cut(await evaluate(target, "document.body ? document.body.innerText : ''")),
    };
  },
  async html() {
    const target = await page();
    const selector = argument || "body";
    return { url: target.url, selector, html: cut(await evaluate(target, `(document.querySelector(${JSON.stringify(selector)}) || {}).outerHTML || ''`)) };
  },
  async query() {
    const target = await page();
    return {
      url: target.url,
      matches: await evaluate(target, `[...document.querySelectorAll(${JSON.stringify(argument)})].slice(0, 50).map((node) => ({
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.value || "").slice(0, 300),
        id: node.id || undefined,
        name: node.getAttribute("name") || undefined,
        href: node.getAttribute("href") || undefined,
      }))`),
    };
  },
  async eval() {
    const target = await page();
    return { url: target.url, value: await evaluate(target, argument) };
  },
  /** Which sessions this browser holds: names and scope, never the values. */
  async cookies() {
    const target = await page();
    const { cookies } = await send(target, "Network.getAllCookies");
    return {
      count: cookies.length,
      cookies: cookies.slice(0, 200).map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        session: cookie.session,
        expires: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null,
        size: cookie.value.length,
      })),
    };
  },
  async storage() {
    const target = await page();
    return {
      url: target.url,
      local: await evaluate(target, "Object.entries(localStorage).slice(0, 100).map(([k, v]) => ({ key: k, size: String(v).length }))"),
      session: await evaluate(target, "Object.entries(sessionStorage).slice(0, 100).map(([k, v]) => ({ key: k, size: String(v).length }))"),
    };
  },
  /** What the page actually fetched, from its own performance log. */
  async network() {
    const target = await page();
    return {
      url: target.url,
      requests: await evaluate(target, `performance.getEntriesByType("resource").slice(-60).map((entry) => ({
        url: entry.name.slice(0, 300),
        kind: entry.initiatorType,
        ms: Math.round(entry.duration),
        bytes: entry.transferSize || 0,
      }))`),
    };
  },
  async goto() {
    const target = await page();
    await send(target, "Page.navigate", { url: argument });
    return { url: argument, navigating: true };
  },
};

const run = actions[action];
if (!run) {
  console.error(`usage: cora-cdp <${Object.keys(actions).join("|")}> [argument]`);
  process.exit(2);
}
run().then(
  (result) => console.log(JSON.stringify(result)),
  (error) => { console.error(error.message); process.exit(1); },
);
