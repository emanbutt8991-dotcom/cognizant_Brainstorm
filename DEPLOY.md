# Deploying Waymark

Waymark has two parts:

- **The front end**: a static React and Vite build (`npm run build` produces `dist/`).
- **The API**: optional. It adds live exchange rates, weather, Climatiq emissions, aggregated news and AI wording.

The front end works on its own. Every feature that needs the API has a labelled fallback, so a static deployment is complete and usable, with the differences listed below.

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
3. Run `supabase/migrations/0001_waymark_schema.sql` on the Supabase project. No new migration is needed for this release: Delay Assist stores its fields in the existing `details` columns and its records in `shipment_events`.
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
