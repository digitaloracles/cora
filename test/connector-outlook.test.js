import assert from "node:assert/strict";
import { test } from "node:test";
import { mailWorld } from "./mail-fixtures.js";
import { fakeGraph, fakeMicrosoftBroker } from "./outlook-fixtures.js";
import { outlook } from "../src/connectors/outlook.js";
import { toolFor } from "../src/connectors/index.js";

const NAMES = ["outlook_search", "outlook_read_message", "outlook_read_thread", "outlook_send", "outlook_reply", "outlook_create_draft", "outlook_list_drafts", "outlook_send_draft", "outlook_delete_draft", "outlook_modify", "outlook_list_folders", "outlook_download_attachment", "outlook_api"];

async function tools(t, { account = "ada@outlook.example", me } = {}) {
  const graph = await fakeGraph(t, { token: (value) => value === "at_fixture", ...(me ? { me } : {}) });
  const files = new Map([["/home/agent/work/report.pdf", Buffer.from("%PDF-1.4 report")], ["/home/agent/work/video.mp4", Buffer.alloc(7 * 1024 * 1024 + 123, 7)]]), written = new Map();
  const request = async (url, { method = "GET", headers = {}, body, raw } = {}) => {
    const response = await fetch(url, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data };
  };
  const ctx = (token = "at_fixture") => outlook.context({ token, request, api: { graph: graph.base }, record: { account },
    readFile: async (path) => { if (!files.has(path)) throw new Error("missing"); return files.get(path); }, writeFile: async (path, bytes) => { written.set(path, Buffer.from(bytes)); } });
  const run = async (name, args = {}, token) => { try { return await toolFor(name).run(args, ctx(token)); } catch (error) { return `error: ${error.message}`; } };
  return { ...graph, run, written };
}

test("the Outlook tools read, search and follow conversations on Graph", async (t) => {
  const g = await tools(t);
  assert.deepEqual(outlook.tools.map((tool) => tool.name), NAMES);
  const listed = await g.run("outlook_search", { unread: true, from: "anna@acme.it", after: "2026-11-01" });
  assert.deepEqual(listed.messages.map((item) => item.id), ["m1"]);
  assert.deepEqual(listed.messages[0], { id: "m1", conversation: "c1", from: "Anna Rossi <anna@acme.it>", to: ["ada@outlook.example"], subject: "Preventivo", date: "2026-11-24T10:00:00Z", snippet: "Ecco il preventivo", unread: true, attachments: true, categories: ["Clienti"], importance: "high" });
  const filtered = g.last("GET", "/me/messages").query;
  assert.equal(filtered.$filter, "receivedDateTime ge 2026-11-01T00:00:00Z and isRead eq false and from/emailAddress/address eq 'anna@acme.it'", "the sort property leads the filter, as Graph wants");
  assert.equal(filtered.$orderby, "receivedDateTime desc");

  const searched = await g.run("outlook_search", { query: "preventivo", folder: "Inbox", before: "2026-12-01", limit: 1 });
  const words = g.last("GET", "/me/mailFolders/inbox/messages").query;
  assert.equal(words.$search, "\"preventivo received<2026-12-01\"");
  assert.equal(words.$orderby, undefined, "Graph does not sort a search");
  assert.ok(searched.next_page.startsWith(g.base));
  assert.ok((await g.run("outlook_search", { page: searched.next_page })).messages);
  assert.match(await g.run("outlook_search", { page: "https://evil.example/v1.0/me/messages" }), /^error: page is the next_page/);
  assert.match(await g.run("outlook_search", { after: "ieri" }), /^error: after is a date/);
  await g.run("outlook_search", { folder: "Clienti" });
  assert.ok(g.calls.some((call) => call.path.startsWith("/me/mailFolders/AAMkClienti")), "a subfolder is found by its name");
  assert.match(await g.run("outlook_search", { folder: "Nessuna" }), /^error: no folder named "Nessuna"/);

  const read = await g.run("outlook_read_message", { message: "m1", max_chars: 12 });
  assert.equal(g.last("GET", "/me/messages/m1").headers.prefer, 'outlook.body-content-type="text"');
  assert.equal(read.text, "Ecco il prev\n[cut at 12 of 25 characters]");
  assert.deepEqual(read.attachments, [{ id: "att1", filename: "preventivo.pdf", type: "application/pdf", bytes: 9 }]);
  assert.equal(read.message_id, "<abc@acme.it>");
  const thread = await g.run("outlook_read_thread", { message: "m1" });
  assert.deepEqual(thread.messages.map((item) => item.id), ["m0", "m1"], "oldest first");
  assert.match(await g.run("outlook_read_message", { message: "../me" }), /^error: message is an Outlook id/);

  const saved = await g.run("outlook_download_attachment", { message: "m1", attachment: "preventivo" });
  assert.equal(saved.saved, "/home/agent/work/outlook/m1/preventivo.pdf");
  assert.equal(g.written.get(saved.saved).toString(), "PDF-BYTES");
  assert.match(await g.run("outlook_download_attachment", { message: "m1", attachment: "x", path: "/etc/passwd" }), /^error: no attachment "x".*preventivo\.pdf/);
  assert.match(await g.run("outlook_download_attachment", { message: "m1", attachment: "att1", path: "/etc/passwd" }), /^error: path must be inside/);

  const folders = await g.run("outlook_list_folders");
  assert.deepEqual(folders.folders[0], { id: "inbox", name: "Inbox", unread: 1, total: 2, subfolders: 1 });
  assert.deepEqual((await g.run("outlook_api", { path: "/me/mailFolders/inbox/messageRules" })).value, [{ id: "r1", displayName: "Clienti" }]);
  assert.match(await g.run("outlook_api", { path: "/users/boss/messages" }), /^error: path starts with \/me/);
  assert.match(await g.run("outlook_api", { path: "/me/../users" }), /^error: path starts with \/me/);

  assert.match(await g.run("outlook_read_message", { message: "m1" }, "at_old"), /^error: Microsoft refuses ada@outlook\.example: the owner reconnects it in Connettori/);
  assert.match(await g.run("outlook_read_message", { message: "forbidden" }), /^error: Microsoft does not allow this on ada@outlook\.example: Access is denied/);
  assert.match(await g.run("outlook_read_message", { message: "busy" }), /^error: Outlook limits the calls/);
});

test("the Outlook tools send, reply with the quote, keep drafts and upload large attachments in chunks", async (t) => {
  const g = await tools(t);
  const sent = await g.run("outlook_send", { to: ["Luca Bianchi <luca@acme.it>"], cc: "marco@acme.it", subject: "Ciao\nlà", body_text: "Riga 1\n<b>2</b>" });
  assert.deepEqual(sent, { sent: true, from: "ada@outlook.example", to: ["Luca Bianchi <luca@acme.it>"], subject: "Ciao là" });
  const mail = g.last("POST", "/me/sendMail").body;
  assert.equal(mail.saveToSentItems, true);
  assert.deepEqual(mail.message.toRecipients, [{ emailAddress: { address: "luca@acme.it", name: "Luca Bianchi" } }]);
  assert.equal(mail.message.body.content, "Riga 1<br>&lt;b&gt;2&lt;/b&gt;");
  assert.match(await g.run("outlook_send", { to: ["not an address"], subject: "x", body_text: "y" }), /^error: "not an address" is not an email address/);
  assert.match(await g.run("outlook_send", { to: ["a@b.it"], subject: "x" }), /^error: write body_html or body_text/);

  const withFiles = await g.run("outlook_send", { to: ["luca@acme.it"], subject: "File", body_html: "<p>Allegati</p>", attachments: ["/home/agent/work/report.pdf", "/home/agent/work/video.mp4"] });
  assert.equal(withFiles.attachments, 2);
  const delivered = g.db.sent.at(-1);
  assert.deepEqual(delivered.attachments.map((file) => [file.name, file.size]), [["report.pdf", 15], ["video.mp4", 7 * 1024 * 1024 + 123]]);
  assert.equal(Buffer.from(delivered.attachments[1].contentBytes, "base64").equals(Buffer.alloc(7 * 1024 * 1024 + 123, 7)), true, "the large file arrives whole");
  const chunks = g.calls.filter((call) => call.path.startsWith("/upload/"));
  assert.equal(chunks.length, 3, "the large file goes in chunks through the upload session");
  assert.ok(chunks.every((call) => !call.headers.authorization), "the upload address gets no token");

  const reply = await g.run("outlook_reply", { message: "m1", body_html: "<p>Grazie!</p>", reply_all: true });
  assert.deepEqual(reply.to, ["Anna Rossi <anna@acme.it>"]);
  const patched = g.calls.filter((call) => call.method === "PATCH").at(-1).body;
  assert.equal(patched.body.content, "<div><p>Grazie!</p></div><hr><b>From:</b> Anna<br>Ecco il preventivo.", "the new text sits above Outlook's quote");
  assert.ok(g.calls.some((call) => call.path === "/me/messages/m1/createReplyAll"));
  assert.equal(g.db.sent.at(-1).subject, "RE: Preventivo");

  const kept = await g.run("outlook_create_draft", { to: ["luca@acme.it"], subject: "Bozza", body_text: "Da rivedere", attachments: ["/home/agent/work/report.pdf"] });
  assert.match(kept.draft, /^d\d+$/);
  assert.equal(g.db.messages.get(kept.draft).attachments.length, 1);
  const answer = await g.run("outlook_create_draft", { message: "m1", body_text: "Risposta" });
  assert.equal(g.db.messages.get(answer.draft).subject, "RE: Preventivo");
  assert.deepEqual((await g.run("outlook_list_drafts")).drafts.map((item) => item.draft), [kept.draft, answer.draft]);
  assert.match(await g.run("outlook_send_draft", { draft: "m1" }), /^error: that message is not a draft/);
  assert.equal((await g.run("outlook_send_draft", { draft: kept.draft })).sent, true);
  assert.match(await g.run("outlook_delete_draft", { draft: "m1" }), /^error: that message is not a draft/);
  assert.equal((await g.run("outlook_delete_draft", { draft: answer.draft })).deleted, true);
  assert.equal(g.db.messages.has(answer.draft), false);

  const changed = await g.run("outlook_modify", { messages: ["m1"], read: true, flag: true, add_categories: ["Urgente"], remove_categories: ["clienti"], move_to: "archive" });
  assert.deepEqual(changed.changed, [{ message: "m1", moved_to: "archive", new_id: "m1moved" }]);
  assert.deepEqual(g.calls.filter((call) => call.method === "PATCH").at(-1).body, { isRead: true, flag: { flagStatus: "flagged" }, categories: ["Urgente"] });
  assert.equal(g.db.messages.get("m1moved").folder, "archive");
  assert.deepEqual((await g.run("outlook_modify", { messages: ["m0"], trash: true })).changed[0].moved_to, "deleteditems");
  assert.match(await g.run("outlook_modify", { messages: ["m0moved"] }), /^error: say what to change/);
});

test("a personal Microsoft account whose main address is not Outlook sends from its Outlook alias", async (t) => {
  const personal = await tools(t, { account: "radix@acme.example", me: { id: "957638715824a173", mail: "radix@acme.example" } });
  personal.db.messages.get("m1").toRecipients = [{ emailAddress: { address: "Radix.Cora@outlook.com" } }, { emailAddress: { address: "outlook_957638715824A173@outlook.com" } }];
  personal.db.messages.set("j1", { id: "j1", conversationId: "cj", subject: "Spam?", from: { emailAddress: { address: "anna@acme.it" } }, toRecipients: [{ emailAddress: { address: "radix.cora@outlook.com" } }], ccRecipients: [{ emailAddress: { address: "friend@hotmail.com" } }], isDraft: false, folder: "junkemail", attachments: [] });
  const sent = await personal.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x" });
  assert.equal(sent.from, "radix.cora@outlook.com");
  assert.deepEqual(personal.last("POST", "/me/sendMail").body.message.from, { emailAddress: { address: "radix.cora@outlook.com" } }, "Microsoft drops a send from the main address: the alias the mailbox receives at goes out");
  const reply = await personal.run("outlook_reply", { message: "m1", body_text: "Grazie" });
  assert.equal(reply.from, "radix.cora@outlook.com");
  assert.deepEqual(personal.calls.filter((call) => call.method === "PATCH").at(-1).body.from, { emailAddress: { address: "radix.cora@outlook.com" } });
  const kept = await personal.run("outlook_create_draft", { to: ["luca@acme.it"], subject: "Bozza", body_text: "x" });
  assert.deepEqual(personal.db.messages.get(kept.draft).from, { emailAddress: { address: "radix.cora@outlook.com" } });
  const chosen = await personal.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x", from: "radix@hotmail.com" });
  assert.equal(chosen.from, "radix@hotmail.com");
  assert.match(await personal.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x", from: "nope" }), /^error: from is one address of this mailbox/);

  const empty = await tools(t, { account: "radix@acme.example", me: { id: "957638715824a173" } });
  empty.db.messages.clear();
  assert.match(await empty.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x" }), /^error: radix@acme\.example is not an Outlook address.*pass from/);
  assert.equal(empty.db.sent.length, 0, "nothing leaves that Microsoft would drop");

  const work = await tools(t, { account: "bob@contoso.example", me: { id: "5f0c6a1e-2b7d-4c8e-9a1f-0e3d2c1b4a59" } });
  assert.equal((await work.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x" })).from, "bob@contoso.example");
  assert.equal(work.last("POST", "/me/sendMail").body.message.from, undefined, "a work account sends as itself");
  const outlookCom = await tools(t);
  await outlookCom.run("outlook_send", { to: ["luca@acme.it"], subject: "Ciao", body_text: "x" });
  assert.equal(outlookCom.calls.some((call) => call.path === "/me"), false, "an Outlook address needs no lookup");
});

test("an Outlook account connects through the broker, renews rotating tokens and is authorised per agent", async (t) => {
  const f = await mailWorld(t);
  const connectors = f.app.keyConnectors;
  const ms = await fakeMicrosoftBroker(t, { spaceOrigin: () => f.base });
  const graph = await fakeGraph(t, { token: ms.valid });
  const agent = f.app.store.createAgent({ name: "Mail agent", tools: false }), other = f.app.store.createAgent({ name: "Other agent", tools: false });

  const catalog = (await f.call("/api/connectors")).data.catalog.find((item) => item.id === "outlook");
  assert.deepEqual([catalog.name, catalog.multi.param, catalog.modes[0].rows[0].authorize, catalog.tools.length], ["Outlook", "account", "Accedi con Microsoft", 13]);
  const unavailable = await f.call("/api/connectors/keys/outlook/authorize?mode=oauth", { method: "POST" });
  assert.equal(unavailable.status, 409, "a Cora outside usecora.space has no broker");
  assert.match(unavailable.data.error, /usecora\.space/);
  Object.assign(connectors, { broker: ms.base, space: "acme", graphApi: graph.base });
  assert.equal((await f.call("/api/connectors/keys/outlook", { method: "POST", body: { mode: "oauth", clientId: "x", clientSecret: "y" } })).status, 400, "no app of one's own: the broker's");
  assert.equal((await f.call("/api/connectors/keys/outlook/authorize", { method: "POST", asMember: true })).status, 403);

  const connect = async (user, cookieNonce = null) => {
    const started = await f.call("/api/connectors/keys/outlook/authorize?mode=oauth", { method: "POST" });
    assert.equal(started.status, 200);
    const nonce = started.headers.get("set-cookie").match(/cora_oauth=([^;]+)/)[1];
    const start = new URL(started.data.url);
    assert.equal(`${start.origin}${start.pathname}`, `${ms.base}/connectors/microsoft/start`);
    assert.equal(start.searchParams.get("space"), "acme");
    assert.equal(start.searchParams.get("nonce"), nonce);
    const { authorize, back } = await ms.consent(started.data.url, user);
    assert.ok(back.startsWith(`${f.base}/connectors/microsoft/callback?`));
    const page = await fetch(back, { headers: { Cookie: `cora_oauth=${cookieNonce ?? nonce}` } });
    return { page, body: await page.text(), authorize };
  };
  const forged = await connect("ada", "someone-else");
  assert.equal(forged.page.status, 400, "the browser that started it must finish it");
  const first = await connect("ada");
  assert.equal(first.page.status, 200, first.body);
  assert.match(first.body, /Outlook autorizzato/);
  assert.ok(!first.authorize.href.includes("microsoft-secret"));
  let records = (await f.call("/api/connectors")).data.keyConnectors.filter((item) => item.service === "outlook");
  assert.deepEqual(records.map((item) => [item.status, item.mode, item.account, item.accountName, item.secretName, item.scope]), [["connected", "oauth", "ada@outlook.example", "Ada Outlook", "CORA_OUTLOOK_TOKEN", "User.Read Mail.ReadWrite Mail.Send"]]);
  assert.doesNotMatch(JSON.stringify(records), /at_|rt_|grant/);
  const stored = () => JSON.parse(f.app.vault.value(f.app.store.vaultSecret("CORA_OUTLOOK_TOKEN")).toString("utf8"));
  assert.match(stored().refresh_token, /^rt_/);
  assert.match(stored().grant, /^cora\./);

  assert.deepEqual(connectors.toolsFor(agent).filter((tool) => tool.name.startsWith("outlook_")), [], "nobody uses it before the owner picks the agents");
  assert.equal((await f.call(`/api/connectors/keys/outlook?connection=${records[0].id}`, { method: "PUT", body: { agents: [agent.id] } })).status, 200);
  assert.deepEqual(connectors.toolsFor(agent).filter((tool) => tool.name.startsWith("outlook_")).map((tool) => tool.name), NAMES);
  assert.deepEqual(connectors.toolsFor(other).filter((tool) => tool.name.startsWith("outlook_")), []);
  const read = JSON.parse((await connectors.runTool(agent, "outlook_read_message", { message: "m1" })).text);
  assert.equal(read.subject, "Preventivo");
  assert.match((await connectors.runTool(other, "outlook_read_message", { message: "m1" })).text, /^error: you are not authorised for Outlook/);

  const before = stored();
  connectors.access.clear();
  f.app.vault.put({ name: "CORA_OUTLOOK_TOKEN", value: JSON.stringify({ ...before, expires_at: Date.now() - 1000 }), agents: [agent.id], by: null, source: "connector" });
  ms.expire();
  assert.equal(JSON.parse((await connectors.runTool(agent, "outlook_read_message", { message: "m1" })).text).id, "m1", "an expired access token is renewed through the broker");
  const after = stored();
  assert.notEqual(after.refresh_token, before.refresh_token, "Microsoft's new refresh token is kept at once");
  assert.notEqual(after.grant, before.grant);
  assert.equal(ms.refresh.has(before.refresh_token), false);

  const again = await connect("ada");
  assert.equal(again.page.status, 200, "connecting the same account again renews it in place");
  const second = await connect("bob");
  assert.equal(second.page.status, 200, second.body);
  records = (await f.call("/api/connectors")).data.keyConnectors.filter((item) => item.service === "outlook");
  assert.deepEqual(records.map((item) => item.account).sort(), ["ada@outlook.example", "bob@contoso.example"]);
  assert.deepEqual(records.find((item) => item.account === "ada@outlook.example").agents, [agent.id], "the renewal keeps its agents");
  const bob = records.find((item) => item.account === "bob@contoso.example");
  assert.notEqual(bob.secretName, "CORA_OUTLOOK_TOKEN");
  await f.call(`/api/connectors/keys/outlook?connection=${bob.id}`, { method: "PUT", body: { agents: [agent.id] } });
  const search = connectors.toolsFor(agent).find((tool) => tool.name === "outlook_search");
  assert.deepEqual(search.parameters.properties.account.enum.sort(), ["ada@outlook.example", "bob@contoso.example"]);
  assert.deepEqual(search.parameters.required, ["account"]);
  assert.match((await connectors.runTool(agent, "outlook_search", {})).text, /^error: choose account explicitly/);
  assert.ok(JSON.parse((await connectors.runTool(agent, "outlook_search", { account: "bob@contoso.example" })).text).messages);

  assert.equal((await f.call(`/api/connectors/keys/outlook?connection=${bob.id}`, { method: "DELETE" })).status, 200);
  assert.equal(f.app.store.vaultSecret(bob.secretName), null);
  assert.ok(f.app.store.vaultSecret("CORA_OUTLOOK_TOKEN"), "the other account stays");
});
