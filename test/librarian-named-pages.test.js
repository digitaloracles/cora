import assert from "node:assert/strict";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { Store } from "../src/store.js";
import { fakeDocker, fakeOllama, tempHome } from "./helpers.js";

const LIBRARIAN = /^Sei il bibliotecario del brain aziendale/;

test("a page an agent's note names by its slug reaches the librarian whole, even when the chats and other notes fill the search", async (t) => {
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
  const app = startCora({ home, host: "127.0.0.1", port: 0, insecureCookies: true, adminPassword: "fixture-password", sessionKey: "fixture-librarian-named",
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
    await app.companyBrain.write({ slug: `cliente-${page}`, kind: "client", title: `Cliente Zeta ${page}`, summary: `Cliente Zeta numero ${page}.`, body: `- Zeta ${page} rinnovo confermato`, sources: [{ type: "note", id: `seed-${page}` }], author: "librarian", review: "approved" });
  }
  await app.companyBrain.write({ slug: "persona-quieta", kind: "person", title: "Persona Quieta", summary: "Descrive un vecchio difetto.", body: "- PAGINA_SBAGLIATA: il bibliotecario scarta i suoi messaggi", sources: [{ type: "note", id: "seed-person" }], author: "librarian", review: "approved" });
  await app.companyBrain.write({ slug: "persona", kind: "topic", title: "Parola comune", summary: "Uno slug che è anche un pezzo di un altro slug.", body: "- NON_NOMINATA", sources: [{ type: "note", id: "seed-word" }], author: "librarian", review: "approved" });
  for (let note = 1; note <= 12; note += 1) {
    await app.companyBrain.note({ text: `Zeta: il cliente Zeta ${note} ha confermato il rinnovo. ${"dettaglio ".repeat(50)}fine nota ${note}`, author: "Ada" });
  }
  await app.companyBrain.note({ text: "Riscrivere la pagina persona-quieta: i suoi messaggi ora vengono letti.", author: "Radix" });

  answer = (prompt) => ({ reasoning: "Correzione chiesta da una nota.", pages: /^### persona-quieta \(person\)/m.test(prompt)
    ? [{ slug: "persona-quieta", kind: "person", title: "Persona Quieta", summary: "Parla con gli agenti.", body: "- PAGINA_GIUSTA: i suoi messaggi vengono letti", note: "riscritta", sources: ["n13"] }]
    : [] });
  const run = await app.librarian.run();
  assert.equal(run.status, "done");
  const prompt = prompts.join("\n");
  assert.match(prompt, /^### persona-quieta \(person\): Persona Quieta\nDescrive un vecchio difetto\.\n- PAGINA_SBAGLIATA/m, "the named page is shown whole");
  assert.doesNotMatch(prompt, /- NON_NOMINATA/, "a slug inside another slug is not a mention");
  assert.match((await app.companyBrain.page("persona-quieta")).body, /PAGINA_GIUSTA/);
});
