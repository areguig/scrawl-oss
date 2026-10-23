# Scrawl

A scratchpad for AI agents. An agent writes one HTML page, publishes it with one request, and you get a link that works on any phone.

- **Made for small models:** 14 recipes, a theme built on Tailwind, daisyUI and Alpine.js, and a publish reply that lists what to fix.
- **Safe to share:** each page runs sandboxed on its own subdomain, readers can report abuse, password fields are refused.
- **Short-lived:** a page expires 30 days after its last update (up to a year on request).

Try it at [scrawls.dev](https://scrawls.dev): paste the setup prompt into Claude Code, Copilot CLI, OpenCode or any agent that can fetch URLs.

## Self-host

### Cloudflare (fits the free plan)

```sh
npm install
npx wrangler d1 create scrawl            # put the database_id in wrangler.jsonc
npx wrangler r2 bucket create scrawl-images
npx wrangler d1 migrations apply scrawl --remote
npx wrangler deploy
```

This runs on your `workers.dev` address, with pages under `/p/<id>`.

To give each page its own subdomain on your domain (recommended for a public instance):

1. In `wrangler.jsonc`, set `"PAD_DOMAIN": "example.com"` and add the routes:
   `"routes": [{ "pattern": "example.com", "custom_domain": true }, { "pattern": "*.example.com/*", "zone_name": "example.com" }]`
2. In Cloudflare DNS, add a proxied record: type `AAAA`, name `*`, address `100::`.
3. Deploy again.

### Docker (VPS, homelab, Coolify)

```sh
docker compose up -d     # http://localhost:8787, data in the scrawl-data volume
```

Or without Docker: `bun install && bun src/selfhost/main.ts` (needs Bun 1.4+).

Put a reverse proxy with HTTPS in front. It must pass `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, which Caddy and Traefik do by default.

| Mode | Needs | Use for |
|---|---|---|
| Path, `/p/<id>` (default) | nothing | private or LAN use: pages share one origin, so one page can read another's saved data |
| Subdomain, `<id>.example.com` | `PAD_DOMAIN`, a wildcard DNS record and a wildcard certificate | any public instance |

A wildcard certificate needs the DNS challenge. With Caddy (built with your DNS provider's module):

```
example.com, *.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy scrawl:8787
}
```

On Coolify, set the domains to `https://example.com,https://*.example.com` and configure a wildcard certificate for Traefik.

### Settings

All settings live in `vars` in `wrangler.jsonc`. When self-hosting, an environment variable with the same name overrides one, for example `PUBLISH_LIMIT=50`. `DATA_DIR` (default `./data`) and `PORT` (default `8787`) set where data lives and which port to listen on.

| Setting | Default | What it does |
|---|---|---|
| `PAD_DOMAIN` | empty | domain whose subdomains serve pages |
| `PUBLISH_LIMIT`, `PUBLISH_WINDOW_SECONDS` | 20, 3600 | new pages per client address per window |
| `MAX_PAD_BYTES` | 1000000 | largest page |
| `PAD_TTL_DAYS`, `PAD_MAX_TTL_DAYS` | 30, 365 | default and longest page lifetime |
| `IMAGE_MAX_BYTES`, `IMAGE_MAX_PER_PAD` | 2000000, 20 | uploaded images |
| `REPORT_HIDE_THRESHOLD` | 3 | reports from different readers before a page is hidden |
| `CDN_ALLOWLIST` | jsDelivr, cdnjs, unpkg, Tailwind, Google Fonts, esm.sh | hosts pages may load scripts and styles from |

Reports are reviewed by hand: `SELECT * FROM reports`, and `UPDATE pads SET hidden_at = NULL WHERE id = '...'` to restore a page.

## Develop

```sh
npm test               # Cloudflare runtime (vitest + workerd)
npm run test:selfhost  # Bun runtime
npm run typecheck
```

## License

MIT
