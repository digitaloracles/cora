import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { MicrosoftConnectorBroker } from "../cloud/src/microsoft-connector.js";

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(status === 202 || status === 204 ? "" : JSON.stringify(body)); };
const listen = async (server, t) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t?.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
};

/** A small Outlook mailbox behind Microsoft Graph: folders, messages, drafts, attachments and upload sessions. */
export async function fakeGraph(t, { token = () => true } = {}) {
  const calls = [];
  const db = {
    folders: [{ id: "inbox", displayName: "Inbox", unreadItemCount: 1, totalItemCount: 2, childFolderCount: 1 }, { id: "drafts", displayName: "Drafts", totalItemCount: 0 }, { id: "deleteditems", displayName: "Deleted Items" }, { id: "archive", displayName: "Archive" }],
    children: { inbox: [{ id: `AAMkClienti${"x".repeat(60)}`, displayName: "Clienti" }] },
    messages: new Map([
      ["m1", { id: "m1", conversationId: "c1", subject: "Preventivo", from: { emailAddress: { name: "Anna Rossi", address: "anna@acme.it" } }, toRecipients: [{ emailAddress: { address: "ada@outlook.example" } }], receivedDateTime: "2026-11-24T10:00:00Z", bodyPreview: "Ecco il preventivo", isRead: false, isDraft: false, flag: { flagStatus: "notFlagged" }, hasAttachments: true, categories: ["Clienti"], importance: "high", internetMessageId: "<abc@acme.it>", body: { contentType: "text", content: "Ecco il preventivo.\r\n\r\n\r\n\r\nAnna" }, attachments: [{ id: "att1", name: "preventivo.pdf", contentType: "application/pdf", size: 9, contentBytes: Buffer.from("PDF-BYTES").toString("base64") }], folder: "inbox" }],
      ["m0", { id: "m0", conversationId: "c1", subject: "Richiesta", from: { emailAddress: { address: "ada@outlook.example" } }, toRecipients: [{ emailAddress: { address: "anna@acme.it" } }], receivedDateTime: "2026-11-23T09:00:00Z", isRead: true, isDraft: false, body: { contentType: "text", content: "Mi mandi il preventivo?" }, folder: "sentitems" }],
    ]),
    uploads: new Map(), sent: [], serial: 0,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const body = String(req.headers["content-type"] || "").includes("json") && raw.length ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, headers: req.headers, size: raw.length });
    let m;
    if ((m = path.match(/^\/upload\/(\w+)$/))) {
      if (req.headers.authorization) return json(res, 400, { error: { message: "upload URLs are pre-authenticated" } });
      const upload = db.uploads.get(m[1]);
      const [, from, to, total] = String(req.headers["content-range"]).match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
      if (from !== upload.received || to - from + 1 !== raw.length || total !== upload.size) return json(res, 416, {});
      upload.received += raw.length;
      upload.parts.push(raw);
      if (upload.received === upload.size) { db.messages.get(upload.message).attachments.push({ id: `att${++db.serial}`, name: upload.name, size: upload.size, contentBytes: Buffer.concat(upload.parts).toString("base64") }); return json(res, 201, {}); }
      return json(res, 200, { nextExpectedRanges: [`${upload.received}-`] });
    }
    if (!token(String(req.headers.authorization || "").replace(/^Bearer /, ""))) return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } });
    if (path === "/me/messages/forbidden") return json(res, 403, { error: { message: "Access is denied." } });
    if (path === "/me/messages/busy") return json(res, 429, { error: { message: "Too many requests" } });
    if (path === "/me/mailFolders" && req.method === "GET") return json(res, 200, { value: db.folders });
    if ((m = path.match(/^\/me\/mailFolders\/([^/]+)\/childFolders$/))) return json(res, 200, { value: db.children[decodeURIComponent(m[1])] || [] });
    const list = (items) => json(res, 200, { value: items, ...(items.length && url.searchParams.get("$top") === "1" ? { "@odata.nextLink": `${url.origin}/v1.0${path}?$skiptoken=next` } : {}) });
    if (path === "/me/messages" && req.method === "GET") {
      const filter = url.searchParams.get("$filter") || "";
      const conversation = filter.match(/conversationId eq '([^']+)'/)?.[1];
      return list([...db.messages.values()].filter((item) => !item.isDraft && (!conversation || item.conversationId === conversation) && (!/isRead eq false/.test(filter) || !item.isRead)));
    }
    if ((m = path.match(/^\/me\/mailFolders\/([^/]+)\/messages$/)) && req.method === "GET") return list([...db.messages.values()].filter((item) => item.folder === decodeURIComponent(m[1]) || (m[1] === "drafts" && item.isDraft)));
    if (path === "/me/sendMail") { db.sent.push(body.message); return json(res, 202); }
    if (path === "/me/messages" && req.method === "POST") {
      const id = `d${++db.serial}`;
      db.messages.set(id, { ...body, id, conversationId: `c${id}`, isDraft: true, attachments: [], folder: "drafts" });
      return json(res, 201, db.messages.get(id));
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)\/(createReply|createReplyAll)$/))) {
      const original = db.messages.get(m[1]), id = `d${++db.serial}`;
      const to = m[2] === "createReplyAll" ? [original.from, ...original.toRecipients.filter((item) => item.emailAddress.address !== "ada@outlook.example")] : [original.from];
      db.messages.set(id, { id, conversationId: original.conversationId, isDraft: true, subject: `RE: ${original.subject}`, toRecipients: to, body: { contentType: "html", content: "<hr><b>From:</b> Anna<br>Ecco il preventivo." }, attachments: [], folder: "drafts" });
      return json(res, 201, db.messages.get(id));
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)\/attachments\/createUploadSession$/))) {
      const id = `u${++db.serial}`;
      db.uploads.set(id, { message: m[1], name: body.AttachmentItem.name, size: body.AttachmentItem.size, received: 0, parts: [] });
      return json(res, 201, { uploadUrl: `${url.origin}/upload/${id}` });
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)\/attachments$/))) {
      const message = db.messages.get(m[1]);
      if (req.method === "POST") { message.attachments.push({ ...body, id: `att${++db.serial}`, size: Buffer.from(body.contentBytes, "base64").length }); return json(res, 201, {}); }
      return json(res, 200, { value: message.attachments.map(({ contentBytes, ...rest }) => rest) });
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)\/attachments\/(\w+)$/))) return json(res, 200, db.messages.get(m[1]).attachments.find((item) => item.id === m[2]));
    if ((m = path.match(/^\/me\/messages\/(\w+)\/send$/))) {
      const message = db.messages.get(m[1]);
      if (!message?.isDraft) return json(res, 400, { error: { message: "not a draft" } });
      db.sent.push(message); db.messages.delete(m[1]);
      return json(res, 202);
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)\/move$/))) {
      const message = db.messages.get(m[1]), id = `${m[1]}moved`;
      db.messages.delete(m[1]); db.messages.set(id, { ...message, id, folder: body.destinationId });
      return json(res, 201, db.messages.get(id));
    }
    if ((m = path.match(/^\/me\/messages\/(\w+)$/))) {
      const message = db.messages.get(m[1]);
      if (!message) return json(res, 404, { error: { message: "The specified object was not found in the store." } });
      if (req.method === "PATCH") { Object.assign(message, body); return json(res, 200, message); }
      if (req.method === "DELETE") { db.messages.delete(m[1]); return json(res, 204); }
      const { attachments, ...rest } = message;
      return json(res, 200, { ...rest, ...(url.searchParams.get("$expand") ? { attachments: attachments.map(({ contentBytes, ...file }) => file) } : {}) });
    }
    if (path === "/me/mailFolders/inbox/messageRules") return json(res, 200, { value: [{ id: "r1", displayName: "Clienti" }] });
    return json(res, 404, { error: { message: `no route ${req.method} ${path}` } });
  });
  const base = await listen(server, t);
  return { base: `${base}/v1.0`, calls, db, last: (method, path) => calls.filter((call) => call.method === method && call.path === path).at(-1) };
}

/** Microsoft's sign-in (token endpoint and Graph /me) and usecora.space's broker in front of it. */
export async function fakeMicrosoftBroker(t, { spaceOrigin }) {
  const codes = new Map(), refresh = new Map(), access = new Set(), calls = [];
  const users = { ada: { id: "ms-ada", displayName: "Ada Outlook", mail: null, userPrincipalName: "Ada@Outlook.example" }, bob: { id: "ms-bob", displayName: "Bob", mail: "bob@contoso.example", userPrincipalName: "bob@contoso.example" } };
  const holders = new Map();
  const microsoft = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const url = new URL(req.url, "http://x");
    calls.push({ path: url.pathname, fields });
    const issue = (user) => {
      const token = `at_${randomBytes(6).toString("hex")}`, next = `rt_${randomBytes(6).toString("hex")}`;
      access.add(token); holders.set(token, user); refresh.set(next, user);
      return json(res, 200, { access_token: token, refresh_token: next, expires_in: 3599, scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email" });
    };
    if (url.pathname === "/token") {
      if (fields.client_secret !== "microsoft-secret") return json(res, 401, {});
      if (fields.grant_type === "authorization_code") {
        const grant = codes.get(fields.code);
        if (!grant || createHash("sha256").update(fields.code_verifier || "").digest("base64url") !== grant.challenge) return json(res, 400, { error: "invalid_grant" });
        codes.delete(fields.code);
        return issue(grant.user);
      }
      const user = refresh.get(fields.refresh_token);
      if (!user) return json(res, 400, { error: "invalid_grant" });
      refresh.delete(fields.refresh_token);
      return issue(user);
    }
    if (url.pathname === "/me") {
      const user = holders.get(String(req.headers.authorization).replace(/^Bearer /, ""));
      return user ? json(res, 200, users[user]) : json(res, 401, {});
    }
    json(res, 404, {});
  });
  const microsoftBase = await listen(microsoft, t);
  const broker = new MicrosoftConnectorBroker({ origin: "http://broker.invalid", key: randomBytes(32), clientId: "microsoft-id", clientSecret: "microsoft-secret", spaceOrigin: (slug) => (slug === "acme" ? spaceOrigin() : null),
    endpoints: { authorize: `${microsoftBase}/authorize`, token: `${microsoftBase}/token`, me: `${microsoftBase}/me` } });
  const brokerCalls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://broker");
    brokerCalls.push(url.pathname);
    try {
      if (url.pathname === "/connectors/microsoft/start") { res.writeHead(302, { Location: broker.start(Object.fromEntries(url.searchParams)) }); return res.end(); }
      if (url.pathname === "/connectors/microsoft/callback") { res.writeHead(302, { Location: broker.callback(Object.fromEntries(url.searchParams)) }); return res.end(); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks));
      return json(res, 200, await broker[url.pathname.endsWith("exchange") ? "exchange" : "refresh"](data));
    } catch { return json(res, 400, { error: "refused" }); }
  });
  const base = await listen(server, t);
  /** The owner on Microsoft: the broker's page, the account chosen, and the address it sends the browser back to. */
  const consent = async (startUrl, user = "ada") => {
    const toMicrosoft = new URL((await fetch(startUrl, { redirect: "manual" })).headers.get("location"));
    const code = `code_${randomBytes(4).toString("hex")}`;
    codes.set(code, { challenge: toMicrosoft.searchParams.get("code_challenge"), user });
    const back = await fetch(`${base}/connectors/microsoft/callback?${new URLSearchParams({ state: toMicrosoft.searchParams.get("state"), code })}`, { redirect: "manual" });
    return { authorize: toMicrosoft, back: back.headers.get("location") };
  };
  return { base, consent, calls, brokerCalls, valid: (token) => access.has(token), expire: () => access.clear(), refresh };
}
