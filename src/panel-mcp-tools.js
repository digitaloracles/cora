/**
 * The panel MCP's tools: one per panel action, each with its own input schema. Every
 * tool calls the same native panel route the browser calls, as the person who owns the
 * MCP access, so roles, private ownership and explicit grants stay exactly the panel's.
 */

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const list = (description, items = { type: "string" }, extra = {}) => ({ type: "array", items, description, ...extra });
const obj = (description, properties = {}, extra = {}) => ({ type: "object", description, properties, ...extra });

const AGENT = { agent_id: str("Agent id (ag_…), from cora_agents_list.", { pattern: "^[\\w-]+$" }) };
const SKILL = { skill: str("Installed skill name, from cora_agent_skills_list.", { pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }) };
const ROUTINE = { routine_id: str("Routine or reminder id (rt_…), from cora_routines_list.", { pattern: "^[\\w-]+$" }) };
const THREAD = { thread_id: str("Thread or channel id, from cora_threads_list.") };
const FOLDER = { folder_id: str("Artifact folder id (af_…), from cora_artifacts_list.", { pattern: "^af_[a-f0-9]{12}$" }) };
const COMMIT = { commit_id: str("Artifact commit id (ac_…), from cora_artifact_folder_get.", { pattern: "^ac_[a-f0-9]{12}$" }) };
const SECRET = { name: str("Vault secret name, capitals, digits and underscores.", { pattern: "^[A-Z][A-Z0-9_]{1,63}$" }) };
const SUBSCRIPTION = { subscription_id: str("Subscription id (sub_…), from cora_subscriptions_list.", { pattern: "^sub_[a-f0-9]{12}$" }) };
const PAGE = { slug: str("Brain page slug, from cora_brain_pages_list.", { pattern: "^[a-z0-9-]{2,60}$" }) };
const BRAIN_OWNER = { ownerId: str("Optional Brain owner id when you hold an authorized Brain scope; default your own.") };
const CONNECTION = { connection: str("Optional connection id when a connector has several (Linear workspaces).") };
const SERVICE = { service: str("Connector id from cora_connectors_list (linear, asana, canva, lovable, firecrawl, earendil, higgsfield).", { pattern: "^[a-z][a-z0-9-]{1,40}$" }) };

const MODEL = str("Model id as listed by cora_models_list (e.g. claude/sonnet, ollama/qwen3:14b, codex/gpt-5). Empty uses the space default.");
const CHARACTER = obj("Character sheet. enabled turns it into the prompt; scores are 1-20 for initiative, speed, endurance, analysis, prudence, warmth; method and focus are the two style axes. Partial updates keep the scores not given.", {
  enabled: bool("Use the sheet as the personality prompt."),
  scores: obj("Trait scores 1-20.", Object.fromEntries(["initiative", "speed", "endurance", "analysis", "prudence", "warmth"].map(key => [key, int(key, { minimum: 1, maximum: 20 })])), { additionalProperties: false }),
  method: int("Style axis: improvised (low) to structured (high).", { minimum: 1, maximum: 20 }),
  focus: int("Style axis: relationship (low) to result (high).", { minimum: 1, maximum: 20 }),
}, { additionalProperties: false });
const AGENT_FIELDS = {
  name: str("Display name, up to 32 characters; Discord forbids 'discord' and 'clyde'.", { maxLength: 32 }),
  personality: str("Free-text personality and instructions, up to 8000 characters.", { maxLength: 8000 }),
  character: CHARACTER,
  core: str("The agent's core card (always-in-mind notes), up to 4000 characters.", { maxLength: 4000 }),
  model: MODEL,
  subscriptionId: str("Subscription that runs the model (sub_…), from cora_subscriptions_list; empty for the space's."),
  credentialId: str("Your own API key (key_…) for Hermes on Ollama Cloud or DeepSeek, from cora_credentials_list; empty for the space key."),
  ollamaHost: str("Ollama server URL for local models, from cora_hardware."),
  effort: { type: "string", enum: ["", "low", "medium", "high"], description: "Reasoning effort for models that support it." },
  think: bool("Show and use extended thinking where supported."),
  tools: bool("Give the agent its computer and tools."),
  enabled: bool("false mutes the agent everywhere."),
  chattiness: num("0 speaks only when called, 1 joins conversations freely.", { minimum: 0, maximum: 1 }),
  channelIds: list("Channels the agent listens in (ids from cora_state channels); empty means all."),
  platformsOff: list("Platforms where this agent is off.", { type: "string", enum: ["discord", "telegram", "slack"] }),
  color: str("Accent color #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" }),
  avatarSeed: str("Seed for the picture Cora draws."),
  gender: { type: "string", enum: ["", "male", "female", "neutral"], description: "How the agent speaks of itself." },
  voice: str("Voice id from cora_voices_list."),
  voiceLanguage: str("Voice language (it, en, ...)."),
  ownerId: str("Chat person the agent answers to (discord:<id>, telegram:<id>, slack:<id>); space owner only."),
};
const ROUTINE_FIELDS = {
  kind: { type: "string", enum: ["routine", "reminder"], description: "routine repeats on a cron schedule; reminder runs once at runAt." },
  name: str("Short name, up to 80 characters."),
  schedule: str("Cron (minute hour day month weekday) in the space timezone; required for a routine. Check it with cora_cron_preview."),
  runAt: str("ISO 8601 date-time with timezone; required for a reminder."),
  channelId: str("Where the result is posted: a channel or thread id the agent can reach."),
  prompt: str("What the agent does each time, up to 8000 characters."),
  enabled: bool("false pauses it."),
};
const SETTINGS_FIELDS = {
  language: { type: "string", enum: ["it", "en"], description: "Panel and agent language." },
  defaultModel: str("Default model for agents without one."),
  decisionModel: str("Model that decides who speaks."),
  decisionSubscriptionId: str("Subscription for the decision model."),
  decisionCredentialId: str("Own key for the decision model."),
  decisionBackups: list("Fallback decision models in order.", obj("Backup", { model: str("Model id"), subscriptionId: str("sub_…"), credentialId: str("key_…") })),
  goalMode: bool("Goal mode: agents keep working until the goal is verified."),
  useResidentSubscriptions: bool("Use the CLI logins already on the server."),
  harnessAutoUpdate: bool("Keep the harness CLIs updated."),
  conversationIdleMinutes: int("Minutes of silence before an agent asks whether to stay."),
  maxRepliesPerRound: int("Agent replies per round, 1-6.", { minimum: 1, maximum: 6 }),
  historySize: int("Messages of history per turn, 5-100.", { minimum: 5, maximum: 100 }),
  sleepHour: int("Hour of the nightly memory sleep, 0-23.", { minimum: 0, maximum: 23 }),
  librarianHour: int("Hour the librarian consolidates the Brain, 0-23.", { minimum: 0, maximum: 23 }),
  reviewHour: int("Hour of the Brain review digest, 0-23.", { minimum: 0, maximum: 23 }),
  brainModel: str("Librarian model; empty uses the default."),
  brainSubscriptionId: str("Subscription for the librarian."),
  brainCredentialId: str("Own key for the librarian."),
  brainBackups: list("Librarian fallback models in order.", obj("Backup", { model: str("Model id"), subscriptionId: str("sub_…"), credentialId: str("key_…") })),
  brainEmbedModel: str("Embedding model of the Brain search."),
  transport: { type: "string", enum: ["discord", "telegram", "slack"], description: "Primary platform (private messages to you)." },
  transports: list("Every platform switched on.", { type: "string", enum: ["discord", "telegram", "slack"] }),
  guildIds: list("Discord server ids Cora lives in."),
  ownerIds: list("Discord user ids of the space owner."),
  telegramChatIds: list("Telegram chat ids Cora listens in."),
  telegramOwnerIds: list("Telegram user ids of the owner."),
  slackChannelIds: list("Slack channel ids switched on."),
  slackOwnerIds: list("Slack user ids of the owner."),
  ollamaHosts: list("Ollama servers of this machine.", obj("Host", { url: str("URL"), label: str("Label"), gpu: str("GPU") })),
  sshKeys: list("Public SSH keys allowed on the agents' desktops."),
  noticeChannel: str("Channel name for usecora.space notices."),
  artifactQuotaGb: int("Artifact space in GB; 0 is half the disk.", { minimum: 0 }),
  githubOrg: str("GitHub organization for the agents' apps; empty for the owner's account."),
};

/** Every tool: area, method, native path (with {placeholders}), path/query/body fields. */
export const AREAS = [
  { id: "agent-communication", title: "Agent communication: talk to the agents", summary: "Talk with Cora's agents (Clara, Nico, ...) directly: talk_to_agent sends a message to an agent by name and returns its reply word for word; wait_for_agent_reply gets a reply still on its way. Delegate whole tasks to them as your subagents with cora_delegate. The agent works on its own computer, with its own tools, memory and connectors." },
  { id: "agents", title: "Agents", summary: "Everything about an agent: profile, model, personality, character, owners, chat permissions, avatar, duplicate, export and import, desktop, chat." },
  { id: "skills", title: "Skills", summary: "Search, discover, install, enable, disable, update, adopt, remove, check and sync each agent's skills, and read their files." },
  { id: "connectors", title: "Connectors", summary: "Connector catalog, key and OAuth connections, which agents may use each one, Google accounts." },
  { id: "providers", title: "Models and providers", summary: "Models, provider keys, subscriptions and their logins, personal API keys, harness updates, hardware, voices." },
  { id: "settings", title: "Space settings", summary: "Space settings, chat permissions, panel access and invitations, context files, transports (Telegram, Slack), push, doc checks." },
  { id: "logs", title: "Logs and activity", summary: "Activity log, agent turns and full reasoning traces, usage per day, goals, routine runs and archive." },
  { id: "memory", title: "Memory and Brain", summary: "Agent memories, core card, diary, sleep, the agent's Brain configuration, company Brain pages, review queue and librarian." },
  { id: "threads", title: "Threads and plans", summary: "Threads with their live flows, create, rename, stop and close them; plans across every thread with each step's reasoning." },
  { id: "routines", title: "Routines and reminders", summary: "Create, change, run, pause and delete routines and one-time reminders." },
  { id: "email", title: "Email", summary: "Space and agent email rules, the agent mailbox, Resend accounts and domains, scheduled sends, signatures." },
  { id: "transports", title: "Chat accounts", summary: "Each agent's own Discord, Telegram and Slack bot, and its GitHub app." },
  { id: "artifacts", title: "Artifacts", summary: "Folders, commits, files, uploads, reviews, restores and share links." },
  { id: "secrets", title: "Secrets", summary: "Vault secret names and descriptions, which agents may use them, request links and sends. Values are never returned." },
];

const T = (area, name, title, method, path, description, spec = {}) => ({ area, name, title, method, path, description, ...spec });

export const TOOLS = [
  // Agent communication
  T("agent-communication", "talk_to_agent", "Talk to a Cora agent", "POST", null, "Talk with a Cora agent directly: send it a message and get its reply. Use it whenever the person wants to talk to an agent, ask it something, pass it a message or be put through to it (\"let me talk to Clara\", \"ask Nico...\"). Send the person's words as they wrote them; the agent reads them in its private chat with the person and answers. Show the person the reply word for word as the agent's own words, and call talk_to_agent again for each next message. The answer has status done (reply holds what the agent said), waiting_for_you (the agent asked a question: show it with its choices and send the person's answer with talk_to_agent) or working (the agent is still on it: call wait_for_agent_reply).", { params: { agent: str("The agent's name as the person says it (e.g. Clara) or its id (ag_…).", { maxLength: 80 }) }, body: { message: str("What to tell the agent: the person's words as written, up to 3000 characters.", { maxLength: 3000 }), wait_seconds: int("How long to wait for the reply, 0-600 (default 120).", { minimum: 0, maximum: 600 }) }, required: ["message"], composite: "talk" }),
  T("agent-communication", "wait_for_agent_reply", "Wait for an agent's reply", "GET", null, "Get the reply to a talk_to_agent message that came back with status working: the agent's words after that message, word for word. Same statuses as talk_to_agent.", { params: { agent: str("The agent's name or id, as given to talk_to_agent.", { maxLength: 80 }), after: str("message_id returned by talk_to_agent.", { pattern: "^[\\w-]{1,80}$" }) }, query: { wait_seconds: int("How long to wait, 0-600 (default 120).", { minimum: 0, maximum: 600 }) }, composite: "talkWait" }),
  T("agent-communication", "cora_delegate", "Delegate a task to a Cora agent", "POST", null, "Hand a task to a Cora agent as your subagent, in a direct message (its private panel chat), and wait for its result. The agent runs the computation itself: its own computer, tools, memory, connectors and colleagues, with your authority. Write a self-contained brief (goal, inputs, constraints, what to return). The answer has status done (the agent finished: replies hold its result), working (still running when the wait ended: continue with cora_delegation_wait) or waiting_for_you (it asked you something: answer with cora_delegate again in the same DM). Several agents can work in parallel: delegate to each, then wait on each.", { params: AGENT, body: { task: str("The brief for the agent, up to 3000 characters.", { maxLength: 3000 }), wait_seconds: int("How long to wait for the result, 0-600 (default 120). 0 returns at once.", { minimum: 0, maximum: 600 }) }, required: ["task"], composite: "delegate" }),
  T("agent-communication", "cora_delegation_wait", "Wait for a delegated task", "GET", null, "Wait for the result of a task handed over with cora_delegate: the agent's replies after that message, whether it is still working and the turns running. Same statuses as cora_delegate.", { params: { ...AGENT, after: str("message_id returned by cora_delegate.", { pattern: "^[\\w-]{1,80}$" }) }, query: { wait_seconds: int("How long to wait, 0-600 (default 120).", { minimum: 0, maximum: 600 }) }, composite: "delegationWait" }),
  // Agents
  T("agents", "cora_agents_list", "List agents", "GET", "/api/state", "Every agent you can see with its id, name, model, subscription, enabled and tools flags, channels, platforms, voice, owners and desktop. Start here to get agent ids.", { pick: (data) => ({ agents: data.agents }) }),
  T("agents", "cora_agent_get", "Read an agent", "GET", "/api/agents/{agent_id}", "One agent's whole profile: identity, personality, character sheet, core card, model, subscription, credential, effort, channels, platforms, voice, owners, bots and avatar.", { params: AGENT }),
  T("agents", "cora_agent_overview", "Everything about an agent", "GET", null, "One call that gathers everything Cora knows about an agent: profile, owners, chat permissions, skills, connectors it may use with the tools they give it, routines, email rules and mailbox, Brain configuration, memories and core, desktop state, GitHub app, latest turns and goals. Sections you may not read report their HTTP error.", { params: AGENT, composite: "agentOverview" }),
  T("agents", "cora_agent_create", "Create an agent", "POST", "/api/agents", "Create a new agent owned by you. Its desktop is prepared when tools is true.", { body: AGENT_FIELDS, required: ["name"] }),
  T("agents", "cora_agent_update", "Change an agent", "PUT", "/api/agents/{agent_id}", "Change any field of an agent; fields left out stay as they are. Owners use cora_agent_owners_set, chat permissions cora_agent_permission_set.", { params: AGENT, body: AGENT_FIELDS }),
  T("agents", "cora_agent_delete", "Delete an agent", "DELETE", "/api/agents/{agent_id}", "Delete an agent and its desktop container; purge also deletes the desktop's disk.", { params: AGENT, query: { purge: { type: "string", enum: ["1"], description: "1 also deletes the desktop's volume." } } }),
  T("agents", "cora_agent_meet_get", "Read Google Meet", "GET", "/api/agents/{agent_id}/meet", "Read this agent's Google Meet settings, writable folders and recent calls.", { params: AGENT }),
  T("agents", "cora_agent_meet_set", "Enable Google Meet", "PUT", "/api/agents/{agent_id}/meet", "Change whether this agent can attend Google Meet calls on its desktop.", { params: AGENT, body: { enabled: bool("Enable or disable Meet.") }, required: ["enabled"] }),
  T("agents", "cora_agent_meet_setup", "Connect the agent’s own Google account", "POST", "/api/agents/{agent_id}/meet/setup", "Queue or resume a one-time setup command in the agent’s private conversation. Read its progress with cora_agent_meet_get.", { params: AGENT }),
  T("agents", "cora_agent_meet_stop_setup", "Stop Google Meet setup", "POST", "/api/agents/{agent_id}/meet/stop-setup", "Stop only this agent’s queued or running Meet setup command.", { params: AGENT }),
  T("agents", "cora_agent_meet_signin", "Open Google sign-in", "POST", "/api/agents/{agent_id}/meet/signin", "Open Google sign-in on this agent’s desktop for the owner to complete.", { params: AGENT }),
  T("agents", "cora_agent_meet_account", "Check the Google account", "POST", "/api/agents/{agent_id}/meet/account", "Check which Google account is signed in on the agent's Meet desktop.", { params: AGENT }),
  T("agents", "cora_agent_meet_signout", "Sign out of Google Meet", "POST", "/api/agents/{agent_id}/meet/signout", "Sign out of the Google profile used for calls by this agent.", { params: AGENT }),
  T("agents", "cora_agent_meet_join", "Join a Google Meet call", "POST", "/api/agents/{agent_id}/meet/join", "Join a Google Meet link and save the transcript in a writable meetings folder.", { params: AGENT, body: { link: str("Google Meet call URL."), folder: str("Existing meetings folder path."), language: str("Spoken language of the call, such as it or en.") }, required: ["link", "folder"] }),
  T("agents", "cora_agent_meet_leave", "Leave a Google Meet call", "POST", "/api/agents/{agent_id}/meet/leave", "Leave this agent's current Google Meet call and prepare the transcript.", { params: AGENT }),
  T("agents", "cora_agent_meet_retry", "Retry the transcript", "POST", "/api/agents/{agent_id}/meet/retry", "Retry saving a failed transcript from the recording on the agent's desktop.", { params: AGENT, body: { id: str("Meeting session id.") }, required: ["id"] }),
  T("agents", "cora_agent_avatar_set", "Set an agent's picture", "PUT", "/api/agents/{agent_id}/avatar", "Upload a square PNG 512-2000 px as the agent's picture.", { params: AGENT, body: { image: str("data:image/png;base64,… of a square PNG.") }, required: ["image"] }),
  T("agents", "cora_agent_avatar_reset", "Back to the drawn picture", "DELETE", "/api/agents/{agent_id}/avatar", "Remove the uploaded picture: Cora draws it again.", { params: AGENT }),
  T("agents", "cora_agent_owners_get", "Read an agent's owners", "GET", "/api/agents/{agent_id}/owners", "Panel owners of the agent (primary and co-owners), the chat people it answers to, and the version to pass when saving.", { params: AGENT }),
  T("agents", "cora_agent_owners_set", "Set an agent's owners", "PUT", "/api/agents/{agent_id}/owners", "Set panel co-owners (users must keep the primary owner) and the chat contacts the agent answers to. Pass the version read with cora_agent_owners_get.", { params: AGENT, body: { users: list("Panel user ids, including the primary owner."), contacts: list("Chat person ids from chatPeople."), version: str("Version from cora_agent_owners_get.") }, required: ["users", "contacts"] }),
  T("agents", "cora_agent_permissions_get", "Who may put the agent to work", "GET", "/api/agents/{agent_id}/permissions", "People in the chats and whether each may give this agent work on its computer.", { params: AGENT }),
  T("agents", "cora_agent_permission_set", "Allow or deny a person", "PUT", "/api/agents/{agent_id}/permissions", "Allow or deny one chat person (id from cora_agent_permissions_get) to put this agent to work.", { params: AGENT, body: { id: str("Person id (discord:…, telegram:…, slack:…)."), allowed: bool("true allows, false denies.") }, required: ["id", "allowed"] }),
  T("agents", "cora_agent_duplicate_preview", "Preview a duplicate", "GET", "/api/agents/{agent_id}/duplicate", "What a copy of this agent would take with it.", { params: AGENT }),
  T("agents", "cora_agent_duplicate", "Duplicate an agent", "POST", "/api/agents/{agent_id}/duplicate", "Create a copy of the agent with a new name; the copy starts muted.", { params: AGENT, body: { name: str("Name of the copy.") } }),
  T("agents", "cora_agent_export_preview", "Preview an export", "GET", "/api/agents/{agent_id}/export", "What an export package would contain, the active export links and the file name.", { params: AGENT }),
  T("agents", "cora_agent_export_file", "Export an agent to a file", "POST", "/api/agents/{agent_id}/export/file", "Build the agent package (JSON) with the chosen parts and return it.", { params: AGENT, body: { choice: obj("Parts to include, e.g. { personality: true, avatar: true, routines: true, memories: true }.", {}, { additionalProperties: true }) } }),
  T("agents", "cora_agent_export_link_create", "Create an export link", "POST", "/api/agents/{agent_id}/export/links", "A download link for the agent package that another Cora can import.", { params: AGENT, body: { choice: obj("Parts to include.", {}, { additionalProperties: true }), days: int("Days the link lasts."), downloads: int("Downloads allowed.") } }),
  T("agents", "cora_agent_export_link_revoke", "Revoke an export link", "DELETE", "/api/agents/{agent_id}/export/links/{link_id}", "Close an export link at once: the package can no longer be downloaded through it.", { params: { ...AGENT, link_id: str("Link id (apl_…).", { pattern: "^apl_[a-f0-9]{12}$" }) } }),
  T("agents", "cora_agent_import_preview", "Preview an agent import", "POST", "/api/agent-imports/preview", "Stage an agent package from an export link or a package JSON and see what it brings and which choices it needs.", { body: { url: str("Export link from another Cora."), file: obj("Package JSON instead of a link.", {}, { additionalProperties: true }) } }),
  T("agents", "cora_agent_import", "Import an agent", "POST", "/api/agent-imports", "Create the agent from a staged package. id comes from cora_agent_import_preview; the other fields override what it brings.", { body: { id: str("Staged import id."), name: str("Name of the new agent."), model: MODEL, subscriptionId: str("sub_…"), credentialId: str("key_…"), routines: obj("Routine choices keyed by routine id.", {}, { additionalProperties: true }) }, passthrough: true, required: ["id"] }),
  T("agents", "cora_agent_chat_read", "Read the agent's panel chat", "GET", "/api/rooms/web-{agent_id}/messages", "The latest messages of the agent's private panel chat and its turns still running.", { params: AGENT, query: { limit: int("Messages, 1-200 (default 80).", { minimum: 1, maximum: 200 }) } }),
  T("agents", "cora_agent_chat_send", "Write to the agent", "POST", "/api/rooms/web-{agent_id}/messages", "Send a message to the agent in its private panel chat as you; it answers there (read it with cora_agent_chat_read).", { params: AGENT, body: { text: str("Message, up to 3000 characters.", { maxLength: 3000 }) }, required: ["text"] }),
  T("agents", "cora_agent_desktop_status", "Desktop state", "GET", "/api/agents/{agent_id}/box/access", "Whether the agent's desktop runs, is outdated, its SSH access and Tailscale state.", { params: AGENT }),
  T("agents", "cora_agent_desktop_start", "Start the desktop", "POST", "/api/agents/{agent_id}/box/start", "Start the agent's Linux desktop, creating its container first when it does not exist; returns the desktop state.", { params: AGENT }),
  T("agents", "cora_agent_desktop_stop", "Stop the desktop", "POST", "/api/agents/{agent_id}/box/stop", "Stop the agent's desktop container; its home stays. The agent loses its computer tools until started again.", { params: AGENT }),
  T("agents", "cora_agent_desktop_restart", "Restart the desktop", "POST", "/api/agents/{agent_id}/box/restart", "Restart the agent's desktop container, keeping its home; returns the new state.", { params: AGENT }),
  T("agents", "cora_agent_desktop_upgrade", "Upgrade the desktop", "POST", "/api/agents/{agent_id}/box/upgrade", "Recreate the desktop on the latest image, keeping its home.", { params: AGENT }),
  T("agents", "cora_agent_desktop_tailscale", "Connect the desktop to Tailscale", "POST", "/api/agents/{agent_id}/box/tailscale", "Join the running desktop to Tailscale with SSH; returns the login link when authorization is needed.", { params: AGENT }),
  T("agents", "cora_agent_desktop_screenshot", "See the desktop", "GET", "/api/agents/{agent_id}/box/screenshot", "A screenshot of the agent's running desktop, returned as an image.", { params: AGENT }),
  T("agents", "cora_agent_traces", "The agent's turns", "GET", "/api/agents/{agent_id}/traces", "The agent's latest turns (running first) with model, status, duration, tokens and goal. Read one whole with cora_trace_get.", { params: AGENT, query: { limit: int("Turns, 1-200 (default 60).", { minimum: 1, maximum: 200 }), goal: str("Only the turns that worked toward this goal.") } }),
  T("agents", "cora_agent_goals", "The agent's goals", "GET", "/api/agents/{agent_id}/goals", "Goals the agent worked toward and the usage each took.", { params: AGENT }),

  // Skills
  T("skills", "cora_skills_search", "Search skills", "GET", "/api/skills/search", "Search the public skill catalog (skills.sh) by words.", { query: { q: str("Words to search.") }, required: ["q"] }),
  T("skills", "cora_skills_discover", "List the skills in a source", "POST", "/api/skills/discover", "List the skills a source holds before installing: owner/repo, a GitHub link, a skills.sh page or an `npx skills add` line.", { body: { source: str("Skill source.") }, required: ["source"] }),
  T("skills", "cora_agent_skills_list", "An agent's skills", "GET", "/api/agents/{agent_id}/skills", "Skills installed for the agent with source, version, enabled state and available updates.", { params: AGENT }),
  T("skills", "cora_agent_skill_install", "Install a skill", "POST", "/api/agents/{agent_id}/skills", "Install a skill for the agent from a source; skill picks one when the source holds several.", { params: AGENT, body: { source: str("Skill source."), skill: str("Skill name inside the source.") }, required: ["source"] }),
  T("skills", "cora_agent_skill_set_enabled", "Enable or disable a skill", "PATCH", "/api/agents/{agent_id}/skills/{skill}", "Switch an installed skill on or off for the agent without removing it.", { params: { ...AGENT, ...SKILL }, body: { enabled: bool("true enables, false disables.") }, required: ["enabled"] }),
  T("skills", "cora_agent_skill_update", "Update a skill", "POST", "/api/agents/{agent_id}/skills/{skill}/update", "Update an installed skill to its source's latest version.", { params: { ...AGENT, ...SKILL } }),
  T("skills", "cora_agent_skill_adopt", "Adopt a desktop skill", "POST", "/api/agents/{agent_id}/skills/{skill}/adopt", "Take under Cora's management a skill found on the agent's desktop.", { params: { ...AGENT, ...SKILL } }),
  T("skills", "cora_agent_skill_remove", "Remove a skill", "DELETE", "/api/agents/{agent_id}/skills/{skill}", "Uninstall a skill from the agent: removed from Cora, from the agent's desktop and from its prompt.", { params: { ...AGENT, ...SKILL } }),
  T("skills", "cora_agent_skill_read", "Read a skill file", "GET", "/api/agents/{agent_id}/skills/{skill}/files", "Read SKILL.md or another file of an installed skill.", { params: { ...AGENT, ...SKILL }, query: { path: str("Relative file path, default SKILL.md.") } }),
  T("skills", "cora_agent_skills_check", "Check for skill updates", "POST", "/api/agents/{agent_id}/skills/check", "Check every installed skill of the agent for updates.", { params: AGENT }),
  T("skills", "cora_agent_skills_sync", "Sync skills to the desktop", "POST", "/api/agents/{agent_id}/skills/sync", "Copy the agent's skills onto its desktop again and find skills installed there by hand.", { params: AGENT }),

  // Connectors
  T("connectors", "cora_connectors_list", "Connectors", "GET", "/api/connectors", "The connector catalog (each connector's fields and flows), every key/OAuth connection with its status and authorized agents, Google accounts and their agents.", {}),
  T("connectors", "cora_connector_connect", "Connect a connector", "POST", "/api/connectors/keys/{service}", "Connect a key connector. mode key with token stores an API key; mode oauth with clientId and clientSecret stores the app for a later OAuth sign-in (cora_connector_oauth_start); Lovable mode quick takes the returned value. Read the catalog for each connector's fields.", { params: SERVICE, query: CONNECTION, body: { mode: { type: "string", enum: ["key", "oauth", "quick"], description: "How to connect." }, token: str("API key or token."), clientId: str("OAuth app client id."), clientSecret: str("OAuth app client secret."), returned: str("Lovable quick sign-in value.") } }),
  T("connectors", "cora_connector_oauth_start", "Start OAuth sign-in", "POST", "/api/connectors/keys/{service}/authorize", "OAuth sign-in needs your browser: the answer gives the Cora page to open while signed in as you.", { params: SERVICE, query: { ...CONNECTION, mode: str("Optional sign-in mode.") } }),
  T("connectors", "cora_connector_set_agents", "Choose who uses a connector", "PUT", "/api/connectors/keys/{service}", "Set which agents receive this connector's tools. Agents not listed lose them.", { params: SERVICE, query: CONNECTION, body: { agents: list("Agent ids.") }, required: ["agents"] }),
  T("connectors", "cora_connector_disconnect", "Disconnect a connector", "DELETE", "/api/connectors/keys/{service}", "Disconnect a connector, revoke its OAuth token where possible and remove its key.", { params: SERVICE, query: CONNECTION }),
  T("connectors", "cora_google_connect", "Connect a Google account", "POST", "/api/connectors/google", "Google sign-in needs your browser: the answer gives the Cora page to open while signed in as you.", {}),
  T("connectors", "cora_google_set_agents", "Choose who uses a Google account", "PUT", "/api/connectors/{connection_id}", "Set which agents may use a Google account (Gmail, Drive).", { params: { connection_id: str("Google connection id (gc_…).", { pattern: "^gc_[a-f0-9]{16}$" }) }, body: { agents: list("Agent ids.") }, required: ["agents"] }),
  T("connectors", "cora_google_disconnect", "Disconnect a Google account", "DELETE", "/api/connectors/{connection_id}", "Disconnect a Google account: every agent loses its Gmail and Drive tools for that account.", { params: { connection_id: str("Google connection id (gc_…).", { pattern: "^gc_[a-f0-9]{16}$" }) } }),

  // Providers and models
  T("providers", "cora_models_list", "Models and providers", "GET", "/api/state", "Every model available now, the providers, which space keys are set (with hints for the owner), harness versions, resident and connected subscriptions, personal keys, quotas and provider usage.", { pick: (data) => ({ models: data.models, providers: data.providers, keys: data.keys, keyHints: data.keyHints, harnesses: data.harnesses, ollamaCloud: data.ollamaCloud, subscriptions: data.subscriptions, credentials: data.credentials, quotaAccounts: data.quotaAccounts, providerUsage: data.providerUsage }) }),
  T("providers", "cora_provider_key_set", "Set a space provider key", "PUT", "/api/providers/{provider}/key", "Store a space-wide key in the vault (owner only). Soniox and DeepSeek keys are tested before they are kept.", { params: { provider: { type: "string", enum: ["ollama", "orcarouter", "typesafe", "soniox", "deepseek"], description: "Provider." } }, body: { key: str("The API key.") }, required: ["key"] }),
  T("providers", "cora_provider_usage", "Provider usage", "GET", "/api/providers/{provider}/usage", "Quota and usage of the space's Ollama Cloud or DeepSeek key.", { params: { provider: { type: "string", enum: ["ollama", "deepseek"], description: "Provider." } } }),
  T("providers", "cora_subscriptions_list", "Subscriptions", "GET", "/api/subscriptions", "Connected subscriptions (Claude, Codex, Grok, Gemini, Kimi, Pi, …) with status, who connected them and the agents using them.", {}),
  T("providers", "cora_subscription_get", "Read a subscription", "GET", "/api/subscriptions/{subscription_id}", "One subscription: provider, label, who connected it, login state and the agents using it.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscription_create", "Add a subscription", "POST", "/api/subscriptions", "Add a subscription for a provider, then sign in with cora_subscription_login.", { body: { provider: { type: "string", enum: ["claude", "codex", "grok", "muse", "kimi", "pi", "gemini"], description: "Harness provider." }, label: str("Label."), service: str("Pi only: anthropic or openai-codex.") }, required: ["provider"] }),
  T("providers", "cora_subscription_login", "Start a subscription login", "POST", "/api/subscriptions/{subscription_id}/login", "Start the provider's sign-in; the answer carries the link to open and whether a code is expected.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscription_code", "Send the login code", "POST", "/api/subscriptions/{subscription_id}/code", "Send the code the provider showed after sign-in.", { params: SUBSCRIPTION, body: { code: str("The code.") }, required: ["code"] }),
  T("providers", "cora_subscription_cancel", "Cancel a login", "POST", "/api/subscriptions/{subscription_id}/cancel", "Stop a subscription sign-in in progress and discard its pending code.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscription_check", "Check a subscription", "POST", "/api/subscriptions/{subscription_id}/check", "Check that the subscription still answers.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscription_usage", "Subscription quota", "GET", "/api/subscriptions/{subscription_id}/usage", "Current quota windows and usage of the subscription.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscription_remove", "Remove a subscription", "DELETE", "/api/subscriptions/{subscription_id}", "Remove a subscription and its stored login.", { params: SUBSCRIPTION }),
  T("providers", "cora_subscriptions_find_resident", "Find resident logins", "POST", "/api/subscriptions/resident/check", "Look for CLI logins already on the server and list them.", {}),
  T("providers", "cora_credentials_list", "Personal API keys", "GET", "/api/credentials", "Your own API keys for Hermes (Ollama Cloud, DeepSeek). Values never come back.", {}),
  T("providers", "cora_credential_create", "Add a personal API key", "POST", "/api/credentials", "Store your own Ollama Cloud or DeepSeek key after checking it; returns its models.", { body: { provider: { type: "string", enum: ["ollama", "deepseek"], description: "Provider." }, secret: str("The API key."), label: str("Label.") }, required: ["provider", "secret"] }),
  T("providers", "cora_credential_models", "Models of a personal key", "GET", "/api/credentials/{credential_id}/models", "Models one of your personal API keys can use with Hermes.", { params: { credential_id: str("Key id (key_…).", { pattern: "^key_[a-f0-9]{12}$" }) } }),
  T("providers", "cora_credential_remove", "Remove a personal API key", "DELETE", "/api/credentials/{credential_id}", "Delete one of your personal API keys; agents using it fall back to the space key or stop.", { params: { credential_id: str("Key id (key_…).", { pattern: "^key_[a-f0-9]{12}$" }) } }),
  T("providers", "cora_hermes_models", "Hermes models of a space key", "GET", "/api/hermes/models", "Models the space's Ollama Cloud or DeepSeek key offers to Hermes.", { query: { backend: { type: "string", enum: ["ollama", "deepseek"], description: "Backend." } }, required: ["backend"] }),
  T("providers", "cora_harnesses_update", "Update the harnesses", "POST", "/api/harnesses/check", "Check and update every harness CLI (Claude Code, Codex, Grok, Gemini, …) now; returns their versions.", {}),
  T("providers", "cora_hardware", "Hardware and Ollama", "GET", "/api/hardware", "GPUs, Ollama servers, their versions and loaded models.", {}),
  T("providers", "cora_ollama_pull", "Download an Ollama model", "POST", "/api/ollama/pull", "Download a model to a local Ollama server; progress shows in the activity log.", { body: { model: str("Model name, e.g. qwen3:14b."), host: str("Ollama URL; default the local one.") }, required: ["model"] }),
  T("providers", "cora_voices_list", "Voices", "GET", "/api/voices", "Voices agents can speak with (Fish or Soniox) and their languages.", {}),
  T("providers", "cora_voice_preview", "Hear a voice", "POST", "/api/voices/preview", "A spoken sample of a voice, returned as audio.", { body: { voice: str("Voice id."), language: str("Language."), text: str("Sample text, up to 300 characters.") } }),

  // Space settings
  T("settings", "cora_state", "Whole panel state", "GET", "/api/state", "Everything the panel loads at once: your identity and role, settings, version, transports and their status, channels, agents, routines, models, providers, keys, subscriptions, quotas, desktop image, artifacts.", {}),
  T("settings", "cora_settings_get", "Space settings", "GET", "/api/state", "Space settings with the transports, channels and Discord servers they refer to.", { pick: (data) => ({ settings: data.settings, timezone: data.timezone, transport: data.transport, transports: data.transports, channels: data.channels, guilds: data.guilds, discord: data.discord, telegram: data.telegram, slack: data.slack, access: data.access }) }),
  T("settings", "cora_settings_update", "Change space settings", "PUT", "/api/settings", "Change space settings (space owner). Fields left out stay as they are. Chat permissions use cora_permissions_set.", { body: SETTINGS_FIELDS }),
  T("settings", "cora_storage_get", "Read storage maintenance", "GET", "/api/storage", "Read the space owner's cleanup policy, current run and latest per-task results.", {}),
  T("settings", "cora_storage_sample", "Read a storage sample", "GET", "/api/storage/sample", "Read one retained hourly measurement of disk usage across the host and agent desktops.", { query: { hour: str("UTC hour from cora_storage_get (YYYY-MM-DDTHH).") }, required: ["hour"] }),
  T("settings", "cora_storage_set", "Configure storage maintenance", "PUT", "/api/storage", "Choose the local cleanup time, enabled tasks and number of verified backups per type.", { body: { automatic: bool("Run automatically."), time: str("Local HH:MM in the space timezone."), keep: int("Valid copies per type.", { minimum: 1, maximum: 90 }), backups: bool("Rotate nightly backups."), grok: bool("Share identical Grok binary blocks."), monitor: bool("Measure disk usage hourly."), sampleDays: int("Days of hourly samples to retain.", { minimum: 1, maximum: 90 }) } }),
  T("settings", "cora_storage_run", "Run storage maintenance", "POST", "/api/storage/run", "Preview or run one maintenance task now. Read storage status for its result.", { body: { action: str("Task to perform.", { enum: ["backups", "grok", "monitor"] }), preview: bool("Preview changes without applying them.") }, required: ["action", "preview"] }),
  T("settings", "cora_appearance_get", "Space appearance", "GET", "/api/appearance", "How the panel looks for everyone in the space: theme, light or dark, accent and sidebar colors, space name and the logo's version.", {}),
  T("settings", "cora_appearance_set", "Change the space appearance", "PUT", "/api/appearance", "Choose a ready theme (cora, giorno, notte, studio) or custom colors, and the name shown in the sidebar (space owner). Fields left out stay as they are.", { body: { theme: { type: "string", enum: ["cora", "giorno", "notte", "studio", "custom"], description: "Theme; custom uses mode, accent and sidebar." }, mode: { type: "string", enum: ["light", "dark"], description: "Light or dark surfaces for a custom theme." }, accent: str("Accent color, #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" }), sidebar: str("Sidebar color, #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" }), name: str("Name in the sidebar, up to 40 characters; empty shows Cora.") } }),
  T("settings", "cora_appearance_logo_set", "Upload the space logo", "PUT", "/api/appearance/logo", "Replace the logo in the sidebar with a PNG, JPEG or WebP up to 512 KB (space owner).", { body: { image: str("The image as base64 or a data: URL.") }, required: ["image"] }),
  T("settings", "cora_appearance_logo_remove", "Remove the space logo", "DELETE", "/api/appearance/logo", "Go back to the Cora mark in the sidebar (space owner).", {}),
  T("settings", "cora_permissions_get", "Chat permissions", "GET", "/api/permissions", "Which chat people may put which agents to work.", {}),
  T("settings", "cora_permissions_set", "Replace chat permissions", "PUT", "/api/permissions", "Replace every chat permission (space owner). agents [\"*\"] means every agent.", { body: { grants: list("Grants.", obj("Grant", { id: str("discord:<id>, telegram:<id> or slack:<id>"), name: str("Name"), agents: list("Agent ids or *"), excludedAgents: list("Agent ids excluded from *") })) }, required: ["grants"] }),
  T("settings", "cora_discord_people", "Discord people", "GET", "/api/settings/discord/people", "People seen on Discord, to pick owners and permissions.", {}),
  T("settings", "cora_access_get", "Panel access", "GET", "/api/access", "Allowed emails and domains, invitations, panel users and the access audit (space owner).", {}),
  T("settings", "cora_access_set", "Set panel access", "PUT", "/api/access", "Replace the allowed emails and domains; new emails get an invitation.", { body: { emails: list("Allowed emails."), domains: list("Allowed company domains.") }, required: ["emails", "domains"] }),
  T("settings", "cora_access_invite", "Invite to the panel", "POST", "/api/access/invitations", "Send a panel invitation email to an allowed address (space owner).", { body: { email: str("Email.") }, required: ["email"] }),
  T("settings", "cora_access_user_block", "Block or unblock a panel user", "PUT", "/api/access/users/{user_id}", "Block or unblock a panel user: a block closes their sessions and MCP accesses at once (space owner).", { params: { user_id: str("Panel user id from cora_access_get.") }, body: { blocked: bool("true blocks.") }, required: ["blocked"] }),
  T("settings", "cora_context_get", "Context", "GET", "/api/context", "Context files and documents every agent reads (AGENTS.md and the like), with their revisions.", {}),
  T("settings", "cora_context_file_write", "Write a server context file", "PUT", "/api/context/files/{file_id}", "Replace a server instruction file (space owner). Pass the revision you read.", { params: { file_id: str("File id from cora_context_get.") }, body: { content: str("New content."), expectedRevision: str("Revision read with cora_context_get.") }, required: ["content"] }),
  T("settings", "cora_context_document_create", "Add a context document", "POST", "/api/context/documents", "Add a context document every agent reads.", { body: { name: str("Name."), content: str("Content."), enabled: bool("Whether agents read it.") }, required: ["name", "content"] }),
  T("settings", "cora_context_document_update", "Change a context document", "PUT", "/api/context/documents/{document_id}", "Change a context document's name, content or whether agents read it; pass the revision you read.", { params: { document_id: str("Document id (ctx_…).", { pattern: "^ctx_[a-f0-9]{12}$" }) }, body: { name: str("Name."), content: str("Content."), enabled: bool("Whether agents read it."), revision: int("Revision read.") } }),
  T("settings", "cora_context_document_delete", "Delete a context document", "DELETE", "/api/context/documents/{document_id}", "Delete a context document: agents stop reading it from their next turn.", { params: { document_id: str("Document id (ctx_…).", { pattern: "^ctx_[a-f0-9]{12}$" }) } }),
  T("settings", "cora_telegram_token_set", "Set the Telegram bot", "PUT", "/api/telegram/token", "Connect the space's main Telegram bot with its BotFather token.", { body: { token: str("BotFather token.") }, required: ["token"] }),
  T("settings", "cora_slack_tokens_set", "Set the Slack app", "PUT", "/api/slack/token", "Connect the space's main Slack app with its bot (xoxb-) and app-level (xapp-) tokens.", { body: { botToken: str("xoxb- token."), appToken: str("xapp- token.") }, required: ["botToken", "appToken"] }),
  T("settings", "cora_slack_config_token_set", "Set Slack configuration token", "PUT", "/api/slack/config-token", "Store the Slack app configuration refresh token (xoxe-) so agent apps follow the panel.", { body: { token: str("xoxe- refresh token.") }, required: ["token"] }),
  T("settings", "cora_slack_apps_sync", "Sync Slack apps", "POST", "/api/slack/apps/sync", "Push names, descriptions and pictures to every agent's Slack app now.", {}),
  T("settings", "cora_slack_channels", "Slack channels", "GET", "/api/slack/channels", "Refresh and list the Slack channels the apps can reach.", {}),
  T("settings", "cora_transport_accounts", "Agents' chat accounts", "GET", "/api/transport-accounts", "Every agent's Slack and Telegram bot state (space owner).", {}),
  T("settings", "cora_push_status", "Push notifications", "GET", "/api/push", "Whether push notifications work and how many devices receive them.", {}),
  T("settings", "cora_push_test", "Test push notifications", "POST", "/api/push/test", "Send a test notification to your devices.", {}),
  T("settings", "cora_doc_probe", "Check doc", "POST", "/api/doc/probe", "Whether doc (TypeSafe checks on what agents say) is installed and runs.", {}),
  T("settings", "cora_doc_rules_get", "doc checks", "GET", "/api/doc/rules", "Built-in and custom doc checks with their state.", {}),
  T("settings", "cora_doc_rules_set", "Set doc checks", "PUT", "/api/doc/rules", "Switch built-in checks off (\"on:key\") and replace up to 20 custom checks.", { body: { off: list("Built-in checks off, as on:key."), add: list("Custom checks.", obj("Check", {}, { additionalProperties: true })) }, required: ["add"] }),
  T("settings", "cora_doc_rule_test", "Try a doc check", "POST", "/api/doc/rules/test", "Try a custom check against the active agents' models; follow it with cora_doc_rule_test_status.", { body: { rule: obj("The check to try.", {}, { additionalProperties: true }) }, required: ["rule"] }),
  T("settings", "cora_doc_rule_test_status", "doc check test result", "GET", "/api/doc/rules/test/{test_id}", "Progress and per-model result of a doc check test started with cora_doc_rule_test.", { params: { test_id: str("Test id.", { pattern: "^[a-f0-9]{16}$" }) } }),

  // Logs
  T("logs", "cora_activity", "Activity log", "GET", "/api/activity", "The latest 300 activity entries you may see: messages, tools, settings changes, errors, desktops, routines.", {}),
  T("logs", "cora_traces_recent", "Latest turns", "GET", "/api/traces", "The latest agent turns across agents, running first.", { query: { limit: int("Turns, 1-50 (default 12).", { minimum: 1, maximum: 50 }) } }),
  T("logs", "cora_trace_get", "A whole turn", "GET", "/api/traces/{trace_id}", "One turn whole: prompt context, every reasoning step, tool call with arguments and result, model, tokens and outcome.", { params: { trace_id: str("Trace id (tr_…).", { pattern: "^tr_[0-9a-f]+$" }) } }),
  T("logs", "cora_trace_otlp", "A turn as OpenTelemetry", "GET", "/api/traces/{trace_id}/otlp", "One finished turn as an OTLP/JSON trace (GenAI semantic conventions): an invoke_agent span with execute_tool children. content=1 adds prompts, reasoning, tool arguments and results.", { params: { trace_id: str("Trace id (tr_…).", { pattern: "^tr_[0-9a-f]+$" }) }, query: { content: str("1 to include message content.", { enum: ["1"] }) } }),
  T("logs", "cora_usage", "Usage per day", "GET", "/api/usage", "Tokens and turns per day, agent and model.", { query: { days: int("Days, 30-366 (default 365).", { minimum: 30, maximum: 366 }) } }),
  T("logs", "cora_routine_history", "Routine runs", "GET", "/api/routines/history", "Past routine and reminder runs with result, verification and trace.", { query: { agentId: str("Only this agent."), kind: { type: "string", enum: ["routine", "reminder"], description: "Only this kind." }, query: str("Words to find."), limit: int("Rows."), offset: int("Offset.") } }),
  T("logs", "cora_routine_archive", "Archived routines", "GET", "/api/routines/archive", "Archived routine and reminder definitions.", { query: { agentId: str("Only this agent."), kind: { type: "string", enum: ["routine", "reminder"], description: "Only this kind." }, query: str("Words to find."), limit: int("Rows."), offset: int("Offset.") } }),
  T("logs", "cora_cron_preview", "Preview a cron schedule", "GET", "/api/cron/preview", "The next three runs of a cron expression in the space timezone.", { query: { expr: str("Cron expression.") }, required: ["expr"] }),

  // Memory and Brain
  T("memory", "cora_agent_memory_get", "An agent's memory", "GET", "/api/agents/{agent_id}/memories", "The agent's core card and its history, memories, shared memories, diary and last sleep.", { params: AGENT }),
  T("memory", "cora_agent_memory_add", "Add a memory", "POST", "/api/agents/{agent_id}/memories", "Add a memory to the agent; shared hands it to the company Brain.", { params: AGENT, body: { text: str("The fact."), shared: bool("Every agent should know it."), pinned: bool("Always in mind.") }, required: ["text"] }),
  T("memory", "cora_agent_memory_update", "Change a memory", "PUT", "/api/agents/{agent_id}/memories/{memory_id}", "Change one memory's text or pin, or share it with the company Brain.", { params: { ...AGENT, memory_id: str("Memory id.") }, body: { text: str("The fact."), shared: bool("Share it."), pinned: bool("Pin it.") } }),
  T("memory", "cora_agent_memory_delete", "Delete a memory", "DELETE", "/api/agents/{agent_id}/memories/{memory_id}", "Delete one memory of the agent for good, by id from cora_agent_memory_get.", { params: { ...AGENT, memory_id: str("Memory id.") } }),
  T("memory", "cora_agent_core_set", "Rewrite the core card", "PUT", "/api/agents/{agent_id}/core", "Replace the agent's core card (the notes always in its mind); the previous one stays in its history.", { params: AGENT, body: { text: str("Core card, up to 4000 characters.") }, required: ["text"] }),
  T("memory", "cora_agent_sleep", "Run the memory sleep", "POST", "/api/agents/{agent_id}/sleep", "Make the agent tidy its memory and write its diary now.", { params: AGENT }),
  T("memory", "cora_agent_diary_delete", "Delete a diary page", "DELETE", "/api/agents/{agent_id}/diary/{page_id}", "Delete one page of the agent's diary for good.", { params: { ...AGENT, page_id: str("Diary page id.") } }),
  T("memory", "cora_agent_brain_get", "An agent's Brain setup", "GET", "/api/agents/{agent_id}/knowledge", "Which Brain the agent uses (internal or external), sealing and owner.", { params: AGENT }),
  T("memory", "cora_agent_brain_set", "Set an agent's Brain", "PUT", "/api/agents/{agent_id}/knowledge", "Choose internal or external Brain, seal the agent or change its Brain owner.", { params: AGENT, body: { source: { type: "string", enum: ["internal", "external"], description: "Brain source." }, sealed: bool("Sealed: only its own card, diary and memories."), ownerId: str("Brain owner id."), url: str("External Brain address.") }, passthrough: true }),
  T("memory", "cora_agent_brain_check", "Check the external Brain", "POST", "/api/agents/{agent_id}/knowledge/check", "Read the agent's external Brain once and count its pages.", { params: AGENT }),
  T("memory", "cora_brain_status", "Company Brain", "GET", "/api/brain", "Whether the Brain is connected, its stats, scopes, kinds, last librarian run.", { query: BRAIN_OWNER }),
  T("memory", "cora_brain_live", "Librarian live", "GET", "/api/brain/live", "What the librarian is doing now, with its latest steps.", { query: BRAIN_OWNER }),
  T("memory", "cora_brain_graph", "Brain graph", "GET", "/api/brain/graph", "Every Brain page as a node with the links between pages, as the panel graph draws them.", { query: BRAIN_OWNER }),
  T("memory", "cora_brain_pages_list", "Brain pages", "GET", "/api/brain/pages", "Brain pages, or a search when q is given.", { query: { ...BRAIN_OWNER, q: str("Search words."), kind: str("Only this kind."), status: { type: "string", enum: ["live", "archived"], description: "Live (default) or archived." } } }),
  T("memory", "cora_brain_page_get", "Read a Brain page", "GET", "/api/brain/pages/{slug}", "One Brain page whole with its sources and review state.", { params: PAGE, query: BRAIN_OWNER }),
  T("memory", "cora_brain_page_create", "Write a Brain page", "POST", "/api/brain/pages", "Write a new Brain page as its owner, approved at once; the librarian links it at its next run.", { query: BRAIN_OWNER, body: { slug: str("Slug."), title: str("Title."), kind: str("Kind."), summary: str("Summary."), body: str("Markdown body."), note: str("Why.") }, required: ["title", "body"] }),
  T("memory", "cora_brain_page_update", "Correct a Brain page", "PUT", "/api/brain/pages/{slug}", "Correct a Brain page; fields left out stay.", { params: PAGE, query: BRAIN_OWNER, body: { title: str("Title."), kind: str("Kind."), summary: str("Summary."), body: str("Markdown body."), note: str("Why.") } }),
  T("memory", "cora_brain_page_archive", "Archive a Brain page", "DELETE", "/api/brain/pages/{slug}", "Archive a Brain page: agents no longer find it; it stays readable with status archived.", { params: PAGE, query: BRAIN_OWNER }),
  T("memory", "cora_brain_page_share", "Share a Brain page", "PUT", "/api/brain/pages/{slug}/sharing", "Share one of your Brain pages with people.", { params: PAGE, body: { users: list("Panel user ids."), visibility: str("Visibility.") }, passthrough: true }),
  T("memory", "cora_brain_sharing", "Brain sharing people", "GET", "/api/brain/sharing", "People of this space you can share your Brain pages with.", {}),
  T("memory", "cora_brain_review_queue", "Brain review queue", "GET", "/api/brain/review", "Librarian changes waiting for your review.", { query: BRAIN_OWNER }),
  T("memory", "cora_brain_review", "Review Brain changes", "POST", "/api/brain/review", "Approve or revert the librarian's queued Brain changes, by id or all at once.", { query: BRAIN_OWNER, body: { ids: list("Change ids."), all: bool("Every queued change."), decision: { type: "string", enum: ["approve", "revert"], description: "approve keeps the changes, revert undoes them." } }, required: ["decision"] }),
  T("memory", "cora_brain_run", "Run the librarian", "POST", "/api/brain/run", "Start the librarian now to consolidate notes and chats into Brain pages; follow it with cora_brain_live.", { query: BRAIN_OWNER }),
  T("memory", "cora_brain_diary", "Brain diary", "GET", "/api/brain/diary", "What the Brain recorded between two times (at most two days).", { query: { ...BRAIN_OWNER, from: str("ISO start."), to: str("ISO end.") }, required: ["from", "to"] }),

  // Threads and plans
  T("threads", "cora_threads_list", "Threads", "GET", "/api/threads", "Threads and channels with their agents listening, live flows and whether you can stop them.", {}),
  T("threads", "cora_thread_get", "Read a thread", "GET", "/api/threads/{thread_id}", "One thread: flows, plans with progress, traces and the agents that can open a plan there.", { params: THREAD }),
  T("threads", "cora_thread_otlp", "A thread as OpenTelemetry", "GET", "/api/threads/{thread_id}/otlp", "The finished turns of one thread as OTLP/JSON traces, grouped by gen_ai.conversation.id. content=1 adds message content.", { params: THREAD, query: { content: str("1 to include message content.", { enum: ["1"] }) } }),
  T("threads", "cora_thread_create", "Open a thread", "POST", "/api/threads", "Open a thread under a channel (space owner).", { body: { parentId: str("Parent channel id."), name: str("Thread title.") }, required: ["parentId", "name"] }),
  T("threads", "cora_thread_rename", "Rename a thread", "POST", "/api/threads/rename", "Rename a thread on its platform (Discord, Telegram or Slack); owners of every agent in it only.", { body: { id: str("Thread id."), name: str("New title.") }, required: ["id", "name"] }),
  T("threads", "cora_thread_stop", "Stop work in a thread", "POST", "/api/threads/stop", "Stop one agent's flow in a thread, or every flow you may stop.", { body: { id: str("Thread id."), agentId: str("Only this agent.") }, required: ["id"] }),
  T("threads", "cora_thread_close", "Close a thread", "POST", "/api/threads/close", "Close (archive) a thread on its platform and stop the agents listening there.", { body: { id: str("Thread id.") }, required: ["id"] }),
  T("threads", "cora_plans_list", "Plans", "GET", "/api/plans", "Plans across every thread: open (active or blocked) or history, newest first, paged with next.", { query: { status: { type: "string", enum: ["open", "history"], description: "open (default) or history." }, limit: int("1-200.", { minimum: 1, maximum: 200 }), before: str("Cursor from next.") } }),
  T("threads", "cora_plan_create", "Create a plan", "POST", "/api/threads/{thread_id}/plans", "Give an agent an ordered checklist in a thread; the agent works it at its next authorized turn.", { params: THREAD, body: { agentId: str("Agent id."), name: str("Plan name."), items: list("Steps in order.") }, required: ["agentId", "name", "items"] }),
  T("threads", "cora_plan_close", "Close a plan", "POST", "/api/threads/{thread_id}/plans/{plan_id}/close", "Close an open plan; pass its current revision.", { params: { ...THREAD, plan_id: str("Plan id.") }, body: { revision: int("Current revision.") }, required: ["revision"] }),
  T("threads", "cora_plan_step_reasoning", "A plan step's reasoning", "GET", "/api/threads/{thread_id}/plans/{plan_id}/tasks/{task_id}", "The reasoning the agent linked to one plan step.", { params: { ...THREAD, plan_id: str("Plan id."), task_id: str("Step id.") }, query: { before: int("Cursor from next.") } }),

  // Routines
  T("routines", "cora_routines_list", "Routines and reminders", "GET", "/api/state", "Every routine and reminder you may see with schedule, destination, prompt start, state and last result.", { query: { agentId: str("Only this agent.") }, pick: (data, args) => ({ routines: (data.routines || []).filter((routine) => !args.agentId || routine.agentId === args.agentId) }), localQuery: ["agentId"] }),
  T("routines", "cora_routine_create", "Create a routine or reminder", "POST", "/api/agents/{agent_id}/routines", "Create a routine (cron) or a one-time reminder (runAt) for an agent.", { params: AGENT, body: ROUTINE_FIELDS, required: ["name", "prompt", "channelId"] }),
  T("routines", "cora_routine_update", "Change a routine", "PUT", "/api/routines/{routine_id}", "Change a routine or reminder; fields left out stay.", { params: ROUTINE, body: ROUTINE_FIELDS }),
  T("routines", "cora_routine_run", "Run a routine now", "POST", "/api/routines/{routine_id}/run", "Run a routine or reminder once now, outside its schedule; the result is posted where the routine posts.", { params: ROUTINE }),
  T("routines", "cora_routine_delete", "Delete a routine", "DELETE", "/api/routines/{routine_id}", "Delete a routine or reminder; its past runs stay in cora_routine_history.", { params: ROUTINE }),

  // Email
  T("email", "cora_email_rules_get", "Space email rules", "GET", "/api/mail/channel", "Space email rules and each agent's effective rules.", {}),
  T("email", "cora_email_rules_set", "Set space email rules", "PUT", "/api/mail/channel", "Set the space-wide email rules every agent inherits: on/off, receiving mode, reply mode, report channel, instructions, tracking and allowed senders (space owner).", { body: { enabled: bool("Email channel on."), mode: str("Receiving mode."), replyMode: { type: "string", enum: ["draft", "auto"], description: "Replies as drafts or sent." }, reportChannelId: str("Report channel."), instructions: str("Instructions."), track: bool("Open tracking."), senders: list("Allowed senders or @domains.") }, passthrough: true }),
  T("email", "cora_agent_email_get", "An agent's email", "GET", "/api/agents/{agent_id}/email", "The agent's inbox recap, sent mail, drafts, scheduled sends and effective rules.", { params: AGENT }),
  T("email", "cora_agent_email_rules_set", "Set an agent's email rules", "PUT", "/api/agents/{agent_id}/email", "The agent's own email rules; inherit takes the space's.", { params: AGENT, body: { mode: str("Receiving mode or inherit."), replyMode: { type: "string", enum: ["draft", "auto", "inherit"], description: "Replies." }, senderId: str("Sender id (resend or a Google connection)."), resendSender: obj("Resend sender { local, domain }.", {}, { additionalProperties: true }), reportChannelId: str("Report channel."), instructions: str("Instructions."), signature: str("Signature text."), track: bool("Open tracking."), senders: list("Allowed senders.") }, passthrough: true }),
  T("email", "cora_agent_email_refresh", "Refresh an agent's inbox", "POST", "/api/agents/{agent_id}/email/refresh", "Fetch new mail for the agent now instead of waiting for the next poll; returns its inbox recap.", { params: AGENT }),
  T("email", "cora_agent_email_cancel_scheduled", "Cancel a scheduled email", "DELETE", "/api/agents/{agent_id}/email/scheduled/{scheduled_id}", "Cancel an email the agent scheduled before it is sent.", { params: { ...AGENT, scheduled_id: str("Scheduled id.", { pattern: "^scheduled_[a-f0-9]{24}$" }) } }),
  T("email", "cora_agent_email_signature", "See the email signature", "GET", "/api/agents/{agent_id}/email/signature", "The agent's email signature rendered as the image recipients see.", { params: AGENT }),
  T("email", "cora_agent_email_signature_icon_set", "Set the signature icon", "PUT", "/api/agents/{agent_id}/email/signature-icon", "A square PNG 64-1024 px for the signature.", { params: AGENT, body: { image: str("data:image/png;base64,…") }, required: ["image"] }),
  T("email", "cora_agent_email_signature_icon_reset", "Reset the signature icon", "DELETE", "/api/agents/{agent_id}/email/signature-icon", "Remove the custom signature icon: the signature uses the agent's avatar again.", { params: AGENT }),
  T("email", "cora_agent_mailbox_get", "An agent's mailbox", "GET", "/api/agents/{agent_id}/mailbox", "The agent's own address and the domains it can use.", { params: AGENT }),
  T("email", "cora_agent_mailbox_set", "Set an agent's address", "PUT", "/api/agents/{agent_id}/mailbox", "Give the agent an address on a connected domain.", { params: AGENT, body: { local: str("Part before @."), domain: str("Domain id or name.") }, required: ["local"] }),
  T("email", "cora_mail_domains", "Email domains", "GET", "/api/mail/domains", "Resend accounts and domains with their DNS state.", {}),
  T("email", "cora_mail_account_connect", "Connect a Resend account", "POST", "/api/mail/accounts", "Connect a Resend account with its API key, so agents get their own addresses on its domains (space owner).", { body: { name: str("Label."), key: str("Resend API key (re_…).") }, required: ["name", "key"] }),
  T("email", "cora_mail_account_update", "Change a Resend account", "PUT", "/api/mail/accounts/{account_id}", "Change a Resend account's label or replace its API key (space owner).", { params: { account_id: str("Account id (ma_…).", { pattern: "^ma_[a-f0-9]{16}$" }) }, body: { name: str("Label."), key: str("Resend API key (re_…).") }, required: ["name", "key"] }),
  T("email", "cora_mail_account_check", "Check a Resend account", "POST", "/api/mail/accounts/{account_id}/check", "Check that a Resend account's key still works and list its domains.", { params: { account_id: str("Account id (ma_…).", { pattern: "^ma_[a-f0-9]{16}$" }) } }),
  T("email", "cora_mail_domain_add", "Add an email domain", "POST", "/api/mail/domains", "Add a domain to a Resend account; returns the DNS records.", { body: { name: str("Domain, e.g. acme.com."), accountId: str("Resend account id (ma_…)."), mode: { type: "string", enum: ["send-receive", "send-only"], description: "Use for sending and receiving, or sending only." } }, required: ["name", "accountId"] }),
  T("email", "cora_mail_domain_update", "Change an email domain", "PUT", "/api/mail/domains/{domain_id}", "Switch an email domain between sending only and sending and receiving.", { params: { domain_id: str("Domain id (md_…).", { pattern: "^md_[a-f0-9]{16}$" }) }, body: { mode: { type: "string", enum: ["send-receive", "send-only"], description: "Sending and receiving, or sending only." } }, required: ["mode"] }),
  T("email", "cora_mail_domain_remove", "Remove an email domain", "DELETE", "/api/mail/domains/{domain_id}", "Remove an email domain; refused while agents still use addresses on it.", { params: { domain_id: str("Domain id (md_…).", { pattern: "^md_[a-f0-9]{16}$" }) } }),
  T("email", "cora_mail_domain_check", "Check an email domain", "POST", "/api/mail/domains/{domain_id}/{step}", "check reads the DNS state; verify asks Resend to verify it.", { params: { domain_id: str("Domain id (md_…).", { pattern: "^md_[a-f0-9]{16}$" }), step: { type: "string", enum: ["check", "verify"], description: "check or verify." } } }),

  // Chat accounts and GitHub
  T("transports", "cora_agent_discord_bot_set", "Give an agent its Discord bot", "PUT", "/api/agents/{agent_id}/bot", "Connect the agent's own Discord bot with its token.", { params: AGENT, body: { token: str("Bot token.") }, required: ["token"] }),
  T("transports", "cora_agent_discord_bot_remove", "Remove an agent's Discord bot", "DELETE", "/api/agents/{agent_id}/bot", "Disconnect the agent's own Discord bot: it speaks through the space webhook again.", { params: AGENT }),
  T("transports", "cora_agent_telegram_bot_set", "Give an agent its Telegram bot", "PUT", "/api/agents/{agent_id}/telegram-bot", "Connect the agent's own Telegram bot with its BotFather token.", { params: AGENT, body: { token: str("BotFather token.") }, required: ["token"] }),
  T("transports", "cora_agent_telegram_setup", "Telegram setup check", "GET", "/api/agents/{agent_id}/telegram-setup", "Where the agent's Telegram bot stands in a chat and what is missing.", { params: AGENT, query: { chatId: str("Chat id."), probe: str("Probe id."), since: str("Since.") } }),
  T("transports", "cora_agent_slack_bot_set", "Give an agent its Slack app", "PUT", "/api/agents/{agent_id}/slack-bot", "Connect the agent's own Slack app with its xoxb- and xapp- tokens.", { params: AGENT, body: { botToken: str("xoxb- token."), appToken: str("xapp- token.") }, required: ["botToken", "appToken"] }),
  T("transports", "cora_agent_slack_app_sync", "Sync an agent's Slack app", "POST", "/api/agents/{agent_id}/slack-app", "Push the agent's name, description and picture to its Slack app.", { params: AGENT }),
  T("transports", "cora_agent_github_get", "An agent's GitHub app", "GET", "/api/agents/{agent_id}/github", "The agent's GitHub app and its installations.", { params: AGENT }),
  T("transports", "cora_agent_github_create", "Create an agent's GitHub app", "POST", "/api/agents/{agent_id}/github/manifest", "Start creating the agent's GitHub app; returns the GitHub page to confirm.", { params: AGENT }),
  T("transports", "cora_agent_github_check", "Check an agent's GitHub app", "POST", "/api/agents/{agent_id}/github/check", "Re-read the app and its installations from GitHub.", { params: AGENT }),
  T("transports", "cora_agent_github_install", "Install an agent's GitHub app", "POST", "/api/agents/{agent_id}/github/install", "The GitHub link to install the app on an account or organization.", { params: AGENT }),
  T("transports", "cora_agent_github_installation_approve", "Approve a GitHub installation", "PUT", "/api/agents/{agent_id}/github/installations/{installation_id}", "Approve or refuse an installation of the agent's app.", { params: { ...AGENT, installation_id: str("Installation id.", { pattern: "^\\d+$" }) }, body: { approved: bool("true approves.") }, required: ["approved"] }),
  T("transports", "cora_agent_github_forget", "Forget an agent's GitHub app", "DELETE", "/api/agents/{agent_id}/github", "Forget the agent's GitHub app in Cora; the app itself stays on GitHub until deleted there.", { params: AGENT }),

  // Artifacts
  T("artifacts", "cora_artifacts_list", "Artifact folders", "GET", "/api/artifacts", "Every folder you can read, commits waiting for your review, quota and level shares.", {}),
  T("artifacts", "cora_artifact_folder_get", "Read a folder", "GET", "/api/artifacts/folders/{folder_id}", "One folder: settings, commits with their state, served version and its file tree.", { params: FOLDER }),
  T("artifacts", "cora_artifact_folder_create", "Create a folder", "POST", "/api/artifacts/folders", "Create an artifact folder: path, title, what goes in it, files or site, who may push, and (owner) the publishing policy and reviewers.", { body: { path: str("Lowercase words and dashes separated by /."), title: str("Title."), description: str("What goes in it."), kind: { type: "string", enum: ["files", "site"], description: "files or site." }, writers: list("[\"all\"] or agent ids."), policy: { type: ["string", "null"], enum: ["direct", "review", null], description: "Owner only." }, reviewers: list("Reviewer user ids (owner only).") }, required: ["path"] }),
  T("artifacts", "cora_artifact_folder_update", "Change a folder", "PUT", "/api/artifacts/folders/{folder_id}", "Change a folder's title, description, kind, writers, policy or reviewers.", { params: FOLDER, body: { title: str("Title."), description: str("What goes in it."), kind: { type: "string", enum: ["files", "site"], description: "files or site." }, writers: list("[\"all\"] or agent ids."), policy: { type: ["string", "null"], enum: ["direct", "review", null], description: "null inherits." }, reviewers: list("Reviewer user ids.") } }),
  T("artifacts", "cora_artifact_folder_delete", "Delete a folder", "DELETE", "/api/artifacts/folders/{folder_id}", "Delete an artifact folder with its whole history and its share links.", { params: FOLDER }),
  T("artifacts", "cora_artifact_folder_events", "Folder link log", "GET", "/api/artifacts/folders/{folder_id}/events", "Who opened, viewed and downloaded what through the folder's links.", { params: FOLDER, query: { share: str("Only this share."), before: int("Cursor.") } }),
  T("artifacts", "cora_artifact_upload", "Upload files", "POST", null, "Upload text or base64 files into a folder as one commit (proposed or published by the folder's policy).", { params: FOLDER, body: { files: list("Files.", obj("File", { path: str("Path inside the folder."), content: str("UTF-8 text."), base64: str("Bytes as base64 instead of content.") }, { required: ["path"] }), { minItems: 1 }), dir: str("Subfolder to put them in."), message: str("Commit message.") }, required: ["files"], composite: "artifactUpload" }),
  T("artifacts", "cora_artifact_remove_files", "Remove files", "POST", "/api/artifacts/folders/{folder_id}/remove", "Remove files from a folder as one commit.", { params: FOLDER, body: { paths: list("Paths to remove."), base: str("Commit the change starts from; default the served one."), message: str("Commit message.") }, required: ["paths"] }),
  T("artifacts", "cora_artifact_restore", "Restore a version", "POST", "/api/artifacts/folders/{folder_id}/restore", "Serve an earlier commit of the folder again as a new commit.", { params: FOLDER, body: { commit: str("Commit id.") }, required: ["commit"] }),
  T("artifacts", "cora_artifact_commit_get", "Read a commit", "GET", "/api/artifacts/commits/{commit_id}", "One commit: author, message, state, changes.", { params: COMMIT }),
  T("artifacts", "cora_artifact_commit_review", "Review a commit", "POST", "/api/artifacts/commits/{commit_id}/review", "Approve (publish) or reject a proposed commit.", { params: COMMIT, body: { decision: { type: "string", enum: ["approve", "reject", "force", "ignore"], description: "approve publishes, reject refuses with a note, force publishes over a newer served version, ignore drops it from your queue." }, note: str("Note for the author.") }, required: ["decision"] }),
  T("artifacts", "cora_artifact_file_read", "Read a file", "GET", "/api/artifacts/commits/{commit_id}/files/{file_path}", "One file of a commit: text as text, images as images, other bytes as base64.", { params: { ...COMMIT, file_path: str("Path inside the folder.") } }),
  T("artifacts", "cora_artifact_share_create", "Share a folder", "POST", "/api/artifacts/folders/{folder_id}/shares", "A link to a folder or subfolder: for people (emails, domains), with a password, or public.", { params: FOLDER, body: { label: str("Link name: lowercase letters, digits, dashes."), view: { type: "string", enum: ["site", "files"], description: "site or files." }, access: obj("Access.", { mode: { type: "string", enum: ["people", "password", "public"] }, emails: list("Emails."), domains: list("Domains."), password: str("Password, at least 6 characters.") }), root: str("Subfolder to share."), commit: str("Pin a commit."), expiresAt: num("Expiry, ms since epoch.") }, required: ["label", "access"] }),
  T("artifacts", "cora_artifact_share_update", "Change a share link", "PUT", "/api/artifacts/shares/{share_id}", "Change a share link's access, view, pinned commit, root or expiry.", { params: { share_id: str("Share id (as_…).", { pattern: "^as_[a-f0-9]{12}$" }) }, body: { view: { type: "string", enum: ["site", "files"] }, access: obj("Access.", { mode: { type: "string", enum: ["people", "password", "public"] }, emails: list("Emails."), domains: list("Domains."), password: str("Password.") }), root: str("Subfolder."), commit: str("Pinned commit."), expiresAt: num("Expiry, ms since epoch.") } }),
  T("artifacts", "cora_artifact_share_delete", "Close a share link", "DELETE", "/api/artifacts/shares/{share_id}", "Close a share link at once: whoever has it can no longer open it.", { params: { share_id: str("Share id (as_…).", { pattern: "^as_[a-f0-9]{12}$" }) } }),
  T("artifacts", "cora_artifact_level_get", "Read a level", "GET", "/api/artifacts/level", "A level of paths (e.g. clienti/acme) with the folders inside and its links.", { query: { path: str("Level path.") }, required: ["path"] }),
  T("artifacts", "cora_artifact_level_share", "Share a level", "POST", "/api/artifacts/level/shares", "One link that serves every folder under a level.", { query: { path: str("Level path.") }, body: { label: str("Link name."), view: { type: "string", enum: ["site", "files"] }, access: obj("Access.", { mode: { type: "string", enum: ["people", "password", "public"] }, emails: list("Emails."), domains: list("Domains."), password: str("Password.") }), expiresAt: num("Expiry.") }, required: ["path", "label", "access"] }),

  // Secrets
  T("secrets", "cora_secrets_list", "Secrets", "GET", "/api/secrets", "Vault secret names with description, the agents allowed to use them, requests and sends. Values never come back.", {}),
  T("secrets", "cora_secret_set", "Store a secret", "POST", "/api/secrets", "Store or replace a secret value in the vault.", { body: { ...SECRET, value: str("The value."), description: str("What it is for."), agents: list("Agent ids allowed.") }, required: ["name", "value"] }),
  T("secrets", "cora_secret_update", "Change a secret's access", "PUT", "/api/secrets/{name}", "Change a secret's description and allowed agents, or its value.", { params: SECRET, body: { description: str("What it is for."), agents: list("Agent ids allowed."), value: str("New value.") } }),
  T("secrets", "cora_secret_delete", "Delete a secret", "DELETE", "/api/secrets/{name}", "Delete a secret from the vault; agents that used it lose it at once.", { params: SECRET }),
  T("secrets", "cora_secret_request", "Ask someone for a secret", "POST", "/api/secrets/requests", "A one-time link where a person types a secret into the vault.", { body: { ...SECRET, description: str("What it is for."), agents: list("Agent ids allowed."), hours: int("Hours the link lasts.") }, required: ["name"] }),
  T("secrets", "cora_secret_request_cancel", "Cancel a secret request", "DELETE", "/api/secrets/requests/{request_id}", "Close a secret request link before someone fills it.", { params: { request_id: str("Request id (vr_…).", { pattern: "^vr_[a-f0-9]{12}$" }) } }),
  T("secrets", "cora_secret_send", "Send a secret", "POST", "/api/secrets/{name}/sends", "A link that reveals a secret a set number of times.", { params: SECRET, body: { views: int("Views, 1-20."), days: int("Days, 1-30."), note: str("Note."), access: obj("Who may open it.", { emails: list("Emails.") }, { additionalProperties: true }) } }),
  T("secrets", "cora_secret_send_approve", "Approve a secret send", "POST", "/api/secrets/sends/{send_id}/approve", "Turn on a secret send an agent prepared, optionally changing views, days, note and who may open it.", { params: { send_id: str("Send id (vx_…).", { pattern: "^vx_[a-f0-9]{12}$" }) }, body: { views: int("Views."), days: int("Days."), note: str("Note."), access: obj("Who may open it.", {}, { additionalProperties: true }) } }),
  T("secrets", "cora_secret_send_delete", "Close a secret send", "DELETE", "/api/secrets/sends/{send_id}", "Close a secret send link at once: the secret can no longer be revealed through it.", { params: { send_id: str("Send id (vx_…).", { pattern: "^vx_[a-f0-9]{12}$" }) } }),
  T("secrets", "cora_secret_events", "Secret log", "GET", "/api/secrets/events", "Who stored, used, requested and sent which secret.", {}),
];

export function toolSchema(tool) {
  const properties = { ...(tool.params || {}), ...(tool.query || {}), ...(tool.body || {}) };
  const required = [...new Set([...Object.keys(tool.params || {}), ...(tool.required || [])])];
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: Boolean(tool.passthrough) };
}

const OPEN_WORLD_AREAS = new Set(["agent-communication", "connectors", "transports", "email"]);
/** Explicit hints for every tool: reads change nothing; a write that replaces (PUT) or removes something is destructive. */
const ANNOTATION = (tool) => {
  const openWorldHint = OPEN_WORLD_AREAS.has(tool.area) || /_share|_send/.test(tool.name);
  if (tool.method === "GET") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
  const destructiveHint = tool.method === "DELETE" || tool.method === "PUT" || /delete|remove|disconnect|revoke|forget|archive|reset|restore|purge/.test(tool.name);
  return { readOnlyHint: false, destructiveHint, idempotentHint: tool.method === "PUT" || tool.method === "DELETE", openWorldHint };
};

export function toolDefinition(tool) {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: toolSchema(tool), annotations: { title: tool.title, ...ANNOTATION(tool) } };
}

export function readOnlyTool(tool) { return tool.method === "GET"; }

/** The native request a tool's arguments make: path filled in, query string, JSON body. */
export function nativeRequest(tool, args) {
  let path = tool.path;
  for (const name of Object.keys(tool.params || {})) {
    const value = args[name];
    if (typeof value !== "string" || !value || value.length > 400 || /[\x00-\x1f]/.test(value)) throw Object.assign(new Error(`${name} is required.`), { code: -32602 });
    if (tool.params[name].pattern && !new RegExp(tool.params[name].pattern).test(value)) throw Object.assign(new Error(`${name} is not valid.`), { code: -32602 });
    const encoded = name === "file_path" ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
    path = path.replace(`{${name}}`, encoded);
  }
  const query = new URLSearchParams();
  for (const name of Object.keys(tool.query || {})) {
    if ((tool.localQuery || []).includes(name)) continue;
    if (args[name] !== undefined && args[name] !== null && args[name] !== "") query.set(name, String(args[name]));
  }
  const fixed = new Set([...Object.keys(tool.params || {}), ...Object.keys(tool.query || {})]);
  let body;
  if (tool.method !== "GET") {
    body = {};
    for (const [name, value] of Object.entries(args)) {
      if (fixed.has(name)) continue;
      if (!tool.passthrough && !(name in (tool.body || {}))) continue;
      body[name] = value;
    }
  }
  return { method: tool.method, path: query.size ? `${path}?${query}` : path, body };
}
