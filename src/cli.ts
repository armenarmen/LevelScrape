// One-shot search from the terminal, no HTTP server involved.
//   npm run search -- "best pizza nyc"
//   npm run search -- "best pizza nyc" --page 2 --fresh
// Prints the same JSON that GET /search returns. Logs go to stderr so you can pipe to jq.
import { existsSync } from "fs";
import { join } from "path";
import { closeBrowser, getContext, initBrowser, withPage } from "./browser.js";
import { loadConfig } from "./config.js";
import { BlockedError, ParseFailedError, createSearchService } from "./google/service.js";
import { warmup } from "./google/search.js";
import { initLogger, log, logToStderr } from "./logger.js";

function parseArgs(argv: string[]): { q: string; page: number; fresh: boolean } {
  const words: string[] = [];
  let page = 1;
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--page") page = Number(argv[++i] ?? 1);
    else if (a === "--fresh") fresh = true;
    else words.push(a);
  }
  return { q: words.join(" ").trim(), page, fresh };
}

async function main(): Promise<void> {
  const { q, page, fresh } = parseArgs(process.argv.slice(2));
  if (!q) {
    console.error('usage: npm run search -- "your query" [--page N] [--fresh]');
    process.exit(2);
  }

  logToStderr();
  if (!process.env.API_KEY) process.env.API_KEY = "cli"; // not needed for a local one-shot
  const cfg = loadConfig();
  initLogger(cfg.logRetentionDays);
  initBrowser(cfg);
  const service = createSearchService(cfg);

  let exitCode = 0;
  try {
    const firstLaunch = !existsSync(join(cfg.profileDir, "Default", "Cookies"));
    await getContext();
    if (firstLaunch) {
      log.info("first launch: warming up the profile on google.com");
      await withPage((p) => warmup(p), { timeoutMs: 90_000, label: "warmup" });
    }

    const result = await service.search({ q, page, gl: cfg.googleGl, hl: cfg.googleHl, udm: cfg.googleUdm, fresh });
    console.log(JSON.stringify(result, null, 2));
    if (result.results.length === 0) log.warn("zero results (Google said no results for this query)");
  } catch (err) {
    exitCode = 1;
    if (err instanceof BlockedError) {
      log.error(`Google blocked this request. Cooling down for ${err.retryAfterSec}s.`);
    } else if (err instanceof ParseFailedError) {
      log.error("Page loaded but no results were recognised. Google's markup may have changed.");
      if (err.debugFile) log.error(`The page HTML was saved to ${err.debugFile}. Copy it to test/fixtures/ and fix src/google/parse.ts.`);
    } else {
      log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    }
  } finally {
    service.shutdown();
    await closeBrowser();
  }
  process.exit(exitCode);
}

void main();
