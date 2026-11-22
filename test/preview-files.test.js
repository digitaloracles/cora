import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { storeGroups } from "../src/preview-demo.js";
import { runOnce } from "../src/preview-pipeline.js";
import { PREVIEW_TOOLS } from "../src/preview.js";
import { executeTool, OWN_TOOLS, TOOL_DEFS } from "../src/tools.js";
import { textLanguage } from "../src/prompt-lang.js";

const BRIEF = JSON.stringify({ summary: "Makes things.", products: ["Things"], audience: "People", tone: "Plain", focus: "posts" });

test("create_file writes the agent's text as a real file and posts it in the chat; only text formats, never empty", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  const posted = [];
  const ctx = { store: f.app.store, agent: { id: "ag_x", name: "Mara" }, channelId: "web-ag_x", postFile: async (file, caption) => { posted.push({ ...file, caption }); } };
  const ok = await executeTool({ name: "create_file", args: { name: "posts week 48.md", content: "# Two posts\n\nFirst.", caption: "This week's posts" } }, ctx);
  assert.match(ok.text, /^posted posts week 48\.md/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "text/markdown");
  assert.equal(posted[0].data.toString("utf8"), "# Two posts\n\nFirst.");
  assert.equal(posted[0].caption, "This week's posts");
  assert.equal((await executeTool({ name: "create_file", args: { name: "../../etc/leads.csv", content: "a,b" } }, ctx)).text.startsWith("posted leads.csv"), true, "a path never leaves the name");
  assert.match((await executeTool({ name: "create_file", args: { name: "run.sh", content: "rm -rf /" } }, ctx)).text, /^error: use one of these extensions/);
  assert.match((await executeTool({ name: "create_file", args: { name: "empty.md", content: "  " } }, ctx)).text, /^error: content is empty/);
  assert.match((await executeTool({ name: "create_file", args: { name: "a.md", content: "x" } }, { ...ctx, postFile: null })).text, /^error: there is no chat/);
  assert.equal(posted.length, 2);
  assert.ok(OWN_TOOLS.has("create_file") && PREVIEW_TOOLS.has("create_file"));
});

test("the demo space: a file a preview agent makes downloads for its company only", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  const previews = new Map(); const mails = [];
  const request = (id, email, company, site) => previews.set(id, { id, email, company, site, archetype: "marketer", lang: "en", status: "requested", space: "" });
  const deps = {
    now: () => Date.now(), log: () => {}, space: "demo", base: f.base, chat: async () => BRIEF,
    site: async (url) => [{ url, title: "Home", description: "A company", headings: [], text: "" }],
    mail: async (message) => { mails.push(message); },
    groups: storeGroups(f.app, { model: "ollama/gpt-oss:120b", minutes: 60 }),
    cloud: { list: async (status) => [...previews.values()].filter((item) => item.status === status), update: async (id, body) => { Object.assign(previews.get(id), body); }, firstMessage: async () => {} },
  };
  const linkOf = (to) => new URL(/https?:\/\/\S+\/auth\/preview\?token=[\w-]+/.exec(mails.find((mail) => mail.to === to).text)[0]);
  const signIn = async (to) => {
    const link = linkOf(to);
    const res = await fetch(`${f.base}${link.pathname}${link.search}`, { redirect: "manual", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    return (res.headers.get("set-cookie") || "").split(";")[0];
  };
  request("pv_a", "anna@acme.com", "Acme", "https://acme.com");
  request("pv_g", "gina@globex.com", "Globex", "https://globex.com");
  await runOnce(deps);
  const anna = await signIn("anna@acme.com");
  const gina = await signIn("gina@globex.com");
  const state = await (await fetch(`${f.base}/api/state`, { headers: { cookie: anna, "x-cora": "1" } })).json();
  const agent = f.app.store.agent(state.preview.agents[0].id);
  const room = `web-${agent.id}`;
  const [item] = f.app.orchestrator.postWeb(agent, f.app.orchestrator.state(room), "This week's posts", { name: "posts.md", data: Buffer.from("# Posts\n"), type: "text/markdown" });
  assert.ok(item.file?.id);
  const messages = await (await fetch(`${f.base}/api/rooms/${room}/messages?limit=10`, { headers: { cookie: anna, "x-cora": "1" } })).json();
  assert.equal(messages.messages.at(-1).file.name, "posts.md");
  const download = await fetch(`${f.base}/api/files/${item.file.id}`, { headers: { cookie: anna, "x-cora": "1" } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "# Posts\n");
  assert.match(download.headers.get("content-disposition"), /attachment; filename="posts\.md"/);
  assert.equal((await fetch(`${f.base}/api/files/${item.file.id}`, { headers: { cookie: gina, "x-cora": "1" } })).status, 404, "another company never gets it");
});

test("a file's caption in another language than the agent's is left out, so the chat never switches language under a file", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  const posted = [];
  const ctx = (language) => ({ store: f.app.store, agent: { id: "ag_x", name: "Maya", ...(language ? { language } : {}) }, channelId: "web-ag_x", postFile: async (file, caption) => { posted.push(caption); } });
  const make = (caption, language) => executeTool({ name: "create_file", args: { name: "noto.html", content: "<p>Noto</p>", caption } }, ctx(language));
  await make("One-pager Noto aggiornata: prezzo 9 € e acquisto su letzgo.guide/noto.", "en");
  await make("Updated one-pager: 9 € and letzgo.guide/noto on every CTA.", "en");
  await make("Web de una página, con el precio y el enlace de compra.", "es");
  await make("Sito aggiornato: prezzo 9 € e acquisto su letzgo.guide/noto", "");
  await make("Noto", "en");
  assert.deepEqual(posted, ["", "Updated one-pager: 9 € and letzgo.guide/noto on every CTA.", "Web de una página, con el precio y el enlace de compra.", "Sito aggiornato: prezzo 9 € e acquisto su letzgo.guide/noto", "Noto"]);
  const schema = TOOL_DEFS.find((tool) => tool.name === "create_file").parameters.properties;
  assert.equal(Object.keys(schema)[0], "caption", "the caption is written before the file, while the message's language is in front of the model");
});

test("textLanguage tells Cora's four languages apart in a short line and stays silent when unsure", () => {
  assert.equal(textLanguage("Aggiornato: prezzo 9 € e link letzgo.guide/noto su tutti i pulsanti."), "it");
  assert.equal(textLanguage("Updated: the price and the buy link are now on every button."), "en");
  assert.equal(textLanguage("Actualizado: el precio y el enlace de compra en todos los botones."), "es");
  assert.equal(textLanguage("Aktualisiert: der Preis und der Link sind jetzt auf der Seite."), "de");
  assert.equal(textLanguage("noto.html"), "");
  assert.equal(textLanguage(""), "");
});
