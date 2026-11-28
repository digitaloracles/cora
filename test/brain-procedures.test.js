import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { blockQuery, declaresBlock, toolFailure } from "../src/brain-procedures.js";
import { startCora } from "../src/main.js";
import { Store } from "../src/store.js";
import { GUILD, MAIN_TOKEN, OWNER, fakeDiscord, fakeDocker, fakeOllama, tempHome, waitFor } from "./helpers.js";

// The 28/11 09:01 case: Dobi's cost routine, stopped by the expired `refracto` gcloud profile.
const GCLOUD = "CLOUDSDK_CONFIG=$HOME/.config/gcloud-profiles/refracto gcloud projects describe google-mpf-m6jdy1ejytgi --account=sebastiano@dopamina.it";
const GCLOUD_ERROR = "ERROR: (gcloud.projects.describe) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.";
const DOBI_RESULT = "**Costi Refracto e anomalie: UNVERIFIED.** L’accesso live con `sebastiano@dopamina.it` è fallito: Google ha rifiutato il rinnovo delle credenziali del profilo Refracto. Serve ripristinare l’autenticazione del profilo e ottenere un nuovo report.";
const PROCEDURE = "refracto-gcloud-riautenticazione-mac-pro";
const RULE = "regola-refracto-gcloud-riautenticazione-autonoma-17-11";

test("what counts as a failure worth a lookup, and what as a declared block", () => {
  assert.match(toolFailure("shell", { command: GCLOUD }, `[exit 1]\n${GCLOUD_ERROR}`).query, /refracto[\s\S]*Reauthentication failed/);
  assert.equal(toolFailure("shell", { command: GCLOUD }, "[exit 0]\nACTIVE"), null, "a command that worked");
  assert.equal(toolFailure("shell", { command: "npm test" }, "[exit 1]\n3 failing tests"), null, "a failure that is not about access");
  assert.ok(toolFailure("linear_get_issue", { issue: "NOT-1" }, "error: Linear refused: authentication token expired"), "a connector refusal");
  assert.equal(toolFailure("linear_get_issue", { issue: "NOT-1" }, "{\"id\":\"1\"}"), null);
  assert.ok(declaresBlock(DOBI_RESULT));
  assert.ok(declaresBlock("I am blocked: the deploy key was rejected."));
  assert.equal(declaresBlock("Costi del 26/11: 31,43 CHF, +7,6% sulla mediana."), false);
  assert.match(blockQuery(DOBI_RESULT), /Refracto[\s\S]*credenziali/);
  // 28/11 10:00, Dobi's health check: a missing directory is not an access problem.
  assert.equal(toolFailure("shell", { command: "ls -l ~/work/health-monitor && tailscale status" }, "[exit 2]\nls: cannot access '/home/agent/work/health-monitor': No such file or directory"), null);
  assert.ok(toolFailure("shell", { command: "ls /srv/keys" }, "[exit 2]\nls: cannot open directory '/srv/keys': Permission denied"), "a real refusal still counts");
  // A reply that quotes someone else's block does not declare one.
  assert.equal(declaresBlock("Dobi chiudeva con «UNVERIFIED» e Cora l'ha fatto tornare indietro; il rilascio di `blocked` è verificato."), false);
  assert.equal(declaresBlock("> Costi Refracto: UNVERIFIED\nIl rilascio è verificato."), false);
  assert.ok(declaresBlock("L'impatto dello spazio sulle attività resta **UNVERIFIED**."), "the agent's own words still count");
});

test("a blocked agent is shown the owner's Brain procedures before it gives up, once, and only when they match", async (t) => {
  const discord = await fakeDiscord();
  const docker = fakeDocker();
  const turns = [];
  let script = () => ({ content: "PASS" });
  const ollama = await fakeOllama(async (body) => {
    const system = String(body.messages[0]?.content || "");
    if (/^Scrivi la condizione di completamento/.test(system)) return { content: "NESSUNO" };
    if (/^Giudichi se un compito è finito/.test(system)) return { content: JSON.stringify({ met: true, reason: "" }) };
    if (/^Valuti l'intenzione/.test(system)) return { content: JSON.stringify({ intent: "update" }) };
    if (/^Sei Dobi\./.test(system)) {
      turns.push(body.messages);
      return script(body.messages);
    }
    return { content: "PASS" };
  });
  const home = tempHome();
  const seed = new Store(home);
  seed.updateSettings({ guildIds: [GUILD], ownerIds: [OWNER], brainModel: "ollama/test-model" });
  seed.close();
  const app = startCora({ home, host: "127.0.0.1", port: 0, insecureCookies: true, adminPassword: "fixture-password", sessionKey: "fixture-procedures",
    discordToken: MAIN_TOKEN, discordApi: discord.url, ollamaUrl: ollama.url, ollamaKey: "test-ollama-key", orcaKey: "", cloudUrl: "https://usecora.test", cloudKey: "", cloudSpace: "acme",
    claudeBin: "/missing/claude", codexBin: "/missing/codex", hermesBin: "/missing/hermes", grokBin: "/missing/grok", museBin: "/missing/muse", botTokenFor: () => "",
    brainDatabaseUrl: "pglite:memory", brainEmbedUrl: ollama.url,
    docker: docker.path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys",
  });
  await app.ready;
  await app.companyBrain.ready;
  app.librarian.requestRun = () => false;
  t.after(async () => {
    await app.stop();
    await Promise.all([discord.close(), ollama.close()]);
  });
  await waitFor(() => app.discord.state === "ready", { what: "gateway ready" });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ password: "fixture-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, "X-Cora": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };

  // The Brain as it was on 28/11: the reviewed procedure, the owner's autonomy rule, and pages that do not answer it.
  const write = (page) => app.companyBrain.write({ ...page, author: "owner:test", review: "approved" });
  await write({ slug: PROCEDURE, kind: "procedure", title: "Refracto: riautenticazione gcloud sul Mac Pro con hush",
    summary: "Procedura per riautenticare il profilo Google Cloud sebastiano@dopamina.it sul Mac Pro con `devo auth repair refracto` e la password in hush.",
    body: "- Il profilo gcloud refracto si riautentica da terminale sul Mac Pro con `devo auth repair refracto`, password in hush come DOPAMINA_SEBASTIANO_PASSWORD.\n- Si può fare da remoto in SSH." });
  await write({ slug: RULE, kind: "decision", title: "Refracto: il profilo gcloud `refracto` si riattiva da soli con la password in hush, senza chiedere (17/11)",
    summary: "Sebastiano: la password è in hush e la procedura è nota, quindi riattivare il profilo gcloud refracto in autonomia senza chiedere.",
    body: "- Il profilo gcloud `refracto` va riattivato in autonomia dagli agenti ([[refracto-gcloud-riautenticazione-mac-pro]])." });
  await write({ slug: "fatturazione-acme", kind: "procedure", title: "Fatturazione Acme", summary: "Le fatture di Acme partono il 5 del mese.", body: "- Portale clienti, invio il 5." });
  await write({ slug: "refracto", kind: "project", title: "Refracto", summary: "Progetto Refracto: gcloud, Cloud Run, profilo refracto.", body: "- Progetto google-mpf-m6jdy1ejytgi." });

  const dobi = (await call("/api/agents", { method: "POST", body: { name: "Dobi", model: "ollama/test-model", chattiness: 0, tools: true } })).data;
  assert.ok(dobi.id);
  const toolResults = (messages) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  const lastUser = (messages) => String(messages.filter((message) => message.role === "user").at(-1)?.content || "");
  const posted = (pattern) => waitFor(() => discord.state.webhookPosts.find((post) => post.username === "Dobi" && pattern.test(post.content)), { what: `Dobi's reply ${pattern}` });
  const traceOf = async () => {
    const list = (await call(`/api/traces?agentId=${dobi.id}`)).data;
    const items = Array.isArray(list) ? list : list.traces || list.items || [];
    return (await call(`/api/traces/${items[0].id}`)).data;
  };

  // 1. Replay of 28/11: gcloud `refracto` fails in the turn, Dobi ignores what it is shown and writes UNVERIFIED.
  writeFileSync(join(docker.dir, "exec-fail"), `gcloud projects describe\n${GCLOUD_ERROR}\n`);
  let step = 0;
  script = (messages) => {
    step += 1;
    if (step === 1) return { tool_calls: [{ function: { name: "shell", arguments: { command: GCLOUD } } }] };
    if (step === 2) return { content: DOBI_RESULT };
    if (step === 3) return { tool_calls: [{ function: { name: "brain_page", arguments: { slug: PROCEDURE } } }] };
    return { content: "Profilo `refracto` riattivato con la procedura del Brain: report dei costi letto." };
  };
  discord.say({ content: "@Dobi controlla i costi Refracto di ieri" });
  await posted(/Profilo `refracto` riattivato/);
  const replay = turns.at(-1);
  const failed = toolResults(replay).find((text) => text.startsWith("[exit 1]"));
  assert.ok(failed.includes(GCLOUD_ERROR.split("\n")[0]), "the real error is still there");
  assert.match(failed, /\[Cora\] The owner's Brain has procedures or rules for this error/);
  assert.ok(failed.includes(`[${PROCEDURE}]`) && failed.includes(`[${RULE}]`), "the procedure and the autonomy rule, on the failed call");
  assert.ok(!failed.includes("[fatturazione-acme]") && !failed.includes("[refracto] "), "neither unrelated procedures nor non-procedure pages");
  const nudges = replay.filter((message) => message.role === "user" && /Risposta non ancora pubblicata: dichiari un blocco/.test(String(message.content)));
  assert.equal(nudges.length, 1, "the UNVERIFIED reply goes back exactly once");
  assert.ok(String(nudges[0].content).includes(`[${PROCEDURE}]`) && String(nudges[0].content).includes(`[${RULE}]`));
  assert.ok(!discord.state.webhookPosts.some((post) => post.username === "Dobi" && /UNVERIFIED/.test(post.content)), "the block was never posted");
  const replayTrace = await traceOf();
  const offered = replayTrace.steps.filter((item) => item.procedures).map((item) => item.procedures);
  assert.deepEqual(offered.map((item) => item.trigger), ["tool shell", "reply", "read"], "every lookup and the read are in the trace");
  assert.deepEqual(offered[0].offered.map((page) => page.slug).sort(), [PROCEDURE, RULE].sort());
  assert.equal(offered[2].slug, PROCEDURE);

  // 2. A failed call the Brain has nothing for: the result is exactly the tool's.
  writeFileSync(join(docker.dir, "exec-fail"), "cat /etc/shadow\ncat: /etc/shadow: Permission denied\n");
  step = 0;
  script = (messages) => {
    step += 1;
    if (step === 1) return { tool_calls: [{ function: { name: "shell", arguments: { command: "cat /etc/shadow" } } }] };
    return { content: "Il file è protetto: non lo leggo." };
  };
  discord.say({ content: "@Dobi leggi /etc/shadow" });
  await posted(/Il file è protetto/);
  assert.deepEqual(toolResults(turns.at(-1)), ["[exit 1]\ncat: /etc/shadow: Permission denied\n"], "no match, no change");

  // 3. A declared block with no matching procedure is posted as it is, with no extra round.
  rmSync(join(docker.dir, "exec-fail"));
  const before = turns.length;
  script = () => ({ content: "Sono bloccato: il pannello di Acme non mi fa accedere, serve il tuo login." });
  discord.say({ content: "@Dobi apri il pannello Acme" });
  await posted(/Sono bloccato: il pannello di Acme/);
  assert.equal(turns.length - before, 1, "one model call: nothing matched, nothing sent back");
  assert.doesNotMatch(lastUser(turns.at(-1)), /Risposta non ancora pubblicata/);

  // 4. ask_owner about credentials, with the procedure unread: held once, then sent if the agent insists.
  step = 0;
  script = (messages) => {
    step += 1;
    if (step <= 2) return { tool_calls: [{ function: { name: "ask_owner", arguments: { question: "Il login gcloud del profilo refracto è scaduto: puoi riautenticarlo tu?" } } }] };
    return { content: "Ho chiesto." };
  };
  discord.say({ content: "@Dobi rifai il controllo costi Refracto" });
  await posted(/Ho chiesto\./);
  const asks = toolResults(turns.at(-1));
  assert.match(asks[0], /^error: not sent yet\. The owner's Brain has procedures/);
  assert.ok(asks[0].includes(`[${PROCEDURE}]`));
  assert.doesNotMatch(asks[1], /^error:/, "the second ask goes through: one extra round, no loop");
});
