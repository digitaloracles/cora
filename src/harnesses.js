import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The subscription CLIs an agent can run on, one entry each, so the store, the
 * accounts and the runs never list them again. `homeVar` moves the CLI's own
 * folder, and with it the login, into an account's folder; `loginHosts` are the
 * only pages a login may send the owner to.
 */
export const HARNESSES = {
  claude: {
    label: "Claude",
    product: "Claude Code",
    homeVar: "CLAUDE_CONFIG_DIR",
    resident: () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    loginHosts: ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"],
  },
  codex: {
    label: "ChatGPT",
    product: "Codex",
    homeVar: "CODEX_HOME",
    resident: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
    loginHosts: ["auth.openai.com", "chatgpt.com"],
  },
  grok: {
    label: "Grok",
    product: "Grok Build",
    homeVar: "GROK_HOME",
    resident: () => process.env.GROK_HOME || join(homedir(), ".grok"),
    loginHosts: ["accounts.x.ai"],
    // The device page carries the code it asks the owner to confirm.
    deviceParam: "user_code",
  },
  muse: {
    label: "Meta",
    product: "Muse Code",
    homeVar: "XDG_CONFIG_HOME",
    resident: () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    loginHosts: ["auth.meta.com"],
    deviceParam: "code",
  },
  kimi: {
    label: "Kimi",
    product: "Kimi Code",
    homeVar: "KIMI_CODE_HOME",
    resident: () => process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"),
    // kimi.com is the region Cora signs in with; kimi.ai is the same service's global mirror.
    loginHosts: ["www.kimi.com", "kimi.com", "www.kimi.ai", "kimi.ai"],
    deviceParam: "user_code",
  },
  pi: {
    label: "Pi",
    product: "Pi",
    homeVar: "PI_CODING_AGENT_DIR",
    resident: () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    // Pi signs in to the service it runs on: Claude's code page or ChatGPT's device page.
    loginHosts: ["claude.ai", "claude.com", "platform.claude.com", "auth.openai.com"],
    managedOnly: true,
  },
  gemini: {
    label: "Gemini",
    product: "Antigravity CLI",
    homeVar: "HOME",
    resident: () => homedir(),
    managedOnly: true,
    loginHosts: ["accounts.google.com", "antigravity.google", "antigravity.google.com"],
  },
};

export const SUBSCRIPTION_PROVIDERS = Object.keys(HARNESSES);

/** The subscriptions Pi signs in to by itself, and how Cora names them. */
export const PI_SERVICES = {
  anthropic: { label: "Claude", manualCode: true },
  "openai-codex": { label: "ChatGPT", manualCode: false },
};

/** The ends Pi reaches with a key instead of an account: the person's own or the space's. */
export const PI_KEY_ENDS = ["deepseek", "ollama"];

/**
 * The account a model id runs on. A subscription CLI runs on its own (`kimi/…`); Hermes and Pi
 * reach Kimi's subscription through a Kimi Code account (`hermes/kimi/…`, `pi/kimi/…`); Pi's
 * own logins are Pi accounts (`pi/anthropic/…`). Empty: no account, a key or the machine.
 */
export function subscriptionProviderOf(model) {
  const parts = String(model || "").split("/");
  if (Object.hasOwn(HARNESSES, parts[0]) && parts[0] !== "pi") return parts.length > 1 ? parts[0] : "";
  if (parts.length < 3) return "";
  if ((parts[0] === "hermes" || parts[0] === "pi") && parts[1] === "kimi") return "kimi";
  if (parts[0] === "pi" && Object.hasOwn(PI_SERVICES, parts[1])) return "pi";
  return "";
}

/**
 * Where Codex keeps the login. The server's own account lives in the machine's
 * keyring, an agent's account in its isolated folder: the check, the login and
 * the turn must read the same store or the account looks disconnected.
 */
export function codexCredentialStore(resident) {
  return `cli_auth_credentials_store="${resident ? "auto" : "file"}"`;
}

export function isSubscriptionProvider(provider) {
  return Object.hasOwn(HARNESSES, provider);
}
