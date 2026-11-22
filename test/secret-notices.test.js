import assert from "node:assert/strict";
import { test } from "node:test";
import { passKeys, signPass } from "../src/pass.js";
import { executeTool } from "../src/tools.js";
import { invitationWorld } from "./invitation-fixtures.js";

const NAME = "ACME_FTP_PASSWORD";
const mailsTo = (messages, email) => messages.filter((message) => message.to.includes(email));
const settle = async (vault, id) => { await vault.mailing.get(id); };

test("a secret sent to named people mails each of them once, with who sent it and why, never its name; public, password and pending sends mail nobody", async () => {
  const f = await invitationWorld();
  try {
    const { vault } = f.app;
    assert.equal((await f.request(f.admin, "/api/secrets", { method: "POST", body: { name: NAME, value: "ftp-fixture-value-0001" } })).status, 201);

    const open = await f.request(f.admin, `/api/secrets/${NAME}/sends`, { method: "POST", body: { note: "public", access: { mode: "public" } } });
    assert.equal(open.status, 201);
    const locked = await f.request(f.admin, `/api/secrets/${NAME}/sends`, { method: "POST", body: { note: "password", access: { mode: "password", password: "fixture-pass-123" } } });
    assert.equal(locked.status, 201);
    assert.equal(vault.mailing.size, 0, "a public or password link mails nobody");

    const people = await f.request(f.admin, `/api/secrets/${NAME}/sends`, { method: "POST", body: { note: `il server FTP, la ${NAME.toLowerCase()} nuova`, views: 2, access: { mode: "people", emails: ["Ana@Guest.test", "bo@guest.test"], domains: [] } } });
    assert.equal(people.status, 201);
    await settle(vault, people.data.id);
    assert.equal(f.messages.length, 2, "one mail per address");
    for (const email of ["ana@guest.test", "bo@guest.test"]) {
      const [mail] = mailsTo(f.messages, email);
      assert.ok(mail, email);
      assert.equal(mailsTo(f.messages, email).length, 1);
      assert.equal(mail.subject, "Space owner ti ha mandato un segreto su Cora");
      assert.match(mail.text, /^Space owner \(spazio invitation-test\) ti ha mandato un segreto per il server FTP, la … nuova\./);
      assert.match(mail.text, new RegExp(`Il link si apre 2 volte, fino al .+\\. Per aprirlo accedi con l'indirizzo ${email.replace(".", "\\.")}\\.`));
      assert.ok(mail.text.includes(people.data.url), "the button opens the send's own protected link");
      assert.ok(mail.html.includes(`href="${people.data.url}"`));
      for (const field of [mail.subject, mail.text, mail.html]) {
        assert.doesNotMatch(field, /ACME_FTP_PASSWORD/i, "the secret's name stays out of the mail");
        assert.doesNotMatch(field, /ftp-fixture-value/, "and so does its value");
      }
    }
    assert.match(people.data.url, /^https:\/\/v-[a-f0-9]{12}--invitation-test\.127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/);
    const mailed = vault.events({ name: NAME }).filter((entry) => entry.kind === "send-mailed");
    assert.deepEqual(mailed.map((entry) => [entry.to, entry.status]).sort(), [["ana@guest.test", "sent"], ["bo@guest.test", "sent"]]);

    // An agent's send waits for the owner: no mail until it is approved, then one, in the agent's name.
    f.messages.length = 0;
    const buzz = (await f.request(f.admin, "/api/agents", { method: "POST", body: { name: "Buzz", tools: true } })).data;
    const proposed = vault.createSend({ name: NAME, status: "proposed", reason: "il deploy di stasera", note: "Bo: il deploy di stasera", by: { kind: "agent", id: buzz.id, name: "Buzz" }, access: { mode: "people", emails: ["bo@guest.test"], domains: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.messages.length, 0, "nothing before the approval");
    const approved = await f.request(f.admin, `/api/secrets/sends/${proposed.id}/approve`, { method: "POST", body: {} });
    assert.equal(approved.status, 200);
    await settle(vault, proposed.id);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].subject, "Buzz ti ha mandato un segreto su Cora");
    assert.match(f.messages[0].text, /^Buzz \(spazio invitation-test\) ti ha mandato un segreto per il deploy di stasera\./);
    assert.doesNotMatch(f.messages[0].text, /Bo:/, "the reason, not the note with whom it is for");

    // The cloud mails only what the space confirms: a made-up nonce, a replayed claim and a foreign key get nothing.
    const arbitrary = await fetch(f.cloudBase + "/spaces/invitation-test/secret-sends", { method: "POST", body: new URLSearchParams({ nonce: "A".repeat(43) }) });
    assert.equal(arbitrary.status, 403);
    const wrongKey = signPass(passKeys("another fixture signing key with enough entropy").privateKey, { aud: "secret-send:invitation.test", nonce: "A".repeat(43) });
    assert.equal((await f.request(f.admin, "/api/cloud/secret-send", { method: "POST", body: { pass: wrongKey } })).status, 403);
    assert.equal(f.messages.length, 1);
  } finally { await f.close(); }
});

test("an agent's send for the owner mails the people it names only once the owner has the link", async () => {
  const f = await invitationWorld();
  try {
    const { vault, store } = f.app;
    vault.put({ name: NAME, value: "ftp-fixture-value-0002", by: { kind: "user", id: "u1", name: "Owner" } });
    const agent = { id: "ag_buzzbuzzbuzz", name: "Buzz", enabled: true, tools: true };
    const ctx = { agent, store, vault, channelId: "c1", boxes: { ensure: async () => {} }, requester: { kind: "owner", id: "1", name: "Seb" } };
    vault.canUse = () => true;
    const lost = await executeTool({ name: "secret_send", args: { name: NAME, to: "Bo", reason: "x", emails: ["bo@guest.test"] } }, { ...ctx, messageOwner: async () => false });
    assert.match(lost.text, /^NOT SENT/);
    assert.equal(f.messages.length, 0, "a link revoked because the owner never got it mails nobody");
    const told = [];
    const sent = await executeTool({ name: "secret_send", args: { name: NAME, to: "Bo", reason: `ruotare ${NAME}`, emails: ["bo@guest.test"] } }, { ...ctx, messageOwner: async (text) => { told.push(text); return true; } });
    assert.match(sent.text, /^SENT: .* Cora also emailed bo@guest\.test \(sent\)/);
    assert.doesNotMatch(sent.text, /https?:\/\//, "the agent never gets the link");
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].subject, "Buzz ti ha mandato un segreto su Cora");
    assert.match(f.messages[0].text, /ti ha mandato un segreto per ruotare …\./);
    assert.doesNotMatch(JSON.stringify(f.messages[0]), /ACME_FTP_PASSWORD/i);
  } finally { await f.close(); }
});
