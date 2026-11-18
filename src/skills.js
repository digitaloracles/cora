import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { runProcess } from "./box.js";

const DESKTOP_SCRIPT = readFileSync(new URL("./desktop-skills.py", import.meta.url), "utf8");
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Where each harness looks on the desktop: one canonical copy, the others link to it (as `npx skills add -g` does). */
export const SKILL_HOMES = [
  { dir: ".agents/skills", harnesses: ["Codex", "Kimi", "Pi"] },
  { dir: ".claude/skills", harnesses: ["Claude Code"] },
  { dir: ".grok/skills", harnesses: ["Grok"] },
  { dir: ".hermes/skills", harnesses: ["Hermes"] },
  { dir: ".gemini/skills", harnesses: ["Gemini"] },
];
export const SKILL_LIMITS = { files: 200, bytes: 4 * 1024 * 1024, file: 2 * 1024 * 1024 };
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
const HIDDEN = (path) => path.split("/").some((part) => part.startsWith(".") && ![".agents", ".claude", ".codex", ".cursor", ".grok", ".hermes", ".gemini", ".curated", ".system", ".experimental"].includes(part));

export class SkillError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clean = (value, max = 1024) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** `name` and `description` from a SKILL.md's YAML front matter, folded and literal blocks included. */
export function parseFrontmatter(text) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!match) return {};
  const lines = match[1].split(/\r?\n/), out = {};
  for (let at = 0; at < lines.length; at++) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[at]);
    if (!field || !["name", "description"].includes(field[1])) continue;
    let value = field[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (at + 1 < lines.length && (/^\s+\S/.test(lines[at + 1]) || !lines[at + 1].trim())) block.push(lines[++at].trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, "\"").replace(/''/g, "'");
    out[field[1]] = clean(value);
  }
  return out;
}

/**
 * What the person typed: `owner/repo`, `owner/repo/skill`, `owner/repo@skill`, a GitHub URL
 * (with /tree/<ref>/<path>), a skills.sh page, or the whole `npx skills add … --skill x` line.
 */
export function parseSource(input) {
  let text = String(input || "").trim();
  let skill = "";
  const flag = /\s(?:--skill|-s)[ =]+([^\s]+)/.exec(text);
  if (flag) { skill = flag[1]; text = text.replace(flag[0], " "); }
  text = text.replace(/^(?:npx|bunx|pnpm dlx)\s+(?:skills(?:@[\w.-]+)?)\s+add\s+/, "").split(/\s+/)[0] || "";
  text = text.replace(/\.git$/, "").replace(/\/+$/, "");
  let owner, repo, ref = "", path = "";
  let match = /^(?:https?:\/\/)?(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)(?:\/([^/?#]+))?/.exec(text);
  if (match) { [, owner, repo] = match; skill = match[3] || skill; }
  else if ((match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/?#]+)(?:\/([^?#]*))?)?/.exec(text))) {
    [, owner, repo] = match;
    ref = match[3] || "";
    path = (match[4] || "").replace(/\/SKILL\.md$/i, "").replace(/\/+$/, "");
  } else if ((match = /^([^/@\s]+)\/([^/@\s]+)(?:[/@]([^/\s]+))?$/.exec(text))) { [, owner, repo] = match; skill = match[3] || skill; }
  if (!owner || !OWNER.test(owner) || !REPO.test(repo || "")) throw new SkillError(400, "Sorgente non valida: usa owner/repo, owner/repo@skill o un link GitHub o skills.sh.");
  if (path && (path.split("/").some((part) => !part || part === "." || part === ".."))) throw new SkillError(400, "Percorso non valido.");
  return { owner, repo, ref, path, skill: clean(skill, 100) };
}

const REPOSITORY_TTL = 5 * 60 * 1000;

export class Skills {
  constructor({ store, boxes = null, home, githubApi = "https://api.github.com", githubRaw = "https://raw.githubusercontent.com", skillsApi = "https://skills.sh", auditApi = "https://www.skills.sh/tele/audit", githubToken = "", fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
    Object.assign(this, { store, boxes, githubApi: githubApi.replace(/\/+$/, ""), githubRaw: githubRaw.replace(/\/+$/, ""), skillsApi: skillsApi.replace(/\/+$/, ""), auditApi, githubToken, fetchImpl: fetch, log, now });
    this.root = join(home, "skills");
    this.repositories = new Map();
  }

  list(agentId) { return this.store.value(`agentSkills:${agentId}`, []); }
  save(agentId, list) { this.store.setValue(`agentSkills:${agentId}`, list.sort((a, b) => a.name.localeCompare(b.name))); }
  find(agentId, name) { return this.list(agentId).find((skill) => skill.name === name) || null; }
  /** The skills switched on: the only ones in the prompt, in skill_read and on the desktop. */
  active(agentId) { return this.list(agentId).filter((skill) => !skill.disabled); }
  dir(agentId, name) {
    if (!/^[\w-]+$/.test(agentId) || !SKILL_NAME.test(name)) throw new SkillError(400, "Nome della skill non valido.");
    return join(this.root, agentId, name);
  }

  /** What the agent's prompt lists: the name and when to use each skill. */
  index(agentId) { return this.active(agentId).map(({ name, description }) => ({ name, description })); }

  view(agentId) {
    return {
      skills: this.list(agentId).map(({ files, disabled, ...skill }) => ({ ...skill, enabled: !disabled, files: files.length, size: files.reduce((sum, file) => sum + file.size, 0) })),
      check: this.store.value(`agentSkillsCheck:${agentId}`, null),
      homes: SKILL_HOMES,
    };
  }

  async request(url, { as = "json", accept = "" } = {}) {
    let response;
    try {
      const auth = this.githubToken && url.startsWith(`${this.githubApi}/`) ? { Authorization: `Bearer ${this.githubToken}` } : {};
      response = await this.fetchImpl(url, { headers: { "User-Agent": "cora-skills", ...auth, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      throw new SkillError(502, `${new URL(url).host} non risponde (${error.cause?.code || error.name}).`);
    }
    if (response.status === 404) throw new SkillError(404, url.startsWith(this.githubApi) || url.startsWith(this.githubRaw) ? "Repository o percorso non trovato su GitHub (o privato)." : "Non trovato.");
    if (response.status === 403 || response.status === 429) throw new SkillError(429, `${new URL(url).host}: limite di richieste raggiunto, riprova tra qualche minuto.`);
    if (!response.ok) throw new SkillError(502, `${new URL(url).host} risponde ${response.status}.`);
    if (as === "bytes") return Buffer.from(await response.arrayBuffer());
    if (as === "text") return (await response.text()).trim();
    return response.json();
  }

  /** skills.sh search, the same API `npx skills find` uses. */
  async search(query) {
    const q = clean(query, 100);
    if (q.length < 2) return { skills: [] };
    const data = await this.request(`${this.skillsApi}/api/search?${new URLSearchParams({ q })}`);
    return {
      skills: (Array.isArray(data?.skills) ? data.skills : []).slice(0, 25).map((skill) => ({
        id: clean(skill.id, 300), name: clean(skill.name, 100), source: clean(skill.source, 200), skill: clean(skill.skillId || skill.name, 100), installs: Number(skill.installs) || 0,
      })).filter((skill) => skill.source && skill.skill),
    };
  }

  /** A repository at one commit, with its whole tree; kept five minutes so listing then installing reads GitHub once. */
  async repository(source) {
    const key = `${source.owner}/${source.repo}@${source.ref || ""}`.toLowerCase();
    const hit = this.repositories.get(key);
    if (hit && this.now() - hit.at < REPOSITORY_TTL) return hit.repository;
    const repository = await this.fetchRepository(source);
    this.repositories.set(key, { at: this.now(), repository });
    for (const [other, entry] of this.repositories) if (this.now() - entry.at >= REPOSITORY_TTL) this.repositories.delete(other);
    return repository;
  }

  async fetchRepository({ owner, repo, ref }) {
    const api = `${this.githubApi}/repos/${owner}/${repo}`;
    const branch = ref || (await this.request(api)).default_branch;
    const commit = await this.request(`${api}/commits/${encodeURIComponent(branch)}`, { as: "text", accept: "application/vnd.github.sha" });
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new SkillError(502, "GitHub non ha restituito il commit.");
    const tree = await this.request(`${api}/git/trees/${commit}?recursive=1`);
    if (tree.truncated) throw new SkillError(413, "Repository troppo grande per leggerlo intero: indica il link GitHub della cartella della skill.");
    return { owner, repo, ref: branch, commit, tree: tree.tree || [], rootTree: tree.sha };
  }

  folders(repository, path = "") {
    return repository.tree.filter((entry) => entry.type === "blob" && /(^|\/)SKILL\.md$/.test(entry.path) && !SKIP.test(entry.path) && !HIDDEN(entry.path))
      .map((entry) => posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path))
      .filter((folder) => !path || folder === path || folder.startsWith(`${path}/`)).slice(0, 200);
  }

  raw(repository, path) { return this.request(`${this.githubRaw}/${repository.owner}/${repository.repo}/${repository.commit}/${path.split("/").map(encodeURIComponent).join("/")}`, { as: "bytes" }); }

  async described(repository, folders) {
    const out = [];
    for (let at = 0; at < folders.length; at += 8) {
      out.push(...await Promise.all(folders.slice(at, at + 8).map(async (path) => {
        const meta = parseFrontmatter((await this.raw(repository, path ? `${path}/SKILL.md` : "SKILL.md")).toString("utf8"));
        return { name: meta.name || posix.basename(path) || repository.repo, description: meta.description || "", path };
      })));
    }
    return out;
  }

  /** The skills a source offers, as `npx skills add <source> --list` shows them. */
  async discover(input) {
    const source = parseSource(input);
    const repository = await this.repository(source);
    const folders = this.folders(repository, source.path).slice(0, 60);
    if (!folders.length) throw new SkillError(404, "Nessun SKILL.md in questa sorgente.");
    const skills = (await this.described(repository, folders)).filter((skill, at, all) => all.findIndex((other) => other.name === skill.name) === at);
    const wanted = source.skill ? skills.filter((skill) => skill.name === source.skill || posix.basename(skill.path) === source.skill) : skills;
    if (source.skill && !wanted.length) throw new SkillError(404, `La skill ${source.skill} non è in ${source.owner}/${source.repo}.`);
    return { source: `${source.owner}/${source.repo}`, ref: repository.ref, commit: repository.commit, skills: wanted };
  }

  /** Install (or update) one skill from GitHub into the agent's copy on the server, then onto its desktop. */
  async install(agent, { source: input, skill: wanted = "" }, by = null) {
    const source = parseSource(input);
    const name = clean(wanted, 100) || source.skill;
    const repository = await this.repository(source);
    const folders = this.folders(repository, source.path);
    if (!folders.length) throw new SkillError(404, "Nessun SKILL.md in questa sorgente.");
    let folder = folders.length === 1 ? folders[0] : source.path && folders.includes(source.path) ? source.path : null;
    if (name) {
      const exact = folders.filter((path) => posix.basename(path) === name);
      folder = exact.length === 1 ? exact[0] : (await this.described(repository, folders.slice(0, 60))).find((skill) => skill.name === name)?.path ?? null;
      if (folder === null) throw new SkillError(404, `La skill ${name} non è in ${source.owner}/${source.repo}.`);
    }
    if (folder === null) throw new SkillError(409, `${source.owner}/${source.repo} contiene ${folders.length} skill: scegline una.`);
    const prefix = folder ? `${folder}/` : "";
    const entries = repository.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix) && !SKIP.test(entry.path.slice(prefix.length))
      && !folders.some((other) => other !== folder && other.startsWith(prefix) && entry.path.startsWith(`${other}/`)));
    if (entries.length > SKILL_LIMITS.files) throw new SkillError(413, `Troppi file (${entries.length}, massimo ${SKILL_LIMITS.files}).`);
    const total = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    if (total > SKILL_LIMITS.bytes || entries.some((entry) => (entry.size || 0) > SKILL_LIMITS.file)) throw new SkillError(413, "Skill troppo grande (massimo 4 MB, 2 MB per file).");
    const files = [];
    for (let at = 0; at < entries.length; at += 8) {
      files.push(...await Promise.all(entries.slice(at, at + 8).map(async (entry) => ({ path: entry.path.slice(prefix.length), data: await this.raw(repository, entry.path), exec: entry.mode === "100755" }))));
    }
    const tree = folder ? repository.tree.find((entry) => entry.type === "tree" && entry.path === folder)?.sha : repository.rootTree;
    return this.store_(agent, files, { source: `${source.owner}/${source.repo}`, path: folder, ref: repository.ref, commit: repository.commit, tree: tree || "", origin: "github" }, by);
  }

  async store_(agent, files, origin, by) {
    const skillFile = files.find((file) => file.path === "SKILL.md");
    if (!skillFile) throw new SkillError(422, "La cartella non contiene SKILL.md.");
    const meta = parseFrontmatter(skillFile.data.toString("utf8"));
    if (!meta.name || !meta.description) throw new SkillError(422, "SKILL.md senza name o description nel front matter.");
    const name = meta.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
    if (!SKILL_NAME.test(name)) throw new SkillError(422, "Nome della skill non valido.");
    const before = this.find(agent.id, name);
    if (before && origin.origin === "github" && before.source && before.source !== origin.source) throw new SkillError(409, `${agent.name} ha già una skill ${name} da ${before.source}: rimuovila prima.`);
    for (const file of files) {
      const normalized = posix.normalize(file.path);
      if (normalized !== file.path || normalized.startsWith("../") || normalized.startsWith("/") || file.path.includes("\0")) throw new SkillError(422, `Percorso non valido: ${file.path}`);
    }
    const target = this.dir(agent.id, name);
    const temporary = `${target}.incoming-${randomBytes(4).toString("hex")}`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        mkdirSync(dirname(join(temporary, file.path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(temporary, file.path), file.data, { mode: 0o600 });
      }
      rmSync(target, { recursive: true, force: true });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const manifest = files.map((file) => ({ path: file.path, size: file.data.length, sha256: sha256(file.data), exec: Boolean(file.exec) })).sort((a, b) => a.path.localeCompare(b.path));
    const record = {
      name, description: meta.description, ...origin,
      hash: sha256(manifest.map((file) => `${file.path}\0${file.sha256}\n`).join("")), files: manifest,
      ...(before?.disabled ? { disabled: true } : {}), installedAt: before?.installedAt || Date.now(), updatedAt: Date.now(), installedBy: by || before?.installedBy || null,
    };
    this.save(agent.id, [...this.list(agent.id).filter((skill) => skill.name !== name), record]);
    this.log({ type: "skill", agentId: agent.id, text: `${before ? "skill aggiornata" : "skill installata"}: ${name}${record.source ? ` (${record.source})` : ""}` });
    const desktop = await this.sync(agent, [name]).catch((error) => ({ error: error.message }));
    return { skill: this.view(agent.id).skills.find((skill) => skill.name === name), updated: Boolean(before), desktop };
  }

  /** The files of the server copy, read back and checked against the manifest. */
  serverFiles(agentId, record) {
    return record.files.map((file) => {
      const path = join(this.dir(agentId, record.name), file.path);
      const data = existsSync(path) ? readFileSync(path) : null;
      return { ...file, data, ok: Boolean(data && sha256(data) === file.sha256) };
    });
  }

  expected(agentId, except = "") {
    return Object.fromEntries(this.active(agentId).filter((skill) => skill.name !== except).map((skill) => [skill.name, Object.fromEntries(skill.files.map((file) => [file.path, file.sha256]))]));
  }

  /** One operation of the desktop script; `{off: true}` when there is no desktop running. */
  async desktop(agent, op, payload) {
    if (!this.boxes || !agent.tools) return { off: true, reason: "senza computer" };
    const state = await this.boxes.inspect(agent.id);
    if (!state.running) return { off: true, reason: "desktop spento" };
    const result = await runProcess(this.boxes.docker, this.boxes.execArgs(agent.id, ["python3", "-c", DESKTOP_SCRIPT, op]), { input: Buffer.from(JSON.stringify(payload)), timeoutMs: 120000, maxBytes: 32 * 1024 * 1024 });
    if (result.code !== 0) throw new SkillError(502, `desktop: ${result.stderr.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${result.code}`}`);
    return JSON.parse(result.stdout.toString("utf8"));
  }

  /** Write the server copies onto the desktop (all, or the named ones) and link them for every harness. */
  async sync(agent, names = null) {
    const skills = this.active(agent.id).filter((skill) => !names || names.includes(skill.name)).map((skill) => {
      const files = this.serverFiles(agent.id, skill);
      const broken = files.find((file) => !file.ok);
      if (broken) throw new SkillError(409, `La copia sul server di ${skill.name} è danneggiata (${broken.path}): reinstallala.`);
      return { name: skill.name, files: files.map((file) => ({ path: file.path, data: file.data.toString("base64"), exec: file.exec })) };
    });
    const off = this.list(agent.id).filter((skill) => skill.disabled && (!names || names.includes(skill.name))).map((skill) => skill.name);
    return this.desktop(agent, "sync", { skills, off, expected: this.expected(agent.id) });
  }

  /** Switch one skill on or off for this agent: off keeps Cora's copy but takes it out of the prompt, skill_read and the desktop. */
  async setEnabled(agent, name, enabled, by = null) {
    const record = this.find(agent.id, name);
    if (!record) throw new SkillError(404, "Skill non trovata.");
    const next = Boolean(enabled);
    if (next === !record.disabled) return { skill: this.view(agent.id).skills.find((skill) => skill.name === name), changed: false, desktop: null };
    const { disabled, ...rest } = record;
    this.save(agent.id, [...this.list(agent.id).filter((skill) => skill.name !== name), next ? rest : { ...rest, disabled: true }]);
    this.log({ type: "skill", agentId: agent.id, text: `skill ${next ? "attivata" : "disattivata"}: ${name}${by?.name ? ` da ${by.name}` : ""}` });
    const desktop = await this.sync(agent, [name]).catch((error) => ({ error: error.message }));
    return { skill: this.view(agent.id).skills.find((skill) => skill.name === name), changed: true, desktop };
  }

  async remove(agent, name) {
    const record = this.find(agent.id, name);
    if (!SKILL_NAME.test(name)) throw new SkillError(400, "Nome della skill non valido.");
    if (record) {
      rmSync(this.dir(agent.id, name), { recursive: true, force: true });
      this.save(agent.id, this.list(agent.id).filter((skill) => skill.name !== name));
    }
    // A skill that came from the desktop leaves it whole; one installed from a source leaves only Cora's copy and links.
    const desktop = await this.desktop(agent, "remove", { names: [name], everywhere: !record || record.origin === "desktop", expected: this.expected(agent.id) }).catch((error) => ({ error: error.message }));
    if (!record && (desktop.off || desktop.error)) throw new SkillError(desktop.off ? 409 : 502, desktop.error || `Skill ${name} non trovata (${desktop.reason}).`);
    this.log({ type: "skill", agentId: agent.id, text: `skill rimossa: ${name}${record ? "" : " (dal desktop)"}` });
    return { removed: name, desktop };
  }

  /** A skill found on the desktop, taken under Cora: copied to the server, so every harness gets it. */
  async adopt(agent, name, by = null) {
    if (!SKILL_NAME.test(name)) throw new SkillError(400, "Nome della skill non valido.");
    if (this.find(agent.id, name)) throw new SkillError(409, `${name} è già gestita da Cora.`);
    const read = await this.desktop(agent, "read", { name });
    if (read.off) throw new SkillError(409, `Non posso leggere il desktop (${read.reason}).`);
    const files = read.files.map((file) => ({ path: file.path, data: Buffer.from(file.data, "base64"), exec: file.exec }));
    return this.store_(agent, files, { source: "", path: "", ref: "", commit: "", tree: "", origin: "desktop" }, by);
  }

  async update(agent, name, by = null) {
    const record = this.find(agent.id, name);
    if (!record) throw new SkillError(404, "Skill non trovata.");
    if (!record.source) throw new SkillError(409, "Skill presa dal desktop: non ha una sorgente da cui aggiornarla.");
    const [owner, repo] = record.source.split("/");
    for (const key of this.repositories.keys()) if (key.startsWith(`${owner}/${repo}@`.toLowerCase())) this.repositories.delete(key);
    return this.install(agent, { source: `https://github.com/${owner}/${repo}/tree/${record.ref}${record.path ? `/${record.path}` : ""}` }, by);
  }

  /**
   * Verify every skill: the server copy against its manifest, the desktop copy and the link of
   * each harness, whether the source has moved on, and the skills.sh audits.
   */
  async check(agent) {
    const list = this.list(agent.id);
    const skills = Object.fromEntries(list.map((skill) => {
      const files = this.serverFiles(agent.id, skill);
      return [skill.name, { server: files.every((file) => file.ok) ? "ok" : "broken", broken: files.filter((file) => !file.ok).map((file) => file.path) }];
    }));
    let desktop;
    try { desktop = await this.desktop(agent, "check", { expected: this.expected(agent.id) }); } catch (error) { desktop = { error: error.message }; }
    for (const skill of list.filter((item) => item.disabled)) {
      const left = desktop.off || desktop.error ? null : (desktop.found || []).find((entry) => entry.name === skill.name);
      skills[skill.name].desktop = desktop.off ? "off" : desktop.error ? "error" : left ? "left" : "disabled";
    }
    for (const name of Object.keys(skills).filter((key) => !this.find(agent.id, key)?.disabled)) {
      const found = desktop.skills?.[name];
      skills[name].desktop = desktop.off ? "off" : desktop.error ? "error" : !found?.present ? "missing" : found.missing.length || found.changed.length ? "changed" : "ok";
      if (found) Object.assign(skills[name], { missing: found.missing, changed: found.changed, extra: found.extra, links: found.links });
    }
    const repositories = new Map();
    for (const skill of list.filter((item) => item.source)) repositories.set(`${skill.source}@${skill.ref}`, [...(repositories.get(`${skill.source}@${skill.ref}`) || []), skill]);
    await Promise.all([...repositories.values()].map(async (group) => {
      const [owner, repo] = group[0].source.split("/");
      try {
        const tree = await this.request(`${this.githubApi}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(group[0].ref)}?recursive=1`);
        for (const skill of group) {
          const now = skill.path ? (tree.tree || []).find((entry) => entry.type === "tree" && entry.path === skill.path)?.sha : tree.sha;
          skills[skill.name].upstream = tree.truncated && !now ? "unknown" : !now ? "gone" : now === skill.tree ? "current" : "behind";
        }
      } catch (error) {
        for (const skill of group) Object.assign(skills[skill.name], { upstream: "error", upstreamError: error.message });
      }
      try {
        const audit = await this.request(`${this.auditApi}?${new URLSearchParams({ source: group[0].source, skills: group.map((skill) => skill.name).join(",") })}`);
        for (const skill of group) {
          const entry = audit?.[skill.name] || audit?.[posix.basename(skill.path)];
          if (entry) skills[skill.name].audit = Object.fromEntries(Object.entries(entry).filter(([, value]) => value && typeof value === "object").map(([key, value]) => [clean(key, 20), { risk: clean(value.risk, 20), ...(Number.isFinite(value.alerts) ? { alerts: value.alerts } : {}) }]));
        }
      } catch {}
    }));
    const result = { checkedAt: Date.now(), skills, desktop: desktop.off ? { state: "off", reason: desktop.reason } : desktop.error ? { state: "error", error: desktop.error } : { state: "ok" }, found: (desktop.found || []).filter((entry) => !this.find(agent.id, entry.name)) };
    this.store.setValue(`agentSkillsCheck:${agent.id}`, result);
    return result;
  }

  /** What `skill_read` gives an agent: SKILL.md (or one of its files) from the server copy, on any harness. */
  read(agentId, name, file = "SKILL.md", { panel = false } = {}) {
    const record = this.find(agentId, String(name || ""));
    const yours = () => this.active(agentId).map((skill) => skill.name).join(", ") || "none";
    if (!record) return { error: `no skill named ${name}; yours are: ${yours()}` };
    if (record.disabled && !panel) return { error: `${record.name} is switched off for you by the owner; yours are: ${yours()}` };
    const entry = record.files.find((item) => item.path === (file || "SKILL.md"));
    if (!entry) return { error: `${record.name} has no file ${file}; its files: ${record.files.map((item) => item.path).join(", ")}` };
    const data = readFileSync(join(this.dir(agentId, record.name), entry.path));
    if (sha256(data) !== entry.sha256) return { error: `${record.name}/${entry.path} does not match its installed copy; ask the owner to reinstall the skill` };
    if (data.includes(0)) return { error: `${entry.path} is binary (${entry.size} bytes): use it from your desktop at ~/.agents/skills/${record.name}/${entry.path}` };
    return { name: record.name, file: entry.path, text: data.toString("utf8").slice(0, 200000), files: record.files.map((item) => item.path) };
  }

  forget(agentId) {
    if (!/^[\w-]+$/.test(agentId)) return;
    rmSync(join(this.root, agentId), { recursive: true, force: true });
    this.store.setValue(`agentSkills:${agentId}`, []);
    this.store.setValue(`agentSkillsCheck:${agentId}`, null);
  }
}
