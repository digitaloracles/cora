# Custom agent previews (NOT-94)

A company asks for a preview on usecora.space (email, company, website). The pipeline on the host that runs usecora.space turns each request into a Cora space of its own:

1. `bin/preview-pipeline.mjs` (LaunchAgent `space.usecora.preview-pipeline`, every minute) lists `requested`/`building` previews from `https://usecora.space/api/previews` (bearer `CORA_PREVIEW_PIPELINE_TOKEN`).
2. It reads the public website (home page plus up to two about/products pages, public addresses only, redirects rechecked) and asks Ollama Cloud for a briefing: summary, products, audience, tone and three agents. Without an answer it builds the agents from the page itself.
3. One space per company site: `~/.cora-previews/<slug>/` holds `spec.json` and the space's own data; the slug comes from the domain (`acme.com` → `acme`, then `acme-2`, never one of our spaces). A LaunchAgent `space.usecora.preview.<slug>` runs `bin/preview-space.mjs` on a port from 4600–4699 with its own hush session key (`CORA_PREVIEW_<SLUG>_SESSION_KEY`). It has no transports, no desktops, no CLIs, no company Brain and only sealed agents owned by the company's guests. The space is added to the cloud (`cloud/cli.js space add <slug> --upstream http://127.0.0.1:<port>`), so `https://<slug>.usecora.space` reaches it through the wildcard route.
4. The preview is reported `ready` and the company gets one email (Resend, `Cora <cora@usecora.space>`) with a personal link `https://<slug>.usecora.space/auth/preview?token=…`. Only the token's SHA-256 is stored. A second request for the same site joins the same space; a new address gets a link of its own, the same address gets nothing new.
5. The first message in the space starts the hour (`previewWindow` in the space's store); the pipeline reports it once with `POST /api/previews/:id/first-message`. After 60 minutes the space refuses every write and its links answer 410; two minutes later the pipeline stops the LaunchAgent, removes the space from the cloud, deletes its hush key and its data. A space nobody opens goes after seven days and its preview is marked `failed`.

Pipeline LaunchAgent secrets, by hush name: `CORA_PREVIEW_PIPELINE_TOKEN`, `CORO_OLLAMA_API_KEY` (as `CORA_OLLAMA_API_KEY`), `CORA_CLOUD_RESEND_API_KEY` (as `RESEND_API_KEY`). Logs: `~/.cora-previews/pipeline.log`. State: `~/.cora-previews/registry.json` (no secrets).

Tests: `node --test test/preview.test.js test/preview-pipeline.test.js`.
