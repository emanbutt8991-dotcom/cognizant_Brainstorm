# Deploying Waymark

Waymark has two parts:

- **The front end**: a static React and Vite build (`npm run build` produces `dist/`).
- **The API**: optional. It adds live exchange rates, weather, Climatiq emissions, aggregated news and AI wording.

The original local analysis features work without the API. **Waymark 3.0 integration management, Agent Hub, activity, approvals and connected business data require the Express API. Static-only hosting is not a complete Waymark 3.0 deployment.**

## Waymark 3.0 deployment

Use one persistent Node 20.19+ service: `npm ci`, `npm run build`, then `npm start`. It serves both `dist/` and all `/api` routes. Set `API_PORT` to the port assigned by your hosting service. Configure HTTPS at the reverse proxy and allow unbuffered SSE responses on `/api/agent/run`; set its timeout above `AGENT_TIMEOUT_MS`. Check `/api/health` for process health, then authenticate and check `/api/platform/summary` for workspace functionality.

For a split deployment, build with `VITE_API_BASE=https://api.example/api`, set `ALLOWED_ORIGINS=https://app.example`, `APP_BASE_URL=https://app.example` and `PUBLIC_API_URL=https://api.example`. Register `https://api.example/api/integrations/oauth/callback` with each OAuth app. Keep secrets on the API server. The frontend requires SPA fallback to `index.html` for `/app/*`.

Set `INTEGRATIONS_ENCRYPTION_KEY` to a stable high-entropy secret and mount `WAYMARK_DATA_DIR` on a durable private volume. Back up both the key and store securely. Rotating or losing the key makes stored credentials, integration datasets and monitoring snapshots unreadable. Do not expose the data directory through static hosting. Anonymous/local workspaces are isolated by an unguessable browser workspace key; losing browser storage loses access to that server state. Authenticated companies use membership verified by Supabase.

For Supabase accounts, run migrations **0001 and 0002 in order** on a staging project first. Configure public anon credentials in the browser and `SUPABASE_SERVICE_ROLE_KEY` only on Express. New platform tables are server-written; member reads are tenant-scoped, while connection credentials and datasets are closed to direct client access. Embedded PostgreSQL policy tests are automated; a hosted Supabase deployment still needs staging verification with separate owners and viewers.

Set `MONITOR_INTERVAL_MINUTES=30` for a single always-running API instance. An authorized monitoring run registers the workspace. With a persistent encryption key, its snapshot is encrypted and saved, recovered after restart, and joined to fresh integration datasets on each scheduled run. The snapshot is the last submitted browser records, not a continuously synchronized copy of browser storage. Submit a new monitoring run after local record edits. Turning monitoring off persists and stops future scheduled checks. Without a persistent key, registered contexts last only until restart. With scheduling disabled, the open browser checks at most every 30 minutes; no closed-browser guarantee applies.

**Deployment boundary:** locks and OAuth states are process-local. Use one API replica with durable storage and sticky OAuth callbacks; restarting during OAuth requires authorization again. Do not run clustered schedulers or shared-file multi-writer deployments without distributed leases and transactional delivery claims. Already detected alerts are suppressed rather than retried indefinitely. Provider failures and incomplete checks appear in Agent Activity. This release has not been deployed to an external host.

The legacy Edge Function below does not expose 3.0 endpoints. A static frontend can retain that subset, or point all requests at Express for the full platform. There is no automatic path routing between Edge and Express.

### Express-only routes

These need the Node API (Option B). On a static host with only the Edge Function they return 404 and the screens say the service is unavailable:

| Area | Routes | Stored in |
| --- | --- | --- |
| Company branding | `GET/PUT /api/branding` | `platform_settings` (`id: branding`) |
| Email alerts | `GET/PUT /api/notifications/email`, `POST /api/notifications/email/test`, `GET /api/notifications/email/outbox` | `notification_preferences`, `notification_deliveries` |
| Workspace SMTP | `GET/PUT/DELETE /api/notifications/email/smtp`, `POST …/smtp/verify`, `POST …/smtp/test`, `POST …/smtp/enabled` | `platform_settings` (`id: smtp`), password sealed with the vault key |
| Workspace feature visibility | `GET/PUT /api/settings` (`features`) | `platform_settings` (`id: settings`) |

### Email delivery

Two independent paths, both using the same templates, recipient list, categories, 24-hour duplicate suppression, hourly limit and delivery history:

1. **Server transport** (`EMAIL_TRANSPORT=resend|sendgrid|postmark` with `EMAIL_API_KEY` and `EMAIL_FROM`). Applies to every workspace that has not switched on its own SMTP. Default `mock` sends nothing and keeps rendered mail in a per-workspace outbox.
2. **Workspace SMTP** (Settings → Email Notifications → SMTP configuration, owner/admin only). Requires a persistent `INTEGRATIONS_ENCRYPTION_KEY` (or a writable `WAYMARK_DATA_DIR` holding `vault.key`): without one the server refuses to store an SMTP password rather than keep it in a temporary key. The password is sealed with AES-256-GCM and never returned to the browser. SMTP is used for alerts only after a successful connection test and an explicit switch-on; changing host, port, security, username, password or sender switches it off until it is tested again.

SMTP safety controls, server side:
- Hosts are resolved before each connection; private, loopback, link-local, CGNAT and reserved addresses are refused, and the connection goes to the checked address with TLS still verified against the hostname.
- Ports 25, 465, 587 and 2525 only. Certificate verification is always on (TLS 1.2 minimum). Unencrypted SMTP is refused.
- Connect/greeting/socket timeouts (`SMTP_TIMEOUT_MS`, default 10 s), 10 connection tests and 5 test emails per workspace per 10 minutes, plus the hourly email limit.
- Anonymous demo and local workspaces cannot use SMTP unless `EMAIL_ALLOW_ANONYMOUS=true` (single-user local installs only).
- Outbound SMTP (465/587) must be allowed by the host's firewall; several platforms block port 25.

Development only: `SMTP_ALLOW_PRIVATE_HOSTS=true` permits a local mail catcher (for example Mailpit on `127.0.0.1:1025`) and any port, and `SMTP_ALLOW_INSECURE=true` permits the "None" security mode. Never set either in production.

"Accepted by the SMTP server" means the server took the message; it does not prove inbox delivery. Live delivery through any real provider has not been verified in this build (see the 3.0 implementation report).

## What works with no API at all

| Feature | Without the API |
| --- | --- |
| Command Center, map, shipments, simulator, alternatives, reports | Works |
| Delay Assist | Works. Emails are read by fixed patterns and messages use templates |
| AI Trade Analyst | Works. Answers are written from your records by fixed rules |
| World Situation | "Trade and tariffs" loads straight from GDELT when it allows the request. Other categories show a clear "unavailable" notice |
| Exchange rates | A dated Bank of Canada snapshot, labelled as such |
| Hub weather, Climatiq, supplier directory | Show an "unavailable" notice |

## Option A: Lovable (or any static host) with a Supabase Edge Function

Lovable hosts the static build and runs back-end code as Supabase Edge Functions. It does not run the Express server in `server/`.

1. Import the repository into Lovable, or connect it through GitHub. The build command is `npm run build` and the output folder is `dist`.
2. Set the public build variables in Lovable:
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for real accounts.
   - `VITE_API_BASE=https://<project-ref>.supabase.co/functions/v1/waymark-api` to use the Edge Function below.
3. Run `supabase/migrations/0001_waymark_schema.sql` and `supabase/migrations/0002_waymark_platform.sql` in order on the Supabase project. The new platform tables require Express with the server service-role key.
4. Deploy the Edge Function and set its secrets:
   ```bash
   supabase functions deploy waymark-api --no-verify-jwt
   supabase secrets set LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... ALLOWED_ORIGINS=https://your-site.example
   ```
   `--no-verify-jwt` lets demo and local-workspace visitors, who have no account, reach the function. Set `ALLOWED_ORIGINS` so only your site can call it from a browser.
5. Open `https://<project-ref>.supabase.co/functions/v1/waymark-api/health`. It should return `{"ok":true,...}`.

The Edge Function serves `/health`, `/news`, `/agent/delay` and `/analyst`. It shares its code with the Node API (`supabase/functions/_shared/`). The other API routes (exchange rates, weather, Climatiq, supplier search, aircraft) are not ported, so on this option those features use their fallbacks.

**Not verified:** the Edge Function has not been run. The test suite uses Node, and Deno was not available where this was built. The shared handlers it calls are covered by the Node tests. Check `/health` and one request to each route after deploying.

## Option B: a Node host for the full API

Run the Express server on any Node 20.19+ host (Render, Railway, Fly.io, a VPS).

- **One service:** `npm run build && npm start` serves the site and the API together on `API_PORT`. Nothing else to configure.
- **Split:** host `dist/` anywhere static, run `npm start` on the Node host, set `VITE_API_BASE=https://your-api.example/api` at build time, and add the site's address to `ALLOWED_ORIGINS` on the server.

## Environment variables

Server-only secrets (never prefix these with `VITE_`):

| Variable | Purpose |
| --- | --- |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | AI provider for Delay Assist and the AI Trade Analyst. Any OpenAI-compatible endpoint. There is no default model name |
| `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL` | Second provider, tried when the first fails or its quota runs out |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Used for recommendation explanations, and as the last AI provider |
| `AI_DAILY_LIMIT` | AI calls per account per day. Default 200 |
| `CLIMATIQ_API_KEY` | Emissions (Node API only) |
| `ALLOWED_ORIGINS` | Sites allowed to call the API from a browser |
| `INTEGRATIONS_ENCRYPTION_KEY` | Seals stored credentials, including workspace SMTP passwords. Keep stable and backed up |
| `WAYMARK_DATA_DIR` | Durable private volume for the file store (and `vault.key` when no encryption key is set) |
| `EMAIL_TRANSPORT`, `EMAIL_API_KEY`, `EMAIL_FROM` | Server email provider: `mock` (default), `resend`, `sendgrid` or `postmark` |
| `EMAIL_ALLOWED_DOMAINS`, `EMAIL_HOURLY_LIMIT` | Optional recipient domain allowlist; per-workspace hourly limit (default 30) |
| `EMAIL_ALLOW_ANONYMOUS` | `true` lets anonymous/local workspaces send live mail and use SMTP. Local single-user installs only |
| `SMTP_TIMEOUT_MS` | SMTP connect/greeting timeout, 2,000–30,000 ms (default 10,000) |
| `SMTP_ALLOW_PRIVATE_HOSTS`, `SMTP_ALLOW_INSECURE` | Development only: local mail catcher, unencrypted SMTP. Leave unset in production |

Public, bundled into the browser:

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE` | Where the API is. Empty means same origin, `/api` |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Supabase project for accounts |

## Checks after deploying

1. Refresh the browser on `/app/shipments`. The page must load, not 404. Static hosts need a single-page-app fallback to `index.html`. Lovable provides one, and `public/_redirects` covers Netlify-style hosts.
2. Open the Command Center. The 3D scene should show your models, which are served from `/models/`.
3. In Supabase, add your site's address under Authentication, URL Configuration, so sign-in emails link back to it.
4. Open World Situation and Delay Assist once each.

## News sources and their terms

World Situation reads headline metadata (title, publisher, date, link) from Google News RSS search and from GDELT. It does not download or republish article text. Google's RSS feeds are intended for personal feed readers, so for a commercial launch replace this source with a licensed news API. The fetching is isolated in `supabase/functions/_shared/news.js`.
