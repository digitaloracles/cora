import { mcpClient } from "./remote-mcp.js";
import { fail, localFile } from "./tooling.js";

const ENDPOINT = "https://earendil.studio/api/mcp";
const PREFIX = "earendil_";
const REMOTE_NAME = /^[a-z][a-z0-9_]{0,60}$/;
const TOOL_NAME = /^earendil_[a-z][a-z0-9_]{0,60}$/;
const TIMEOUT = 300000;
const FIT = 36000;

function refusal(status, data) {
  const detail = String(data?.error?.message || data?.error || data?.message || "").slice(0, 600);
  if (status === 401) fail("Eärendil studio refused the agent key (revoked or expired): the owner reconnects it in Connettori");
  if (status === 402) fail("Eärendil studio needs an active subscription on the key's account; do not retry automatically");
  if (status === 429) fail(`Eärendil studio rate limit reached${detail ? `: ${detail}` : ""}; do not retry automatically`);
  fail(`Eärendil studio answered ${status || "nothing"}${detail ? `: ${detail}` : ""}`);
}

export function client({ token = "", request, api = {}, writeFile = null }) {
  return mcpClient({ name: "Eärendil studio", id: "earendil", endpoint: api.earendil || ENDPOINT, request, writeFile, refusal,
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** The remote tool names, longest first, so descriptions can name the Cora tools instead. */
const renamer = (names) => {
  const multi = names.filter((name) => name.includes("_")).sort((a, b) => b.length - a.length);
  if (!multi.length) return (text) => text;
  const pattern = new RegExp(`(?<![a-z0-9_])(${multi.join("|")})(?![a-z0-9_])`, "g");
  return (text) => String(text).replace(pattern, `${PREFIX}$1`);
};

const renameDescriptions = (value, rename) => {
  if (Array.isArray(value)) return value.map((item) => renameDescriptions(item, rename));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "description" && typeof item === "string" ? rename(item) : renameDescriptions(item, rename)]));
};

/** Reads the studio's tool catalog with the key: a wrong, revoked or unpaid key is refused here. */
export async function inspect(ctx) {
  const remote = client(ctx), tools = [], seen = new Set();
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await remote.rpc("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(result.tools)) fail("Eärendil studio did not return its tool catalog");
    for (const tool of result.tools) {
      if (!REMOTE_NAME.test(tool?.name || "") || tools.some((item) => item.name === tool.name)) continue;
      if (!tool.inputSchema || tool.inputSchema.type !== "object") fail("Eärendil studio returned an invalid tool schema");
      tools.push({ name: tool.name, description: String(tool.description || "").slice(0, 6000), parameters: tool.inputSchema,
        ...(tool.annotations?.destructiveHint ? { destructive: true } : {}) });
      if (tools.length > 200) fail("Eärendil studio returned too many tools");
    }
    cursor = result.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor) || page === 19) fail("Eärendil studio repeated or exceeded catalog pagination");
    seen.add(cursor);
  }
  if (!tools.length || JSON.stringify(tools).length > 500000) fail("Eärendil studio returned an empty or oversized tool catalog");
  const server = remote.server() || {};
  return { workspace: String(server.serverInfo?.title || "Eärendil studio").slice(0, 120), account: "", version: String(server.serverInfo?.version || "").slice(0, 60),
    instructions: String(server.instructions || "").slice(0, 4000), remoteTools: tools };
}

/** A long answer (a whole transcript) goes whole into a file on the agent's computer; the agent reads the short fields inline. */
async function fit(data, name, ctx) {
  const whole = JSON.stringify(data ?? null);
  if (whole.length <= FIT || !ctx.writeFile || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const path = `/home/agent/work/earendil/${name}-${Date.now()}.json`;
  try { await ctx.writeFile(path, Buffer.from(whole)); } catch { return data; }
  const short = {};
  for (const [key, value] of Object.entries(data)) {
    const size = JSON.stringify(value ?? null).length;
    short[key] = size <= 2000 ? value : `[${size} characters: in full_answer]`;
  }
  return { ...short, full_answer: path, note: "The whole answer is in full_answer on your computer: read the fields you need from it." };
}

export function resolveTool(name) {
  if (!TOOL_NAME.test(name)) return null;
  const remoteName = name.slice(PREFIX.length);
  return { name, summarize: (args = {}) => [remoteName, args.project_id && `project ${String(args.project_id).slice(0, 60)}`].filter(Boolean).join(" · "),
    async run(args, ctx) {
      if (!ctx.record.remoteTools?.some((tool) => tool.name === remoteName)) fail("This Eärendil studio tool is unavailable on the connected account: the owner reconnects it in Connettori to refresh the catalog");
      let input = { ...(args || {}) };
      if (remoteName === "video_add_picture" && input.path) {
        if (input.url || input.data) fail("give one of path, url or data");
        const file = await localFile({ path: input.path }, ctx, { max: 12 * 1024 * 1024 });
        if (!/^image\/(png|jpeg|webp)$/.test(file.contentType)) fail("the picture must be PNG, JPEG or WebP");
        const { path: _path, ...rest } = input;
        input = { ...rest, data: file.bytes.toString("base64"), ...(rest.name ? {} : { name: file.filename.replace(/\.[^.]+$/, "") }) };
      }
      return fit(await client(ctx).tool(remoteName, input, { timeout: TIMEOUT }), remoteName, ctx);
    } };
}

export const earendil = {
  id: "earendil", name: "Eärendil studio", secret: "CORA_EARENDIL_KEY", appSecrets: [], label: "account",
  checkKey: (ctx) => inspect({ ...ctx, record: { mode: "key" } }),
  resolveTool,
  toolsFor(record) {
    const remote = (record.remoteTools || []).filter((tool) => REMOTE_NAME.test(tool.name));
    const rename = renamer(remote.map((tool) => tool.name));
    return remote.map((tool) => {
      const parameters = renameDescriptions(tool.parameters, rename);
      if (tool.name === "video_add_picture" && parameters.properties) {
        parameters.properties = { ...parameters.properties, path: { type: "string", description: "absolute path of a PNG, JPEG or WebP on your computer (at most 12 MB), instead of url or data" } };
      }
      const intro = tool.name === "list_projects" && record.instructions ? ` How the studio works: ${rename(record.instructions)}` : "";
      const media = ["listen", "view_waveform"].includes(tool.name) || tool.name.startsWith("video_") ? " Audio and pictures it returns are saved on your computer under /home/agent/work/earendil/." : "";
      const final = tool.destructive ? " Deletes for good: only on an explicit user request." : "";
      return { name: `${PREFIX}${tool.name}`, description: `Eärendil studio, as the account that made the agent key. ${rename(tool.description)}${intro}${media}${final}`, parameters };
    });
  },
  card: {
    icon: "mic", description: "Gli agenti generano voci, montano l'audio sulla timeline e preparano video in Eärendil studio.", meta: "Eärendil studio · Voce e video",
    intro: "Gli agenti lavorano nei progetti del tuo account Eärendil studio, con il tuo abbonamento: generano il parlato, lo ascoltano, lo correggono sulla timeline ed esportano il mix. Con la modalità Agente accesa nello studio vedi e senti il loro lavoro dal vivo.",
    writes: { key: "L'account Eärendil studio che ha creato la chiave agente." },
    modes: [
      { id: "key", label: "Chiave agente", body: { mode: "key" },
        intro: "Collega una chiave agente del tuo account Eärendil studio. Cora la verifica e la conserva nella cassaforte.",
        notice: "Scollegare la chiave da Cora toglie l'accesso agli agenti. Per revocarla anche nello studio, eliminala da Agente → Collega → Chiave agente.",
        rows: [{ title: "La chiave", steps: [["Apri ", { href: "https://earendil.studio", text: "Eärendil studio" }, ", vai su Agente → Collega → Chiave agente, creane una e inseriscila qui."]],
          field: { name: "token", type: "password", label: "Chiave agente di Eärendil studio", placeholder: "earendil_…" }, submit: "Verifica e collega" }] },
    ],
  },
};
