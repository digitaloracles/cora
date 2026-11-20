import { mcpClient } from "./remote-mcp.js";
import { fail } from "./tooling.js";

const ENDPOINT = "https://mcp.higgsfield.ai/mcp";
const ISSUER = "https://higgsfield.ai/_clerk";
const PREFIX = "higgsfield_";
const REMOTE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;
const TOOL_NAME = /^higgsfield_[a-z0-9][a-z0-9_]{0,80}$/;
const TIMEOUT = 300000;
const FIT = 36000;
/** The tools an agent sees whole; Higgsfield's other ones (over 200, about 640 KB of schemas) go through the gateway. */
const CORE = ["models_explore", "get_preset_instructions", "generate_image", "generate_video", "generate_audio", "job_status", "jobs_wait",
  "show_generations", "media_upload", "media_import_url", "media_confirm", "balance", "list_voices"];
const INFO = `${PREFIX}tool_info`, CALL = `${PREFIX}call`;
const GATEWAY = new Set([INFO, CALL]);

function refusal(status, data) {
  const detail = String(data?.error?.message || data?.error || data?.message || "").slice(0, 600);
  if (status === 401) fail("Higgsfield refused the sign-in (expired or revoked): the owner reconnects it in Connettori");
  if (status === 402) fail(`Higgsfield has not enough credits on the connected account${detail ? `: ${detail}` : ""}; do not retry automatically`);
  if (status === 429) fail(`Higgsfield rate limit reached${detail ? `: ${detail}` : ""}; do not retry automatically`);
  fail(`Higgsfield answered ${status || "nothing"}${detail ? `: ${detail}` : ""}`);
}

export function client({ token = "", request, api = {}, writeFile = null }) {
  return mcpClient({ name: "Higgsfield", id: "higgsfield", endpoint: api.higgsfield || ENDPOINT, request, writeFile, refusal,
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** The Cora name of a remote tool: lower case, one higgsfield_ prefix. */
export const coraName = (remote) => `${PREFIX}${String(remote).replace(/^higgsfield[_.-]/i, "").toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;

const renamer = (names) => {
  const multi = names.filter((name) => /[_.-]/.test(name)).sort((a, b) => b.length - a.length).map((name) => name.replace(/[.-]/g, "\\$&"));
  if (!multi.length) return (text) => String(text);
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${multi.join("|")})(?![A-Za-z0-9_])`, "g");
  return (text) => String(text).replace(pattern, (match) => coraName(match));
};

const renameDescriptions = (value, rename) => {
  if (Array.isArray(value)) return value.map((item) => renameDescriptions(item, rename));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "description" && typeof item === "string" ? rename(item) : renameDescriptions(item, rename)]));
};

/** Reads Higgsfield's tool catalog with the account's token. */
export async function inspect(ctx) {
  const remote = client(ctx), tools = [], seen = new Set(), names = new Set();
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await remote.rpc("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(result.tools)) fail("Higgsfield did not return its tool catalog");
    for (const tool of result.tools) {
      if (!REMOTE_NAME.test(tool?.name || "") || names.has(coraName(tool.name)) || GATEWAY.has(coraName(tool.name))) continue;
      if (!tool.inputSchema || tool.inputSchema.type !== "object") fail("Higgsfield returned an invalid tool schema");
      names.add(coraName(tool.name));
      tools.push({ name: tool.name, description: String(tool.description || "").slice(0, 6000), parameters: tool.inputSchema,
        ...(tool.annotations?.destructiveHint ? { destructive: true } : {}), ...(tool.annotations?.readOnlyHint ? { readOnly: true } : {}) });
      if (tools.length > 400) fail("Higgsfield returned too many tools");
    }
    cursor = result.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor) || page === 19) fail("Higgsfield repeated or exceeded catalog pagination");
    seen.add(cursor);
  }
  if (!tools.length || JSON.stringify(tools).length > 500000) fail("Higgsfield returned an empty or oversized tool catalog");
  const server = remote.server() || {};
  return { workspace: String(server.serverInfo?.title || server.serverInfo?.name || "Higgsfield").slice(0, 120), account: "", version: String(server.serverInfo?.version || "").slice(0, 60),
    instructions: String(server.instructions || "").slice(0, 4000), remoteTools: tools };
}

/** The account's e-mail from the OpenID id_token the token endpoint answered (shown in the card only). */
function accountOf(tokenData) {
  try {
    const claims = JSON.parse(Buffer.from(String(tokenData?.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
    return String(claims.email || claims.preferred_username || claims.name || "").slice(0, 120);
  } catch { return ""; }
}

/** A long answer goes whole into a file on the agent's computer; the agent reads the short fields inline. */
async function fit(data, name, ctx) {
  const whole = JSON.stringify(data ?? null);
  if (whole.length <= FIT || !ctx.writeFile || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const path = `/home/agent/work/higgsfield/${name}-${Date.now()}.json`;
  try { await ctx.writeFile(path, Buffer.from(whole)); } catch { return data; }
  const short = {};
  for (const [key, value] of Object.entries(data)) {
    const size = JSON.stringify(value ?? null).length;
    short[key] = size <= 2000 ? value : `[${size} characters: in full_answer]`;
  }
  return { ...short, full_answer: path, note: "The whole answer is in full_answer on your computer: read the fields you need from it." };
}

const core = (record) => (record.remoteTools || []).filter((tool) => REMOTE_NAME.test(tool.name) && CORE.includes(coraName(tool.name).slice(PREFIX.length)));
const others = (record) => (record.remoteTools || []).filter((tool) => REMOTE_NAME.test(tool.name) && !CORE.includes(coraName(tool.name).slice(PREFIX.length)));
const findRemote = (record, name) => {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return null;
  return (record.remoteTools || []).find((tool) => tool.name.toLowerCase() === wanted || coraName(tool.name) === wanted || coraName(tool.name) === `${PREFIX}${wanted}`) || null;
};
const unavailable = () => fail("This Higgsfield tool is unavailable on the connected account: higgsfield_tool_info lists the names; the owner reconnects Higgsfield in Connettori to refresh the catalog");
const runRemote = async (remote, args, ctx) => fit(await client(ctx).tool(remote.name, args || {}, { timeout: TIMEOUT }), coraName(remote.name).slice(PREFIX.length), ctx);

export function resolveTool(name) {
  if (name === INFO) return { name, summarize: (args) => `tool_info ${String(args?.name || "").slice(0, 80)}`.trim(),
    async run(args, ctx) {
      const rename = renamer(core(ctx.record).map((tool) => tool.name));
      if (!args?.name) return { tools: others(ctx.record).map((tool) => ({ name: tool.name, ...(tool.readOnly ? { readOnly: true } : {}), ...(tool.destructive ? { destructive: true } : {}) })),
        note: `Call ${INFO} with one name for its description and parameters, then ${CALL}.` };
      const remote = findRemote(ctx.record, args.name);
      if (!remote) unavailable();
      return { name: remote.name, description: rename(remote.description), parameters: remote.parameters,
        ...(remote.readOnly ? { readOnly: true } : { spends: "May spend the account's credits: stay within the user's request." }),
        ...(remote.destructive ? { destructive: "Deletes for good: only on an explicit user request." } : {}),
        how: `Run it with ${CALL} { name: "${remote.name}", arguments: {...} }.` };
    } };
  if (name === CALL) return { name, summarize: (args) => String(args?.name || "call").slice(0, 80),
    async run(args, ctx) {
      const remote = findRemote(ctx.record, args?.name);
      if (!remote) unavailable();
      const given = args?.arguments ?? {};
      if (typeof given !== "object" || Array.isArray(given)) fail("arguments must be an object with the tool's parameters");
      return runRemote(remote, given, ctx);
    } };
  if (!TOOL_NAME.test(name)) return null;
  return { name, summarize: () => name.slice(PREFIX.length),
    async run(args, ctx) {
      const remote = ctx.record.remoteTools?.find((tool) => coraName(tool.name) === name);
      if (!remote) unavailable();
      return runRemote(remote, args, ctx);
    } };
}

export const higgsfield = {
  id: "higgsfield", name: "Higgsfield", secret: "CORA_HIGGSFIELD_TOKEN", appSecrets: [], label: "account",
  resolveTool,
  toolsFor(record) {
    const direct = core(record), rest = others(record);
    const rename = renamer(direct.map((tool) => tool.name));
    const exposed = direct.map((tool, index) => {
      const intro = index === 0 && record.instructions ? ` How Higgsfield works: ${rename(record.instructions)}` : "";
      const paid = tool.readOnly ? "" : " May spend the account's credits: stay within the user's request.";
      const final = tool.destructive ? " Deletes for good: only on an explicit user request." : "";
      return { name: coraName(tool.name), description: `Higgsfield, as the connected account. ${rename(tool.description)}${intro}${paid}${final} Pictures it returns are saved on your computer under /home/agent/work/higgsfield/.`,
        parameters: renameDescriptions(tool.parameters, rename) };
    });
    if (!rest.length) return exposed;
    const names = rest.map((tool) => tool.name).join(", ");
    return exposed.concat([
      { name: INFO, description: `Higgsfield, as the connected account: the description and parameters of one of its other tools, those named without the higgsfield_ prefix (${names}). Without name it lists them with readOnly and destructive.`,
        parameters: { type: "object", properties: { name: { type: "string", description: "the tool's name as Higgsfield spells it, e.g. upscale_image" } }, additionalProperties: false } },
      { name: CALL, description: `Higgsfield, as the connected account: runs one of its other tools by name, after ${INFO} gave you its parameters. Tools that are not read-only may spend the account's credits; destructive ones only on an explicit user request. Pictures it returns are saved on your computer under /home/agent/work/higgsfield/.`,
        parameters: { type: "object", properties: { name: { type: "string", description: "the tool's name as Higgsfield spells it" }, arguments: { type: "object", description: "its parameters, as tool_info described them" } }, required: ["name"], additionalProperties: false } },
    ]);
  },
  oauth: {
    authorize: `${ISSUER}/oauth/authorize`,
    token: `${ISSUER}/oauth/token`,
    register: `${ISSUER}/oauth/register`,
    revoke: `${ISSUER}/oauth/token/revoke`,
    dynamicRegistration: true,
    scopes: ["openid", "email", "offline_access"], clientAuth: "none",
    params: { resource: ENDPOINT }, tokenParams: { resource: ENDPOINT },
    async identify(ctx) {
      const checked = await inspect({ ...ctx, token: ctx.access, record: { mode: "oauth" } });
      return { ...checked, account: accountOf(ctx.tokenData) };
    },
  },
  card: {
    icon: "spark", description: "Gli agenti generano immagini e video con i modelli di Higgsfield.", meta: "Higgsfield · Immagini e video",
    intro: "Gli agenti usano Higgsfield con il piano e i crediti dell'account che colleghi. Gli strumenti disponibili li decide Higgsfield e dipendono dal tuo account.",
    writes: { oauth: "L'account Higgsfield con cui accedi durante il collegamento." },
    modes: [
      { id: "oauth", label: "Collega account", intro: "Accedi a Higgsfield e autorizza Cora. Torni qui automaticamente.",
        notice: "Immagini e video usano i crediti del tuo account Higgsfield. Scollegare da Cora revoca anche l'accesso su Higgsfield.",
        rows: [{ title: "Il tuo account Higgsfield", authorize: "Apri Higgsfield" }] },
    ],
  },
};
