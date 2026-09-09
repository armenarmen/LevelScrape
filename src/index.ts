import { existsSync } from "fs";
import { join } from "path";
import { browserState, closeBrowser, getContext, initBrowser, withPage } from "./browser.js";
import { loadConfig } from "./config.js";
import { createSearchService } from "./google/service.js";
import { warmup } from "./google/search.js";
import { sleep } from "./humanize.js";
import { initLogger, log } from "./logger.js";
import { ConcurrentQueue } from "./queue.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogger(cfg.logRetentionDays);
  initBrowser(cfg);

  const searchService = createSearchService(cfg);
  const fetchQueue = new ConcurrentQueue(cfg.fetchConcurrency, cfg.queueMaxPending);

  // Open Chrome now rather than on the first request. On the very first run the
  // profile is empty, so also visit google.com once to pick up baseline cookies.
  const firstLaunch = !existsSync(join(cfg.profileDir, "Default", "Cookies"));
  try {
    await getContext();
    if (firstLaunch) {
      log.info("first launch: warming up the profile on google.com");
      await withPage((page) => warmup(page), { timeoutMs: 90_000, label: "warmup" });
    }
  } catch (err) {
    log.error(`browser failed to launch: ${err instanceof Error ? err.message : String(err)}`);
    log.error("the API will start anyway and retry launching on the first request");
  }

  const app = createApp({ cfg, searchService, fetchQueue });
  const server = app.listen(cfg.port, cfg.host, () => {
    log.info(`listening on http://${cfg.host}:${cfg.port}`);
    const st = browserState();
    if (st.strategy) log.info(`browser: ${st.strategy} (${st.quality})`);
    log.info(`pacing: one Google hit every ~${Math.round(cfg.googleMinIntervalMs / 1000)}s (+/- ${cfg.googleJitterPct}%), max ${cfg.googleDailyMax}/day`);
  });
  // A /search can legitimately wait a long time (queue + pacing + a human solving a
  // captcha). Don't let Node kill the connection before that.
  server.requestTimeout =
    cfg.searchTimeoutMs + cfg.queueMaxPending * cfg.googleMinIntervalMs + (cfg.captchaManualSolve ? cfg.captchaWaitMs : 0) + 30_000;
  server.keepAliveTimeout = 65_000;

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal}: shutting down`);
    const hardExit = setTimeout(() => {
      log.error("shutdown took too long, exiting");
      process.exit(1);
    }, 25_000);
    hardExit.unref();

    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeIdleConnections();
    await Promise.race([closed, sleep(20_000)]);
    server.closeAllConnections();

    searchService.shutdown();
    await closeBrowser(); // flushes the Chrome profile to disk
    clearTimeout(hardExit);
    log.info("bye");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("unhandledRejection", (r) => log.error(`unhandled rejection: ${r instanceof Error ? r.stack ?? r.message : String(r)}`));
  process.on("uncaughtException", (e) => {
    log.error(`uncaught exception: ${e.stack ?? e.message}`);
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
