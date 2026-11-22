# Custom agent previews: the demo space (NOT-94)

A company asks for a preview on usecora.space (email, company, website). It does not get a space of its own: it gets sealed agents inside one shared demo space, `https://demo.usecora.space`, on a small DigitalOcean VM with DeepSeek as the only provider. When a company pays, it gets a real space.

## What happens

1. `bin/preview-demo.mjs` starts the demo Cora (owner-scoped memory, no transports, desktops, CLIs other than dsh, or company Brain) and, inside the same process, the pipeline (`src/preview-demo.js` → `src/preview-pipeline.js`) every minute.
2. The pipeline lists `requested`/`building` previews from `https://usecora.space/api/previews` (bearer `CORA_PREVIEW_PIPELINE_TOKEN`), reads the company's public website (home page plus up to two about/products pages, public addresses only, redirects rechecked) and asks DeepSeek for a briefing: summary, products, audience, tone and three agents. Without an answer it builds the agents from the page itself.
3. One group per company site: three sealed agents named `<Name> · <Company>`, owned by the company's guest, on `deepseek/deepseek-flash`. The guest's address is admitted to the space and gets one email (Resend, `Cora <cora@usecora.space>`) with a personal link `https://demo.usecora.space/auth/preview?token=…`; only the token's SHA-256 is stored. A second request for the same site joins the group: a new address gets its own link and co-owns the same agents, the same address gets nothing new.
4. A guest sees only its company's agents and may only write to them (`/api/rooms/web-<agent>/messages`); every other write is refused. The company's first message starts its hour (`value:previewWindows[<group>]`), reported once to usecora.space (`POST /api/previews/:id/first-message`). After 60 minutes the group's writes are refused and its links answer 410; two minutes later the pipeline deletes its agents, their chats, its links and its access. A group nobody opens goes after seven days and its preview is marked `failed`.

## The VM

- Droplet `cora-demo-s` (team turinglabs, fra1, s-1vcpu-1gb with 2 GB swap), DNS `demo.usecora.space` (Cloudflare, DNS only) → its IPv4. Caddy terminates TLS and proxies to `127.0.0.1:4370`.
- User `cora` runs the systemd user service `cora-demo` from `~/app` (a release of this repository) with data in `~/.cora-demo`.
- Secrets in that user's hush, by name: `CORA_DEMO_SESSION_KEY` (generated there), `DEEPSEEK_API_KEY`, `CORA_PREVIEW_PIPELINE_TOKEN`, `RESEND_API_KEY`, sealed over with `hush box seal --pubkey-file` from the hosts that hold them.
- An owner session for operations: `hush run --name CORA_DEMO_SESSION_KEY --env CORA_SESSION_KEY --redact -- node bin/login-link.mjs https://demo.usecora.space`.

Tests: `node --test test/preview.test.js test/preview-pipeline.test.js`.
