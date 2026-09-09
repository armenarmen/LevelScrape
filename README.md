# LevelScrape

A self-hosted replacement for Scrapingbee's two main jobs, built the way [Pieter Levels described](https://x.com/levelsio) replacing his $249/mo plan with a $1/mo scraper on a VPS:

1. **`/search`** – run a Google search, get the organic results back as JSON.
2. **`/fetch`** – load any public URL in a real browser (JavaScript and all) and get the HTML or text back.

Playwright driving a **real Google Chrome**, **headful** (a real window), with a **persistent profile**,
going **slowly** (one Google hit every ~30 s), with room to plug in a residential proxy later.

## Why this works when "headless Chrome" gets blocked

Scraping Google is a cat-and-mouse game, and most tools lose it immediately. Here's what each piece buys you:

| Piece | What it means | Why it matters |
|---|---|---|
| **Real Chrome, not Chromium** | Playwright's `channel: "chrome"` launches the Chrome app already installed on your machine | Headless Chromium has a fingerprint Google recognises in milliseconds. Real Chrome looks like... Chrome. |
| **Headful** | An actual window opens. On a VPS we fake a monitor with Xvfb. | "Headless mode" itself is detectable. |
| **Persistent profile** | Cookies and settings are kept in `./data/profile` between runs | Every request comes from a "browser that has been around for a while", not a brand-new one. Google's consent cookie is accepted once and remembered. |
| **No spoofing** | We do **not** fake the user agent, WebGL, plugins, etc. | Faked values contradict each other (e.g. a "Mac" user agent on a machine whose Client Hints say Linux). Honest is safer. |
| **Pacing** | One Google hit per ~30 s, randomised, max 400/day | Speed is the number-one bot tell. |
| **Cache** | Identical searches within 24 h never touch Google | The safest Google request is the one you don't make. |
| **Manual captcha solve** | If Google shows a captcha, the window pops to the front and the server waits for you to solve it | Solving it in the same profile actually restores trust. This only works on a machine with a screen. |

Google's own terms don't allow automated querying. This is a personal tool; use it like Levels does, quietly and slowly.

## Setup (Mac)

Requirements: Node 20+, Google Chrome installed in `/Applications`.

```bash
git clone https://github.com/armenarmen/LevelScrape.git && cd LevelScrape
npm install
cp .env.example .env          # then set API_KEY (openssl rand -hex 32)
npm run build
```

Do **not** run `npx playwright install chrome`; it is not needed and can overwrite your Chrome.

### First test, no server

```bash
npm run search -- "best pizza nyc"
```

A Chrome window opens, visits google.com once to pick up cookies (first run only), then searches. You get JSON on stdout.
The second time you run it, the result comes from cache instantly.

### Run the API

```bash
npm run dev        # development (auto-restarts on code changes)
npm start          # production (after npm run build)
```

```bash
export KEY=...     # your API_KEY
curl -H "x-api-key: $KEY" "http://localhost:3456/health"
curl -H "x-api-key: $KEY" "http://localhost:3456/search?q=playwright+channel+chrome"
curl -H "x-api-key: $KEY" "http://localhost:3456/fetch?url=https://example.com&format=text"
curl -H "x-api-key: $KEY" "http://localhost:3456/stats"
```

## API

Every route needs the key, as an `x-api-key` header or `?api_key=` query param. Errors are `{ "error": "..." }`.

### `GET /search`

| Param | Default | Notes |
|---|---|---|
| `q` | required | The search |
| `page` | `1` | 1–5. Ten results per page. |
| `gl` | `GOOGLE_GL` | Country, e.g. `us` |
| `hl` | `GOOGLE_HL` | Language, e.g. `en` |
| `udm` | `GOOGLE_UDM` (`0`) | `0` = normal results (has People Also Ask, related searches, local pack). `14` = "Web" tab, organic only. |
| `fresh` | `0` | `1` = skip the cache |
| `full_html` | `0` | `1` = include the raw results page HTML (for saving fixtures) |

```json
{
  "query": "playwright channel chrome",
  "page": 1,
  "results": [
    { "position": 1, "title": "...", "url": "https://...", "gotoUrl": "https://www.google.com/goto?url=...", "displayedUrl": "playwright.dev › docs", "snippet": "...", "sitelinks": [ { "title": "...", "url": "..." } ] }
  ],
  "resultCount": 55000000,
  "peopleAlsoAsk": ["What are some of the best natural hot springs in Nevada?", "..."],
  "relatedSearches": ["Spencer hot springs", "..."],
  "localResults": [ { "name": "Carson Hot Springs", "rating": 4.4, "reviews": "2.1K", "details": "Outdoor bath, Carson City, NV ..." } ],
  "ads": [], "knowledgeGraph": null,
  "cached": false,
  "fetchedAt": "2026-09-09T18:00:00.000Z",
  "elapsedMs": 4120
}
```

`ads` and `knowledgeGraph` parsers are written from Google's known markup but have not been exercised by a live capture yet.

**About `gotoUrl`.** Since August 2026 Google no longer puts real URLs in result links; every link is an encrypted
`google.com/goto?url=...` redirect (Google says this is an anti-abuse measure, and it mostly hurts scrapers). The scraper
follows each redirect with a tiny request through the same Chrome session, spaced a few hundred ms apart, and puts the real
destination in `url`. `gotoUrl` is kept so you can tell. If `url` still equals `gotoUrl`, resolution failed for that one.
Set `GOOGLE_RESOLVE_GOTO=0` to skip resolving (you still get the site's hostname in `displayedUrl`).

Status codes: `429 blocked` (Google showed a block page; `retryAfter` seconds and a `Retry-After` header are included),
`429 daily_limit`, `502 parse_failed` (see below), `503 queue_full` / `browser_down`, `504 timeout`.

### `GET /fetch` (or `POST /fetch` with a JSON body)

| Param | Default | Notes |
|---|---|---|
| `url` | required | Public http(s) URL only. Private/loopback addresses are refused. |
| `mode` | `FETCH_DEFAULT_MODE` (`auto`) | `auto` = plain HTTP request first, Chrome only if the page needs JavaScript. `browser` = always Chrome. `plain` = never Chrome. |
| `format` | `html` | `html`, `text`, `markdown`, `meta`, or `none`. Defaults to `none` when `extract_rules` or AI params are given. |
| `extract_rules` | | JSON of CSS selectors → structured JSON (below) |
| `ai_query` | | A question about the page, answered by your LLM (requires `AI_*` config) |
| `ai_extract_rules` | | `{field: "description"}` → JSON extracted by your LLM |
| `wait` | | CSS selector to wait for (forces browser) |
| `wait_ms` | | Fixed delay after load, 0–35000 (forces browser) |
| `wait_browser` | `domcontentloaded` | `load`, `domcontentloaded`, or `networkidle` |
| `block_resources` | `0` | `1` = skip images, fonts, media in browser mode (faster) |
| `screenshot` / `screenshot_full_page` / `screenshot_selector` | | PNG. Returned raw when it's the only output, else as `screenshotBase64` |
| `transparent_status_code` | `0` | `1` = respond with the target site's status code |

Response: `{ url, finalUrl, status, title, mode, modeReason, html | text | markdown | meta, extracted?, ai?, truncated, elapsedMs }`.
`mode` tells you whether the plain request was enough (`plain`) or Chrome rendered it (`browser`), and `modeReason` says why.

**`extract_rules`** (same shape as ScrapingBee's). A value is a selector string, or an object with `selector`, `type` (`item` | `list`),
and `output` (`text` | `html` | `inner_html` | `@attr` | nested rules). `@href` / `@src` come back as absolute URLs.

```json
{ "title": "h1",
  "products": { "selector": ".product-card", "type": "list",
                "output": { "name": ".title", "price": ".price", "url": { "selector": "a", "output": "@href" }, "img": { "selector": "img", "output": "@src" } } } }
```

```bash
curl -G -H "x-api-key: $KEY" http://localhost:3456/fetch \
  --data-urlencode "url=https://books.toscrape.com/" \
  --data-urlencode 'extract_rules={"books":{"selector":".product_pod","type":"list","output":{"title":{"selector":"h3 a","output":"@title"},"price":".price_color"}}}'
```

**`format=meta`** is the link-preview / SEO view: title, description, canonical, h1s, Open Graph, Twitter card, all meta tags,
JSON-LD, the largest images, a main image, and the first 2000 chars of article text. For product pages, price and brand are
almost always in `meta.jsonLd` (schema.org `Product` → `offers.price`, `brand.name`).

**`format=markdown`** strips nav/header/footer, prefers `<article>`/`<main>`, and converts the rest to Markdown. This is
also what gets sent to the model for AI extraction.

**AI extraction** is optional and provider-agnostic: set `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` to any OpenAI-compatible
chat-completions endpoint (OpenAI, xAI, Anthropic's compatibility endpoint, OpenRouter, Meta, a local server). Then:

```bash
curl -G -H "x-api-key: $KEY" http://localhost:3456/fetch --data-urlencode "url=https://shop.example/p/123" \
  --data-urlencode 'ai_extract_rules={"price":"numeric price in USD","brand":"brand name","sizes":"list of available sizes"}'
```

### `GET /health`, `GET /stats`

`/health` shows browser state, queue depth, cooldown, and whether a captcha is waiting for a human.
`/stats` shows the last 24 h: searches, ok, blocked, parse failures, cached, and `successRate` (Levels' "90%").

## Configuration

See `.env.example`; every variable is documented there. The ones you'll actually touch:

- `GOOGLE_MIN_INTERVAL_MS` – slower is safer. 30000 is the Levels number.
- `PROXY_URL` – add a residential proxy when your own IP starts getting blocked (`/stats` will show it).
  Use an HTTP proxy with `user:pass@`. Set `PROXY_LOCALE` / `PROXY_TZ` / `GOOGLE_GL` to the proxy's country.
- `CAPTCHA_MANUAL_SOLVE` – `1` on a Mac you can see, `0` on a server.

## Where things live

```
data/profile/   Chrome profile (cookies). Back this up; losing it means starting "trust" from zero.
data/cache.json Search cache, saved on shutdown.
data/logs/      One JSONL line per request, daily files, 14-day retention.
data/debug/     HTML of pages the parser couldn't read (last 20).
```

Everything under `data/` is gitignored. Always start the app from the project root (paths are relative).

## Fixing the parser

Google changes its HTML regularly. The parser (`src/google/parse.ts`) deliberately ignores class names and
looks at structure: a link that contains an `<h3>` is a result; the nearest ancestor with `data-hveid` is the result card.

When a search returns `502 parse_failed`:

1. Look in `data/debug/` for the saved page. Open it in a browser to see what Google actually sent.
2. Copy it to `test/fixtures/serp-live-<date>.html`.
3. Run `npm test`. It fails. Edit `extractOrganic` until it passes. The function is plain DOM code and must stay
   self-contained (it is sent into the browser as text).

## Using it from Claude Code (MCP)

The scraper ships an MCP server that exposes `google_search`, `fetch_page`, `extract_from_page`, `ai_extract_from_page`
and `scraper_status` as tools. Start the API, then:

```bash
claude mcp add levels-scraper -e API_KEY=<your key> -e BASE_URL=http://127.0.0.1:3456 -- node /ABSOLUTE/PATH/TO/LevelScrape/dist/mcp.js
```

## Measuring success rate

```bash
npx tsx scripts/benchmark.ts data/exports/benchmark/queries.json data/exports/benchmark/run-$(date +%F).jsonl
npx tsx scripts/enrich.ts   data/exports/benchmark/run-$(date +%F).jsonl data/exports/benchmark/enrich-$(date +%F).json 12 2
```

The first runs every query in the file through `/search` one at a time (the server paces them) and prints a
pass rate; it resumes if interrupted and sleeps through Google cooldowns. The second opens the top results of a
spread of successful queries with `/fetch?format=meta` and judges whether each page yielded usable data.
Baseline from 2026-09-09 on a home IP: 94/100 first pass, 100/100 with retries; Google serves a captcha after
roughly 40 consecutive queries at 30 s pacing, and a 5 minute cooldown clears it.

## Deploying to a VPS (phase 2)

A server has no screen, so Chrome draws into Xvfb, a fake monitor. Everything is in `deploy/`:

```bash
# on the VPS, as root
TZ_NAME=America/New_York bash deploy/setup-ubuntu.sh    # Node 22, real Chrome, Xvfb, fonts, `scraper` user
# then follow the printed steps: copy project, npm ci && npm run build, create .env, systemctl enable --now levels-scraper
```

Notes for the VPS:

- Set `CAPTCHA_MANUAL_SOLVE=0` there. Nobody can see the window. (If you want to, `x11vnc -display :99` lets you.)
- Keep `HOST=127.0.0.1` and put Caddy / nginx / a Cloudflare Tunnel in front for HTTPS.
- **Expect a datacenter IP to get blocked within hours.** That's normal; Levels hit the same wall. The cache and pacing
  buy time, but the real fix is `PROXY_URL` pointing at a residential proxy whose country matches `GOOGLE_GL`.
- An always-on Mac (like a Mac mini) is honestly a better host than a VPS: real GPU, real fonts, residential IP,
  and you can solve captchas.
- Chrome updates are held (`apt-mark hold`). To update: `apt-mark unhold google-chrome-stable && apt upgrade && systemctl restart levels-scraper`.

## License

MIT
