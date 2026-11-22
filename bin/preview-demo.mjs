#!/usr/bin/env node
// The demo space (NOT-94): demo.usecora.space on its own small VM, DeepSeek only. Each company that asks
// for a preview gets sealed agents here, a personal link by email and one hour from its first message.
// Secrets come from hush (deploy/preview/README.md): CORA_SESSION_KEY, DEEPSEEK_API_KEY,
// CORA_PREVIEW_PIPELINE_TOKEN, RESEND_API_KEY.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCora } from "../src/main.js";
import { answerLeftovers, startDraftDoor, startPreviewPipeline } from "../src/preview-demo.js";
import { Store } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const HOME = env.CORA_HOME || join(homedir(), ".cora-demo");
const PORT = Number(env.CORA_PORT || 4370);
const HOST = env.CORA_PUBLIC_HOST || "demo.usecora.space";
const MODEL = env.CORA_PREVIEW_MODEL || "deepseek/deepseek-flash";
const MINUTES = Number(env.CORA_PREVIEW_MINUTES || 60);
const DEEPSEEK_API = (env.CORA_DEEPSEEK_API || "https://api.deepseek.com").replace(/\/$/, "");

async function chat(messages) {
  const response = await fetch(`${DEEPSEEK_API}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.CORA_PREVIEW_BRIEF_MODEL || "deepseek-chat", messages, response_format: { type: "json_object" } }), signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`briefing model answered ${response.status}`);
  return (await response.json()).choices?.[0]?.message?.content || "";
}

async function mail({ to, subject, text, html }) {
  const response = await fetch(`${(env.CORA_RESEND_API || "https://api.resend.com").replace(/\/$/, "")}/emails`, {
    method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.CORA_PREVIEW_MAIL_FROM || "Cora <cora@usecora.space>", to: [to], subject, text, html }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`mail provider answered ${response.status}`);
}

async function main() {
  for (const name of ["CORA_SESSION_KEY", "DEEPSEEK_API_KEY"]) if (!env[name]) throw new Error(`${name} must be injected through hush`);
  const seed = new Store(HOME);
  seed.updateSettings({ defaultModel: MODEL, useResidentSubscriptions: false, language: "en", transports: [], goalMode: false });
  seed.close();
  const off = "/usr/bin/false";
  const app = startCora({
    home: HOME, host: "127.0.0.1", port: PORT, publicHost: HOST, publicUrl: `https://${HOST}`,
    cloudUrl: "", cloudKey: "", cloudSpace: "demo", previewMinutes: MINUTES, ownerMemory: true, brainDatabaseUrl: "",
    discordToken: "", telegramToken: "", slackToken: "", slackAppToken: "", slackConfigToken: "", mailRegistrationToken: "", mailDomain: "", mailNamespace: "",
    ollamaKey: "", orcaKey: "", sonioxKey: "", deepseekKey: env.DEEPSEEK_API_KEY, deepseekBin: env.CORA_DSH_BIN || "dsh", typesafeKey: "", vapidKey: "", adminPassword: "",
    googleConnectorEnabled: false, docker: off, sshAuthorizedKeys: "/nonexistent/demo-authorized-keys",
    codexBin: off, claudeBin: off, grokBin: off, museBin: off, geminiBin: off, kimiBin: off, piBin: off, hermesBin: off, hushBin: off,
    ownerInstructions: env.CORA_OWNER_INSTRUCTIONS || join(here, "..", "deploy", "preview", "AGENTS.md"),
  });
  await app.ready;
  console.log(`demo space on 127.0.0.1:${PORT} as ${HOST}`);
  const leftovers = answerLeftovers(app, { minutes: MINUTES });
  if (leftovers.length) console.log(JSON.stringify({ at: new Date().toISOString(), type: "preview-resumed", rooms: leftovers.length }));
  let pipeline = null;
  const door = env.CORA_PREVIEW_PIPELINE_TOKEN ? startDraftDoor({ token: env.CORA_PREVIEW_PIPELINE_TOKEN, chat, port: Number(env.CORA_PREVIEW_DRAFT_PORT || 4371), log: (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })) }) : null;
  if (env.CORA_PREVIEW_PIPELINE_TOKEN && env.RESEND_API_KEY) {
    pipeline = startPreviewPipeline(app, { cloudUrl: env.CORA_PREVIEW_CLOUD_URL || "https://usecora.space", token: env.CORA_PREVIEW_PIPELINE_TOKEN, space: "demo", base: `https://${HOST}`, model: MODEL, minutes: MINUTES, chat, mail });
  } else console.log("preview pipeline off: CORA_PREVIEW_PIPELINE_TOKEN or RESEND_API_KEY missing");
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; pipeline?.stop(); door?.close(); app.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`demo space could not start: ${error.message}`); process.exit(1); });
