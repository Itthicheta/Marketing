# Dashboard (Cloudflare Pages)

Static single-page dashboard. `index.html` + `data.js`, no build step, no external
libraries. Currently running on SYNTHETIC data (see the badge in the header).

## Deploy — connect Cloudflare Pages to GitHub (one-time, ~2 min)

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
2. Pick the `Itthicheta/Marketing` repository (authorize the Cloudflare GitHub App if asked)
3. Build settings: Framework preset **None**, Build command **(empty)**,
   Build output directory **`dashboard`**
4. Production branch: your default branch (deploys happen on every push)
5. After the first deploy: **add Cloudflare Access** in Zero Trust → Access →
   Applications, so the URL requires login (revenue data!)

To verify the connection from GitHub: repo **Settings → GitHub Apps** shows
"Cloudflare Workers and Pages"; each commit gets a Pages deployment check.

## Wiring real data (phase 4)

Replace the synthetic `loadData()` in `data.js` with a fetch to the Worker proxy
that queries the Supabase `marts` views with the service key. The synthetic
shapes already mirror the views' columns, so charts need no changes.
