#!/usr/bin/env node
// One custom agent preview space (NOT-94): a Cora of its own for one company, sealed agents only,
// open for a fixed time from the company's first message. The preview pipeline writes spec.json
// and starts it through hush:
//   hush run --name <SESSION KEY> --env CORA_SESSION_KEY --redact -- \
//   hush run --name <OLLAMA KEY> --env CORA_OLLAMA_API_KEY --redact -- node bin/preview-space.mjs <dir>/spec.json
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCora } from "../src/main.js";
import { Store } from "../src/store.js";
import { PREVIEW_GUESTS_KEY, previewGuestId } from "../src/preview.js";

const here = dirname(fileURLToPath(import.meta.url));

export function readSpec(file) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(String(spec.slug || ""))) throw new Error("bad slug");
  if (!(Number(spec.port) >= 1024 && Number(spec.port) < 65536)) throw new Error("bad port");
  if (!spec.home || !Array.isArray(spec.agents) || !spec.agents.length || !Array.isArray(spec.guests) || !spec.guests.length) throw new Error("incomplete spec");
  return spec;
}

/** Guests, access and sealed agents, idempotent: a restart leaves the same space. */
export function seedPreview(store, spec) {
  const guests = spec.guests.map((guest) => ({ email: String(guest.email).trim().toLowerCase(), name: String(guest.name || ""), tokenHash: String(guest.tokenHash), expiresAt: Number(guest.expiresAt) || null }));
  store.updateSettings({ defaultModel: spec.model, useResidentSubscriptions: false, language: spec.lang === "it" ? "it" : "en", transports: [], goalMode: false });
  store.updateAccessPolicy({ domains: [], emails: guests.map((guest) => guest.email) });
  store.setValue(PREVIEW_GUESTS_KEY, guests);
  const ids = guests.map((guest) => store.registerPanelUser({ id: previewGuestId(guest.email), name: guest.name || guest.email, email: guest.email, avatar: "", role: "member", emailVerified: true, source: "local" }).id);
  for (const input of spec.agents) {
    const fields = {
      name: input.name, personality: input.personality, color: input.color || "#264cd6", gender: input.gender || "", model: spec.model,
      sealed: true, tools: false, enabled: true, brainSource: "internal", brainOwnerId: ids[0], coOwnerIds: ids.slice(1), channelIds: [],
    };
    const existing = store.agents().find((agent) => agent.name.toLowerCase() === String(input.name).toLowerCase());
    if (existing) store.updateAgent(existing.id, fields);
    else store.createAgent(fields);
  }
  return ids;
}

async function main() {
  const file = resolve(process.argv[2] || "");
  const spec = readSpec(file);
  if (!process.env.CORA_SESSION_KEY) throw new Error("the session key must be injected through hush");
  const busy = await new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: spec.port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    setTimeout(() => { socket.destroy(); done(false); }, 2000).unref();
  });
  if (busy) { console.error(`port ${spec.port} is taken; this launch exits`); process.exit(0); }
  const seed = new Store(spec.home);
  seed.updateSettings({ defaultModel: spec.model, useResidentSubscriptions: false, transports: [] });
  seed.close();
  const off = "/usr/bin/false";
  const app = startCora({
    home: spec.home, host: "127.0.0.1", port: spec.port, publicHost: `${spec.slug}.usecora.space`, publicUrl: `https://${spec.slug}.usecora.space`,
    cloudUrl: "", cloudKey: "", cloudSpace: spec.slug, previewMinutes: Number(spec.minutes) || 60, ownerMemory: false, brainDatabaseUrl: "",
    discordToken: "", telegramToken: "", slackToken: "", slackAppToken: "", slackConfigToken: "", mailRegistrationToken: "", mailDomain: "", mailNamespace: "",
    ollamaKey: process.env.CORA_OLLAMA_API_KEY || "", orcaKey: "", sonioxKey: "", deepseekKey: "", typesafeKey: "", vapidKey: "", adminPassword: "",
    googleConnectorEnabled: false, docker: off, sshAuthorizedKeys: "/nonexistent/preview-authorized-keys",
    codexBin: off, claudeBin: off, grokBin: off, museBin: off, geminiBin: off, kimiBin: off, piBin: off, hermesBin: off, deepseekBin: off, hushBin: off,
    ownerInstructions: spec.instructions || join(here, "..", "deploy", "preview", "AGENTS.md"),
  });
  await app.ready;
  seedPreview(app.store, spec);
  writeFileSync(join(dirname(file), "runtime.json"), `${JSON.stringify({ ready: true, slug: spec.slug, port: spec.port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`preview ${spec.slug} ready on 127.0.0.1:${spec.port}`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; app.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`preview space could not start: ${error.message}`); process.exit(1); });
