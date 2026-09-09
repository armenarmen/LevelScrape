# CLAUDE.md

Project context for Claude Code.

## What this is

A self-hosted Scrapingbee replacement: Express 5 API in front of Playwright driving the machine's **real Google
Chrome** (`channel: "chrome"`), headful, with a persistent profile in `./data/profile`. `GET /search` returns
Google organic results as JSON; `GET /fetch` renders any public URL. Inspired by Pieter Levels' tweet about
replacing his $249/mo plan with a $1/mo VPS scraper. See README.md for the why.

```bash
npm install
cp .env.example .env   # set API_KEY
npm run build          # tsc
npm test               # parser fixture tests (node:test + linkedom)
npm run search -- "q"  # one-shot CLI, opens Chrome
npm run dev            # API on http://127.0.0.1:3456
```

**Do not start the server or the CLI yourself.** Armen starts them. Both open a real Chrome window and the CLI
hits Google. Ask, or describe what to run, rather than running `npm run dev`, `npm start`, or `npm run search`.

## Things that are easy to get wrong

- **Browser setup is chosen at runtime** (`src/environment.ts` → `chooseStrategies`, `src/browser.ts` → `launch`).
  The ladder is headful real Chrome → real Chrome on auto-started Xvfb → real Chrome new headless → Playwright
  Chromium variants. Playwright Chromium is the bottom for a reason: Google detects it instantly. Do not reorder.
  `BROWSER_MODE` forces a rung; `npm run doctor` shows detection. The Chromium rungs are the only place the
  anti-detection init script is used.
- **Anti-detection is the point.** Real Chrome, headful, `viewport: null`, no user-agent override, no
  fingerprint-spoofing init script, one Google hit every ~30 s with jitter, 24 h cache. Before making anything
  faster, more regular, or "more stealthy" via spoofing, assume the current choice is deliberate (README has the
  reasoning). `ignoreDefaultArgs` must stay an array; never `true`.
- **`src/browser.ts` is the only file that imports `playwright`'s `chromium`.** Keep it that way so swapping to a
  stealth fork (e.g. patchright) stays a one-file change.
- **`extractOrganic` in `src/google/parse.ts` runs inside the browser.** It is sent as source text via
  `toString()`, so it must not reference anything outside its own body: no imports, no module-level helpers. It
  must also stay pure so `test/parse.test.ts` can run it on saved HTML with linkedom. Do not use Google class names
  in selectors; they rotate.
- **Selector changes are unverified until a live run.** `npm test` passing against fixtures means the parser
  handles the HTML we have seen, not today's Google. Say so plainly.
- **Never run `npx playwright install chrome`.** `channel: "chrome"` uses the installed app.
- **Never point `PROFILE_DIR` at a real Chrome profile.** Chrome refuses to automate its default profile.
- **`data/` is irreplaceable and gitignored.** Profile cookies carry the "trust" that makes this work. All state
  paths are relative; always launch from the project root.
- **The keep-alive tab.** A persistent context exits Chrome when its last tab closes. `browser.ts` pins the
  initial `about:blank` tab and every job uses `withPage()` for its own tab. Don't close pages any other way.
- **Shutdown must be clean.** `closeBrowser()` flushes the profile. On Linux, that is why the systemd unit runs
  node directly rather than through `xvfb-run` (bash would swallow SIGTERM).
- **`/fetch` has an SSRF guard** (`assertPublicHttpUrl`). Keep it; the API key holder can otherwise browse the host's LAN.

## Conventions

- ESM with NodeNext: **relative imports need the `.js` extension**, including from `.ts` files.
- Route handlers validate then `res.status(400).json({ error }); return;`. Express 5 forwards async rejections to
  the error middleware at the bottom of `src/server.ts`, which maps typed errors to status codes.
- Config comes from `.env` via `src/config.ts` only. Every variable is documented in `.env.example`.
- Logs: `log.info/warn/error` for console; `logRequest()` for the JSONL request log that feeds `/stats`.

- **Google wraps result links in `google.com/goto?url=<encrypted>` (since Aug 2026).** The real URL is not in the
  page. `src/google/resolve.ts` follows each redirect (302 + Location) through the context's request client with
  small gaps and a 7-day memo. The parser keeps `/goto` links and flags them with `gotoUrl`; never "fix" the parser
  by filtering Google-hosted links again.
- **Everything in `src/extract/` runs both inside Chrome (via `toString()` into `page.evaluate`) and in Node on
  linkedom documents** (plain mode). Same self-contained rule as `extractOrganic`; also avoid browser-only APIs
  (`innerText`, `naturalWidth`) without a fallback. `extractSerpExtras` in `src/google/parse.ts` has the same rule.
- **`/fetch` defaults to `mode=auto`** (`src/plainfetch.ts` decides whether a plain HTTP response is complete).
  The judge is heuristic; if a site returns usable-looking HTML that is actually a shell, add a signature to it.
- **AI extraction is optional and provider-agnostic** (`src/ai.ts`, any OpenAI-compatible `/chat/completions`).
  Never hardcode a provider; the user plugs in `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`.
- **`src/mcp.ts` is a thin client of the HTTP API**, not a second implementation. Keep it that way.
- **`humanClick` must scroll the target into view first.** `page.mouse.click` at coordinates outside the viewport hits
  nothing and reports success; this cost an hour on the Smartwool "Load more" button. Playwright's `locator.click`
  auto-scrolls, raw mouse clicks do not.

## Current state (Sept 2026)

- ScrapingBee-parity pass done 2026-09-09: `extract_rules`, `format=markdown`, SERP extras (PAA, related, local pack,
  result count; ads/knowledge panel unverified), `mode=auto` plain-first fetching, optional AI extraction, MCP server,
  POST /fetch, full-page/element screenshots, `full_html` on /search. Default `GOOGLE_UDM` switched 14 → 0.
  `js_scenario` (click/wait/scroll/fill/evaluate/infinite_scroll) added after; verified loading all 56 Smartwool
  products via three "Load more" clicks.

- **Benchmark 2026-09-09** (`scripts/benchmark.ts`, results in `data/exports/benchmark/`): 100 travel/purchase
  queries from the Mac's home IP at 30s pacing. 94/100 first pass, 100/100 after retrying the 6 that landed inside
  captcha pauses. 0 parse failures, 939/939 `/goto` links resolved, 0 empty snippets. Google served a captcha
  after ~41 consecutive queries (twice), i.e. roughly every 20 minutes of continuous searching; a 5 min cooldown
  cleared it both times. Five non-US `gl=` queries all passed. Page enrichment (`scripts/enrich.ts`) on 48 top
  results: 48/48 fetched HTTP 200; 31 were articles/listings with usable description+image+text, 11 were
  Reddit/Facebook/YouTube (thin beyond OG tags), 5 were thin index/search pages.
- Live fixture: `test/fixtures/serp-live-2026-09-09.html`.
- Scale: `/fetch?format=meta` verified on 7 third-party pages (WordPress, Webflow, Shopify, Facebook, Instagram).
- No proxy configured. Add `PROXY_URL` only when `/stats` shows the success rate dropping.
- `deploy/` (Ubuntu setup script + one systemd unit; the app starts Xvfb itself) is written but untested on a
  real VPS. Headless rungs verified on the Mac via `npm run doctor -- --launch`.
