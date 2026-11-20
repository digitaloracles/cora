import assert from "node:assert/strict";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { Store } from "../src/store.js";
import { fakeDocker, fakeOllama, tempHome } from "./helpers.js";

const LIBRARIAN = /^Sei il bibliotecario del brain aziendale/;

test("the person who speaks and the client a chat names reach the librarian whole, so the news updates them instead of a new dated page", async (t) => {
  const prompts = [];
  let answer = () => ({ pages: [] });
  const ollama = await fakeOllama(async (body) => {
    if (!LIBRARIAN.test(String(body.messages[0]?.content || ""))) return { content: "PASS" };
    const prompt = String(body.messages.at(-1).content);
    prompts.push(prompt);
    return { content: JSON.stringify(answer(prompt)) };
  });
  const home = tempHome();
  const seed = new Store(home);
  seed.updateSettings({ brainModel: "ollama/test-model" });
  seed.close();
  const app = startCora({ home, host: "127.0.0.1", port: 0, insecureCookies: true, adminPassword: "fixture-password", sessionKey: "fixture-librarian-canonical",
    discordToken: "", telegramToken: "", ollamaUrl: ollama.url, ollamaKey: "test-ollama-key", orcaKey: "", cloudUrl: "", cloudKey: "", cloudSpace: "",
    claudeBin: "/missing/claude", codexBin: "/missing/codex", hermesBin: "/missing/hermes", grokBin: "/missing/grok", museBin: "/missing/muse", botTokenFor: () => "",
    brainDatabaseUrl: "pglite:memory", brainEmbedUrl: ollama.url,
    docker: fakeDocker().path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys",
  });
  await app.ready;
  await app.companyBrain.ready;
  app.librarian.requestRun = () => false;
  t.after(async () => {
    await app.stop();
    await ollama.close();
  });

  for (let page = 1; page <= 20; page += 1) {
    await app.companyBrain.write({ slug: `rilascio-vetrina-${page}`, kind: "topic", title: `Rilascio vetrina ${page}`, summary: `Rilascio della vetrina ${page}.`, body: `- vetrina ordini rilascio ${page} sito catalogo`, sources: [{ type: "note", id: `seed-${page}` }], author: "librarian", review: "approved" });
  }
  await app.companyBrain.write({ slug: "vetri-ferri", kind: "client", title: "Vetri Ferri", summary: "Cliente: vetreria.", body: "- CLIENTE_CANONICO: contratto 2026", sources: [{ type: "note", id: "seed-client" }], author: "librarian", review: "approved" });
  await app.companyBrain.write({ slug: "giulia-ferri", kind: "person", title: "Giulia Ferri", summary: "Referente di Vetri Ferri.", body: "- PERSONA_CANONICA: segue il sito", sources: [{ type: "note", id: "seed-person" }], author: "librarian", review: "approved" });
  await app.companyBrain.write({ slug: "vetro", kind: "client", title: "Vetro", summary: "Un nome più corto di quattro lettere non è una citazione.", body: "- NON_CITATO", sources: [{ type: "note", id: "seed-short" }], author: "librarian", review: "approved" });
  await app.companyBrain.write({ slug: "ferro-battuto", kind: "project", title: "Ferro Battuto", summary: "Progetto non nominato.", body: "- NON_NOMINATO", sources: [{ type: "note", id: "seed-other" }], author: "librarian", review: "approved" });

  const now = Date.now();
  app.store.appendArchive("chan-vetri", { id: "m-giulia", kind: "human", authorId: "telegram:77", authorName: "Giulia", at: now - 2000, content: "La vetrina ordini del sito catalogo va online lunedì 23/11, rilascio confermato." });
  app.store.appendArchive("chan-vetri", { id: "m-agent", kind: "agent", authorId: "ag-1", authorName: "Ferri", at: now - 1000, content: "Per Vétri Ferri preparo il rilascio della vetrina ordini sul catalogo." });

  answer = (prompt) => ({ reasoning: "La data di uscita è una novità del cliente.", pages: /^### vetri-ferri \(client\)/m.test(prompt)
    ? [{ slug: "vetri-ferri", kind: "client", title: "Vetri Ferri", summary: "Cliente: vetreria.", body: "- CLIENTE_CANONICO: contratto 2026\n- 23/11: vetrina ordini online", note: "data di uscita", sources: ["m1"] }]
    : [{ slug: "vetri-ferri-rilascio-23-11", kind: "topic", title: "Vetri Ferri: rilascio 23/11", summary: "Pagina datata.", body: "- vetrina online", note: "nuova", sources: ["m1"] }] });
  const run = await app.librarian.run();
  assert.equal(run.status, "done");
  const prompt = prompts.join("\n");
  assert.match(prompt, /^### giulia-ferri \(person\): Giulia Ferri\nReferente di Vetri Ferri\.\n- PERSONA_CANONICA/m, "the page of the person who speaks is shown whole");
  assert.match(prompt, /^### vetri-ferri \(client\): Vetri Ferri\nCliente: vetreria\.\n- CLIENTE_CANONICO/m, "the client named in the chat, accents aside, is shown whole");
  assert.doesNotMatch(prompt, /- NON_CITATO|- NON_NOMINATO/, "short names and pages nobody named stay in the index");
  assert.match(prompt, /quella canonica/, "the rules ask to update the canonical page");
  assert.match((await app.companyBrain.page("vetri-ferri")).body, /23\/11: vetrina ordini online/);
  assert.equal(await app.companyBrain.page("vetri-ferri-rilascio-23-11"), null, "no dated duplicate");
});
