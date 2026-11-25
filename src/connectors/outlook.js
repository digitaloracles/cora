import { count, defined, fail, list, localFile, pick, text } from "./tooling.js";

/**
 * Outlook: Microsoft mailboxes (Outlook.com, Hotmail, Live, Microsoft 365) connected through
 * Cora's broker on usecora.space, which holds the secret of Cora's own Entra app. Each account
 * is authorised for chosen agents, who get one tool per action on Microsoft Graph; Cora renews
 * the access token with the refresh token in the vault, the agent never holds either.
 */
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;
const ADDRESS = /^(?:"?([^"<>\r\n]{0,200})"?\s*)?<([^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,})>$/i;
const WELL_KNOWN = ["inbox", "drafts", "sentitems", "deleteditems", "junkemail", "archive", "outbox"];
const SUMMARY = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,isDraft,flag,hasAttachments,categories,importance";
const SMALL = 3 * 1024 * 1024, CHUNK = 10 * 327680;
const MAX_TOTAL = 100 * 1024 * 1024;

/** One recipient as the agent wrote it ("a@b.it" or "Name <a@b.it>"), as Graph takes it. */
function recipient(value) {
  const raw = text(value, 400);
  if (EMAIL.test(raw)) return { emailAddress: { address: raw } };
  const match = raw.match(ADDRESS);
  if (!match) fail(`"${raw.slice(0, 80)}" is not an email address`);
  const name = match[1]?.trim();
  return { emailAddress: defined({ address: match[2], name: name || undefined }) };
}
const recipients = (value, what, { required = false } = {}) => {
  const items = list(value).map(recipient);
  if (required && !items.length) fail(`${what} needs at least one address`);
  if (items.length > 100) fail(`${what} takes at most 100 addresses`);
  return items;
};
const shown = (item) => item?.emailAddress ? (item.emailAddress.name && item.emailAddress.name !== item.emailAddress.address ? `${item.emailAddress.name} <${item.emailAddress.address}>` : item.emailAddress.address) : undefined;
const shownList = (items) => (items?.length ? items.map(shown) : undefined);
const escapeHtml = (value) => value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const ID = (value, what) => {
  const id = text(value, 400);
  if (!/^[A-Za-z0-9_=+/-]+$/.test(id)) fail(`${what} is an Outlook id, as outlook_search answers it`);
  return encodeURIComponent(id);
};

/** The few fields an agent needs of a message in a list. */
const summary = (message) => defined({
  id: message.id, conversation: message.conversationId, from: shown(message.from), to: shownList(message.toRecipients), cc: shownList(message.ccRecipients),
  subject: message.subject ?? "", date: message.receivedDateTime, snippet: message.bodyPreview || undefined,
  unread: message.isRead === false, draft: message.isDraft || undefined, flagged: message.flag?.flagStatus === "flagged" || undefined,
  attachments: message.hasAttachments || undefined, categories: message.categories?.length ? message.categories : undefined,
  importance: message.importance && message.importance !== "normal" ? message.importance : undefined,
});
const cut = (body, max) => (body.length > max ? `${body.slice(0, max)}\n[cut at ${max} of ${body.length} characters]` : body);
const readable = (message, max) => defined({
  ...summary(message), snippet: undefined, bcc: shownList(message.bccRecipients), reply_to: shownList(message.replyTo), message_id: message.internetMessageId || undefined,
  text: cut(String(message.body?.content || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), max),
  attachments: message.attachments?.length ? message.attachments.map((file) => defined({ id: file.id, filename: file.name, type: file.contentType, bytes: file.size, inline: file.isInline || undefined })) : undefined,
});

/** Graph with the account's token: answers the JSON, or refuses with a message the agent can act on. */
export function client(ctx) {
  const base = String(ctx.api?.graph || "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
  const account = ctx.record?.account || "the account";
  const call = async (method, path, { query, body, headers = {}, text: asText = false } = {}) => {
    const url = new URL(path.startsWith("https://") || path.startsWith("http://") ? path : `${base}${path}`);
    if (url.origin !== new URL(base).origin) fail("that address is not Microsoft Graph");
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    const answer = await ctx.request(url.href, { method, headers: { Authorization: `Bearer ${ctx.token}`, ...(asText ? { Prefer: 'outlook.body-content-type="text"' } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body, timeout: 120000 });
    const reason = answer.data?.error?.message ? `: ${String(answer.data.error.message).slice(0, 600)}` : "";
    if (answer.status === 401) fail(`Microsoft refuses ${account}: the owner reconnects it in Connettori`);
    if (answer.status === 403) fail(`Microsoft does not allow this on ${account}${reason}`);
    if (answer.status === 404) fail(`Outlook found nothing there${reason}: check the id`);
    if (answer.status === 429) fail("Outlook limits the calls: try again in a minute");
    if (answer.status < 200 || answer.status >= 300) fail(`Outlook answered ${answer.status}${reason}`);
    return answer.data ?? {};
  };
  /** A folder by well-known name, id or display name (top level, then one level down). */
  const folder = async (value) => {
    const wanted = text(value, 400);
    if (!wanted) return null;
    if (WELL_KNOWN.includes(wanted.toLowerCase().replace(/[\s_-]/g, ""))) return wanted.toLowerCase().replace(/[\s_-]/g, "");
    if (wanted.length > 60 && /^[A-Za-z0-9_=+/-]+$/.test(wanted)) return wanted;
    const { value: top = [] } = await call("GET", "/me/mailFolders", { query: { $top: 200, $select: "id,displayName,childFolderCount" } });
    let candidates = top;
    if (!top.some((item) => item.displayName.toLowerCase() === wanted.toLowerCase())) {
      for (const parent of top.filter((item) => item.childFolderCount).slice(0, 20)) {
        const { value: children = [] } = await call("GET", `/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders`, { query: { $top: 200, $select: "id,displayName" } });
        candidates = candidates.concat(children.map((child) => ({ ...child, displayName: child.displayName, parent: parent.displayName })));
      }
    }
    return pick(candidates, wanted, { what: "folder", name: "displayName" }).id;
  };
  return { call, folder, base };
}

/** The message an agent composed: checked recipients, an HTML body, attachments read from its computer. */
async function composed(args, ctx, { needTo = true } = {}) {
  const to = recipients(args.to, "to", { required: needTo }), cc = recipients(args.cc, "cc"), bcc = recipients(args.bcc, "bcc");
  if (to.length + cc.length + bcc.length > 150) fail("at most 150 recipients in all");
  const subject = text(args.subject, 500).replace(/[\r\n]+/g, " ");
  if (!subject && needTo) fail("subject is required");
  const html = String(args.body_html || ""), plain = String(args.body_text || "");
  if (!html && !plain) fail("write body_html or body_text");
  if (html.length + plain.length > 2000000) fail("the message is too long");
  const files = [];
  let total = 0;
  for (const path of list(args.attachments).slice(0, 20)) {
    const file = await localFile({ path }, ctx, { max: MAX_TOTAL });
    total += file.bytes.length;
    if (total > MAX_TOTAL) fail("attachments exceed 100 MB in all: share a link instead");
    files.push(file);
  }
  return { to, cc, bcc, subject, files, html: html || escapeHtml(plain).replace(/\n/g, "<br>") };
}

/** Attaches files to a draft: small ones whole, large ones through an upload session in chunks. */
async function attach(ctx, graph, draftId, files) {
  for (const file of files) {
    if (file.bytes.length <= SMALL) {
      await graph.call("POST", `/me/messages/${draftId}/attachments`, { body: { "@odata.type": "#microsoft.graph.fileAttachment", name: file.filename, contentType: file.contentType, contentBytes: file.bytes.toString("base64") } });
      continue;
    }
    const session = await graph.call("POST", `/me/messages/${draftId}/attachments/createUploadSession`, { body: { AttachmentItem: { attachmentType: "file", name: file.filename, size: file.bytes.length, contentType: file.contentType } } });
    const upload = new URL(String(session.uploadUrl || ""));
    if (upload.protocol !== "https:" && upload.origin !== new URL(graph.base).origin) fail("Outlook answered an upload address that is not secure");
    if (upload.origin !== new URL(graph.base).origin && !/(^|\.)(office|office365|outlook)\.com$/i.test(upload.hostname)) fail("Outlook answered an upload address on another host");
    for (let start = 0; start < file.bytes.length; start += CHUNK) {
      const part = file.bytes.subarray(start, Math.min(start + CHUNK, file.bytes.length));
      const answer = await ctx.request(upload.href, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${start + part.length - 1}/${file.bytes.length}` }, raw: part, timeout: 300000 });
      if (answer.status < 200 || answer.status >= 300) fail(`Outlook refused the attachment ${file.filename} (${answer.status})`);
    }
  }
}

/** A draft with the composed message: new, or a reply (all) to a message, whose quote it keeps under the new text. */
async function draft(ctx, graph, message, { reply = "", replyAll = false } = {}) {
  let created;
  if (reply) {
    created = await graph.call("POST", `/me/messages/${reply}/${replyAll ? "createReplyAll" : "createReply"}`, { body: {} });
    const patch = defined({ body: { contentType: "HTML", content: `<div>${message.html}</div>${created.body?.contentType === "html" || created.body?.contentType === "HTML" ? created.body.content || "" : escapeHtml(String(created.body?.content || "")).replace(/\n/g, "<br>")}` },
      toRecipients: message.to.length ? message.to : undefined, ccRecipients: message.cc.length ? message.cc : undefined, bccRecipients: message.bcc.length ? message.bcc : undefined, subject: message.subject || undefined });
    created = await graph.call("PATCH", `/me/messages/${encodeURIComponent(created.id)}`, { body: patch });
  } else {
    created = await graph.call("POST", "/me/messages", { body: { subject: message.subject, body: { contentType: "HTML", content: message.html }, toRecipients: message.to, ccRecipients: message.cc, bccRecipients: message.bcc } });
  }
  if (!created?.id) fail("Outlook did not create the draft");
  if (message.files.length) await attach(ctx, graph, encodeURIComponent(created.id), message.files);
  return created;
}

const ACCOUNT_NOTE = "Agents act as the connected Microsoft account.";
const SEND_RULE = "Send only what the person asked for, to the recipients they named; a send is final, so never retry one whose result is uncertain: check Sent Items or ask first.";
const COMPOSE = {
  to: { type: "array", items: { type: "string" }, description: "recipients: \"a@b.it\" or \"Name <a@b.it>\"" },
  cc: { type: "array", items: { type: "string" } },
  bcc: { type: "array", items: { type: "string" } },
  subject: { type: "string" },
  body_html: { type: "string", description: "the message as HTML" },
  body_text: { type: "string", description: "the message as plain text; give this or body_html" },
  attachments: { type: "array", items: { type: "string" }, description: "absolute paths of files on your computer to attach, e.g. /home/agent/work/report.pdf (at most 100 MB in all)" },
};
const FOLDER = { type: "string", description: "a folder: inbox, drafts, sentitems, deleteditems, junkemail, archive, a folder's name or its id" };
const message = { type: "string", description: "the message id from outlook_search" };

const TOOLS = [
  {
    name: "outlook_search",
    description: `Outlook: search the mailbox, newest first: words (Outlook search syntax: from:, to:, subject:, hasattachments:true, received>=2026-11-01, "exact words"), folder, unread only, sender, dates. Answers sender, subject, date, preview and ids; read one with outlook_read_message or outlook_read_thread. ${ACCOUNT_NOTE}`,
    parameters: { type: "object", properties: {
      query: { type: "string", description: "optional words to search for" }, folder: FOLDER,
      unread: { type: "boolean", description: "only unread messages" }, from: { type: "string", description: "only from this address" },
      after: { type: "string", description: "YYYY-MM-DD: received on or after" }, before: { type: "string", description: "YYYY-MM-DD: received before" },
      limit: { type: "number", description: "default 20, at most 50" }, page: { type: "string", description: "the next_page of the previous answer" },
    } },
    summarize: (args) => [args.folder, args.query && JSON.stringify(String(args.query).slice(0, 60))].filter(Boolean).join(" · "),
    async run(args, ctx) {
      const graph = ctx.outlook, limit = count(args.limit, 20, 50);
      let data;
      if (args.page) {
        const page = text(args.page, 4000);
        if (!page.startsWith(`${graph.base}/me/`)) fail("page is the next_page of a previous outlook_search");
        data = await graph.call("GET", page);
      } else {
        const where = args.folder ? `/me/mailFolders/${encodeURIComponent(await graph.folder(args.folder))}/messages` : "/me/messages";
        const day = (value, what) => { const raw = text(value, 40); if (!raw) return ""; if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) fail(`${what} is a date like 2026-11-01`); return raw; };
        const after = day(args.after, "after"), before = day(args.before, "before"), from = text(args.from, 320);
        if (from && !EMAIL.test(from)) fail("from is one email address");
        const query = text(args.query, 1000);
        if (query) {
          const words = [query, from && `from:${from}`, after && `received>=${after}`, before && `received<${before}`].filter(Boolean).join(" ").replace(/"/g, "\\\"");
          data = await graph.call("GET", where, { query: { $search: `"${words}"`, $top: limit, $select: SUMMARY } });
          if (args.unread) data.value = (data.value || []).filter((item) => item.isRead === false);
        } else {
          const filter = [`receivedDateTime ge ${after ? `${after}T00:00:00Z` : "1900-01-01T00:00:00Z"}`, before && `receivedDateTime lt ${before}T00:00:00Z`, args.unread && "isRead eq false", from && `from/emailAddress/address eq '${from.replace(/'/g, "''")}'`].filter(Boolean).join(" and ");
          data = await graph.call("GET", where, { query: { $filter: filter, $orderby: "receivedDateTime desc", $top: limit, $select: SUMMARY } });
        }
      }
      return defined({ messages: (data.value || []).map(summary), next_page: data["@odata.nextLink"] || undefined });
    },
  },
  {
    name: "outlook_read_message",
    description: "Outlook: read one message: sender, recipients, date, text (HTML turned to text by Outlook), attachments and its Message-ID. Reading does not mark it read: outlook_modify does.",
    parameters: { type: "object", properties: { message, max_chars: { type: "number", description: "text kept, default 30000" } }, required: ["message"] },
    async run(args, ctx) {
      const id = ID(args.message, "message");
      const data = await ctx.outlook.call("GET", `/me/messages/${id}`, { text: true, query: { $select: `${SUMMARY},bccRecipients,replyTo,internetMessageId,body`, $expand: "attachments($select=id,name,contentType,size,isInline)" } });
      return readable(data, count(args.max_chars, 30000, 100000));
    },
  },
  {
    name: "outlook_read_thread",
    description: "Outlook: read a whole conversation, oldest first: every message with sender, recipients, date, text and attachments. Give the conversation id, or a message of it.",
    parameters: { type: "object", properties: { conversation: { type: "string", description: "the conversation id from outlook_search" }, message: { type: "string", description: "or a message of the conversation" }, max_chars: { type: "number", description: "text kept per message, default 8000" } } },
    async run(args, ctx) {
      const graph = ctx.outlook;
      let conversation = text(args.conversation, 400);
      if (!conversation && args.message) conversation = (await graph.call("GET", `/me/messages/${ID(args.message, "message")}`, { query: { $select: "conversationId" } })).conversationId;
      if (!conversation || /[\r\n']/.test(conversation)) fail("give conversation or message");
      const { value = [] } = await graph.call("GET", "/me/messages", { text: true, query: { $filter: `conversationId eq '${conversation}'`, $top: 50, $select: `${SUMMARY},body`, $expand: "attachments($select=id,name,contentType,size,isInline)" } });
      const max = count(args.max_chars, 8000, 50000);
      return { conversation, messages: value.sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime))).map((item) => readable(item, max)) };
    },
  },
  {
    name: "outlook_send",
    description: `Outlook: send a new message from the account, with files from your computer as attachments. To answer a message use outlook_reply, which keeps the conversation. ${SEND_RULE}`,
    parameters: { type: "object", properties: COMPOSE, required: ["to", "subject"] },
    summarize: (args) => `to ${list(args.to).slice(0, 3).join(", ")}`.slice(0, 200),
    async run(args, ctx) {
      const graph = ctx.outlook, composedMessage = await composed(args, ctx);
      if (!composedMessage.files.length) {
        await graph.call("POST", "/me/sendMail", { body: { message: { subject: composedMessage.subject, body: { contentType: "HTML", content: composedMessage.html }, toRecipients: composedMessage.to, ccRecipients: composedMessage.cc, bccRecipients: composedMessage.bcc }, saveToSentItems: true } });
      } else {
        const created = await draft(ctx, graph, composedMessage);
        await graph.call("POST", `/me/messages/${encodeURIComponent(created.id)}/send`);
      }
      return defined({ sent: true, from: ctx.record.account, to: composedMessage.to.map(shown), subject: composedMessage.subject, attachments: composedMessage.files.length || undefined });
    },
  },
  {
    name: "outlook_reply",
    description: `Outlook: reply to a message in its conversation, quoting it: to its sender, or with reply_all to every recipient. to, cc and subject override Outlook's. ${SEND_RULE}`,
    parameters: { type: "object", properties: { message, reply_all: { type: "boolean" }, ...COMPOSE }, required: ["message"] },
    summarize: (args) => `message ${String(args.message).slice(0, 60)}`,
    async run(args, ctx) {
      const id = ID(args.message, "message"), composedMessage = await composed(args, ctx, { needTo: false });
      const created = await draft(ctx, ctx.outlook, composedMessage, { reply: id, replyAll: Boolean(args.reply_all) });
      await ctx.outlook.call("POST", `/me/messages/${encodeURIComponent(created.id)}/send`);
      return { sent: true, from: ctx.record.account, to: shownList(created.toRecipients), subject: created.subject };
    },
  },
  {
    name: "outlook_create_draft",
    description: "Outlook: save a draft without sending it, with attachments from your computer; with message it is a reply (reply_all for everyone) in that conversation. The person can review and send it from Outlook, or you send it with outlook_send_draft when they say so.",
    parameters: { type: "object", properties: { message: { type: "string", description: "optional: the message id this draft answers" }, reply_all: { type: "boolean" }, ...COMPOSE } },
    async run(args, ctx) {
      const reply = args.message ? ID(args.message, "message") : "";
      const composedMessage = await composed(args, ctx, { needTo: !reply });
      const created = await draft(ctx, ctx.outlook, composedMessage, { reply, replyAll: Boolean(args.reply_all) });
      return { draft: created.id, to: shownList(created.toRecipients), subject: created.subject };
    },
  },
  {
    name: "outlook_list_drafts",
    description: "Outlook: the drafts of the account, newest first, with recipients and subject.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "default 20, at most 50" } } },
    async run(args, ctx) {
      const { value = [] } = await ctx.outlook.call("GET", "/me/mailFolders/drafts/messages", { query: { $top: count(args.limit, 20, 50), $select: "id,subject,toRecipients,ccRecipients,lastModifiedDateTime,hasAttachments,bodyPreview", $orderby: "lastModifiedDateTime desc" } });
      return { drafts: value.map((item) => defined({ draft: item.id, to: shownList(item.toRecipients), cc: shownList(item.ccRecipients), subject: item.subject ?? "", changed: item.lastModifiedDateTime, preview: item.bodyPreview || undefined, attachments: item.hasAttachments || undefined })) };
    },
  },
  {
    name: "outlook_send_draft",
    description: `Outlook: send a saved draft as it is. ${SEND_RULE}`,
    parameters: { type: "object", properties: { draft: { type: "string", description: "the draft id from outlook_list_drafts or outlook_create_draft" } }, required: ["draft"] },
    async run(args, ctx) {
      const id = ID(args.draft, "draft");
      const found = await ctx.outlook.call("GET", `/me/messages/${id}`, { query: { $select: "id,isDraft,subject,toRecipients" } });
      if (!found.isDraft) fail("that message is not a draft");
      await ctx.outlook.call("POST", `/me/messages/${id}/send`);
      return { sent: true, from: ctx.record.account, to: shownList(found.toRecipients), subject: found.subject };
    },
  },
  {
    name: "outlook_delete_draft",
    description: "Outlook: delete a draft (it goes to Deleted Items). Only when the person asks.",
    parameters: { type: "object", properties: { draft: { type: "string" } }, required: ["draft"] },
    async run(args, ctx) {
      const id = ID(args.draft, "draft");
      const found = await ctx.outlook.call("GET", `/me/messages/${id}`, { query: { $select: "id,isDraft" } });
      if (!found.isDraft) fail("that message is not a draft");
      await ctx.outlook.call("DELETE", `/me/messages/${id}`);
      return { deleted: true, draft: args.draft };
    },
  },
  {
    name: "outlook_modify",
    description: "Outlook: change messages: mark read or unread, flag or unflag, add or remove categories, move to a folder (archive, inbox, junkemail, a folder's name), or trash (to Deleted Items). A move gives the message a new id, answered here. Change only what the person asked for.",
    parameters: { type: "object", properties: {
      messages: { type: "array", items: { type: "string" }, description: "message ids (at most 50)" },
      read: { type: "boolean", description: "true marks read, false unread" }, flag: { type: "boolean", description: "true flags, false clears the flag" },
      add_categories: { type: "array", items: { type: "string" } }, remove_categories: { type: "array", items: { type: "string" } },
      move_to: FOLDER, trash: { type: "boolean", description: "true moves to Deleted Items" },
    }, required: ["messages"] },
    summarize: (args) => `${list(args.messages).length} messages`,
    async run(args, ctx) {
      const graph = ctx.outlook, ids = list(args.messages);
      if (!ids.length || ids.length > 50) fail("messages takes 1 to 50 ids");
      const add = list(args.add_categories), remove = list(args.remove_categories).map((item) => item.toLowerCase());
      const destination = args.trash ? "deleteditems" : args.move_to ? await graph.folder(args.move_to) : "";
      if (args.read === undefined && args.flag === undefined && !add.length && !remove.length && !destination) fail("say what to change: read, flag, categories, move_to or trash");
      const results = [];
      for (const raw of ids) {
        const id = ID(raw, "message");
        const patch = defined({ isRead: args.read === undefined ? undefined : Boolean(args.read), flag: args.flag === undefined ? undefined : { flagStatus: args.flag ? "flagged" : "notFlagged" } });
        if (add.length || remove.length) {
          const { categories = [] } = await graph.call("GET", `/me/messages/${id}`, { query: { $select: "categories" } });
          patch.categories = [...new Set([...categories.filter((item) => !remove.includes(item.toLowerCase())), ...add])];
        }
        if (Object.keys(patch).length) await graph.call("PATCH", `/me/messages/${id}`, { body: patch });
        let moved;
        if (destination) moved = await graph.call("POST", `/me/messages/${id}/move`, { body: { destinationId: destination } });
        results.push(defined({ message: raw, moved_to: destination || undefined, new_id: moved?.id && moved.id !== raw ? moved.id : undefined }));
      }
      return { changed: results };
    },
  },
  {
    name: "outlook_list_folders",
    description: "Outlook: the mail folders of the account with unread and total counts; with parent, the folders inside it.",
    parameters: { type: "object", properties: { parent: { type: "string", description: "optional folder whose subfolders to list" } } },
    async run(args, ctx) {
      const graph = ctx.outlook;
      const path = args.parent ? `/me/mailFolders/${encodeURIComponent(await graph.folder(args.parent))}/childFolders` : "/me/mailFolders";
      const { value = [] } = await graph.call("GET", path, { query: { $top: 200, $select: "id,displayName,unreadItemCount,totalItemCount,childFolderCount" } });
      return { folders: value.map((item) => defined({ id: item.id, name: item.displayName, unread: item.unreadItemCount, total: item.totalItemCount, subfolders: item.childFolderCount || undefined })) };
    },
  },
  {
    name: "outlook_download_attachment",
    description: "Outlook: save an attachment of a message on your computer, under /home/agent/work/outlook/ unless you give a path inside /home/agent/work. Name the attachment by its id or its filename, as outlook_read_message lists them.",
    parameters: { type: "object", properties: { message, attachment: { type: "string", description: "the attachment's id or filename" }, path: { type: "string", description: "optional absolute path inside /home/agent/work to save it as" } }, required: ["message", "attachment"] },
    async run(args, ctx) {
      const id = ID(args.message, "message"), graph = ctx.outlook;
      const { value = [] } = await graph.call("GET", `/me/messages/${id}/attachments`, { query: { $select: "id,name,contentType,size" } });
      const wanted = text(args.attachment, 500);
      const file = value.find((item) => item.id === wanted) || value.find((item) => item.name === wanted) || value.find((item) => String(item.name || "").toLowerCase().includes(wanted.toLowerCase()));
      if (!file) fail(`no attachment "${wanted}" in this message${value.length ? `; it has: ${value.map((item) => item.name).join(", ")}` : ""}`);
      if (file.size > 50 * 1024 * 1024) fail("the attachment is larger than 50 MB");
      const data = await graph.call("GET", `/me/messages/${id}/attachments/${encodeURIComponent(file.id)}`);
      if (!data.contentBytes) fail("this attachment is an Outlook item or a link, not a file");
      const bytes = Buffer.from(data.contentBytes, "base64");
      const safe = String(file.name || "attachment").replace(/[\\/\r\n\0]/g, "_").replace(/^\.+/, "_").slice(-150) || "attachment";
      const path = text(args.path, 1000) || `/home/agent/work/outlook/${String(args.message).replace(/[^A-Za-z0-9_-]/g, "").slice(-40)}/${safe}`;
      if (!path.startsWith("/home/agent/work/") || path.includes("\0") || path.split("/").includes("..")) fail("path must be inside /home/agent/work");
      if (!ctx.writeFile) fail("files cannot be saved on your computer in this turn");
      await ctx.writeFile(path, bytes);
      return { saved: path, filename: file.name, type: file.contentType, bytes: bytes.length };
    },
  },
  {
    name: "outlook_api",
    description: "Outlook: any other call to Microsoft Graph for the account's mail, when no outlook_ tool does it: method and path under https://graph.microsoft.com/v1.0 starting with /me (e.g. GET /me/mailFolders/inbox/messageRules, POST /me/mailFolders). The account granted only mail (read, write, send) and its profile. Prefer the outlook_ tools.",
    parameters: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] }, path: { type: "string", description: "e.g. /me/mailFolders/inbox/messageRules" }, query: { type: "object" }, body: { type: "object" } }, required: ["path"] },
    summarize: (args) => `${args.method || "GET"} ${String(args.path || "").slice(0, 120)}`,
    async run(args, ctx) {
      const method = String(args.method || "GET").toUpperCase(), path = text(args.path, 1000);
      if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) fail("method is GET, POST, PATCH, PUT or DELETE");
      if (!/^\/me(\/|$|\?)/.test(path) || path.includes("..") || /[\s#]/.test(path)) fail("path starts with /me, e.g. /me/mailFolders");
      const query = args.query && typeof args.query === "object" ? Object.fromEntries(Object.entries(args.query).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : value])) : undefined;
      return ctx.outlook.call(method, path, { query, body: ["POST", "PATCH", "PUT"].includes(method) ? (args.body && typeof args.body === "object" ? args.body : {}) : undefined });
    },
  },
];

export const outlook = {
  id: "outlook",
  name: "Outlook",
  secret: "CORA_OUTLOOK_TOKEN",
  appSecrets: [],
  label: "account",
  multi: { param: "account", noun: "account", identity: ["accountId", "account"], keyMode: "oauth", describe: (record) => record.account },
  oauth: { broker: "microsoft" },
  card: {
    icon: "mail",
    description: "Leggi, cerca, organizza e invia la posta del tuo account Microsoft (Outlook.com, Hotmail, Microsoft 365) con gli agenti che scegli.",
    meta: "Outlook · Microsoft 365",
    intro: "Gli agenti lavorano sulla posta del tuo account Microsoft. Accedi con Microsoft e autorizzi Cora: i token restano nella cassaforte, mai nel pannello.",
    writes: { oauth: "L'account Microsoft che colleghi: gli agenti inviano a suo nome." },
    modes: [{
      id: "oauth",
      label: "Account Microsoft",
      rows: [{ title: "Il tuo account Microsoft", hint: "Si apre Microsoft: scegli l'account e accetta. Poi torni qui e scegli gli agenti.", authorize: "Accedi con Microsoft" }],
    }],
  },
  tools: TOOLS,
  context(ctx) { return { ...ctx, outlook: client(ctx) }; },
};
