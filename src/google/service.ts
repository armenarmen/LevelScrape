// Ties together: cache -> coalesce -> paced queue -> browser tab -> runSearch -> log.
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Page } from "playwright";
import type { Config } from "../config.js";
import type { SearchOutcome, SearchParams, SearchResponse } from "../types.js";
import { JobTimeoutError, withPage, type JobControl } from "../browser.js";
import { TtlLru, coalesce, searchCacheKey } from "../cache.js";
import { log, logRequest } from "../logger.js";
import { PacedSerialQueue } from "../queue.js";
import { BlockPolicy, waitForHumanSolve } from "./block.js";
import { runSearch } from "./search.js";

const CACHE_FILE = "./data/cache.json";
const DEBUG_DIR = "./data/debug";
const DEBUG_KEEP = 20;

export class BlockedError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super("blocked");
    this.name = "BlockedError";
  }
}

export class ParseFailedError extends Error {
  constructor(public readonly debugFile: string | null) {
    super("parse_failed");
    this.name = "ParseFailedError";
  }
}

export interface SearchServiceState {
  blocked: boolean;
  cooldownUntil: string | null;
  retryAfterSec: number;
  awaitingHuman: boolean;
  captchaSince: string | null;
  queueDepth: number;
  googleHitsToday: number;
  cacheSize: number;
}

export interface SearchService {
  search(p: SearchParams, opts?: { fullHtml?: boolean }): Promise<SearchResponse>;
  state(): SearchServiceState;
  shutdown(): void;
}

/** Save the HTML of a page we couldn't parse, so the parser can be fixed against it. */
export function dumpDebugHtml(html: string): string | null {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const file = join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    writeFileSync(file, html);
    const all = readdirSync(DEBUG_DIR).filter((f) => f.endsWith(".html")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - DEBUG_KEEP))) unlinkSync(join(DEBUG_DIR, old));
    return file;
  } catch (e) {
    log.warn(`could not write debug html: ${String(e)}`);
    return null;
  }
}

export function createSearchService(cfg: Config): SearchService {
  const queue = new PacedSerialQueue({
    minIntervalMs: cfg.googleMinIntervalMs,
    jitterPct: cfg.googleJitterPct,
    maxPending: cfg.queueMaxPending,
    dailyMax: cfg.googleDailyMax,
  });
  const cache = new TtlLru<SearchResponse>(cfg.cacheMax, cfg.cacheTtlMs);
  const loaded = cache.load(CACHE_FILE);
  if (loaded) log.info(`cache: restored ${loaded} entries from ${CACHE_FILE}`);
  const inflight = new Map<string, Promise<SearchResponse>>();
  const policy = new BlockPolicy();

  async function onCaptcha(page: Page, ctl: JobControl): Promise<boolean> {
    if (!cfg.captchaManualSolve) return false;
    log.warn("=================================================================");
    log.warn(" CAPTCHA from Google. Solve it in the Chrome window that just came");
    log.warn(` to the front. Waiting up to ${Math.round(cfg.captchaWaitMs / 60_000)} min. Queue is paused.`);
    log.warn("=================================================================");
    policy.awaitingHuman = true;
    policy.captchaSince = new Date().toISOString();
    queue.pause();
    ctl.extendTimeout(cfg.captchaWaitMs + 20_000);
    try {
      const solved = await waitForHumanSolve(page, cfg.captchaWaitMs);
      log.warn(solved ? "captcha solved, resuming" : "captcha not solved in time");
      return solved;
    } finally {
      policy.awaitingHuman = false;
      policy.captchaSince = null;
      queue.resume();
    }
  }

  async function runJob(p: SearchParams, key: string, fullHtml: boolean): Promise<SearchResponse> {
    // A block may have happened while this job sat in the queue.
    if (policy.isBlocked()) throw new BlockedError(policy.retryAfterSec());

    const t0 = Date.now();
    let outcome: SearchOutcome;
    try {
      outcome = await withPage((page, ctl) => runSearch(page, p, { onCaptcha: (pg) => onCaptcha(pg, ctl), resolveGoto: cfg.googleResolveGoto, includeHtml: fullHtml }), {
        timeoutMs: cfg.searchTimeoutMs,
        label: `search "${p.q}"`,
      });
    } catch (err) {
      logRequest({
        ts: new Date().toISOString(),
        kind: "search",
        target: p.q,
        outcome: err instanceof JobTimeoutError ? "timeout" : "error",
        ms: Date.now() - t0,
        detail: String(err instanceof Error ? err.message : err),
      });
      throw err;
    }
    const ms = Date.now() - t0;

    if (outcome.kind === "blocked") {
      const cooldown = policy.onBlock();
      logRequest({ ts: new Date().toISOString(), kind: "search", target: p.q, outcome: "blocked", ms, detail: `${outcome.block}, cooldown ${Math.round(cooldown / 1000)}s` });
      throw new BlockedError(policy.retryAfterSec());
    }
    if (outcome.kind === "parse_failed") {
      const file = dumpDebugHtml(outcome.html);
      logRequest({ ts: new Date().toISOString(), kind: "search", target: p.q, outcome: "parse_failed", ms, detail: file ? `html saved to ${file}` : undefined });
      throw new ParseFailedError(file);
    }

    policy.onSuccess();
    const resp: SearchResponse = {
      query: p.q,
      page: p.page,
      results: outcome.results,
      ...outcome.extras,
      cached: false,
      fetchedAt: new Date().toISOString(),
      elapsedMs: ms,
    };
    if (fullHtml) resp.html = outcome.html;
    // "No results" pages are cached for less time; they're more likely to change.
    cache.set(key, resp, outcome.noResults ? Math.min(cfg.cacheTtlMs, 3_600_000) : undefined);
    logRequest({ ts: resp.fetchedAt, kind: "search", target: p.q, outcome: "ok", ms, n: resp.results.length });
    return resp;
  }

  return {
    async search(p, opts = {}) {
      const key = searchCacheKey(p);
      const t0 = Date.now();
      const strip = (r: SearchResponse): SearchResponse => {
        if (opts.fullHtml) return r;
        const { html: _h, ...rest } = r;
        return rest;
      };
      if (!p.fresh) {
        const hit = cache.get(key);
        if (hit) {
          logRequest({ ts: new Date().toISOString(), kind: "search", target: p.q, outcome: "cached", ms: Date.now() - t0, n: hit.results.length });
          return strip({ ...hit, cached: true, elapsedMs: Date.now() - t0 });
        }
      }
      if (policy.isBlocked()) throw new BlockedError(policy.retryAfterSec());
      return strip(await coalesce(inflight, key, () => queue.enqueue(() => runJob(p, key, !!opts.fullHtml))));
    },

    state() {
      return {
        blocked: policy.isBlocked(),
        cooldownUntil: policy.isBlocked() ? new Date(policy.cooldownUntil).toISOString() : null,
        retryAfterSec: policy.isBlocked() ? policy.retryAfterSec() : 0,
        awaitingHuman: policy.awaitingHuman,
        captchaSince: policy.captchaSince,
        queueDepth: queue.depth,
        googleHitsToday: queue.todayCount,
        cacheSize: cache.size,
      };
    },

    shutdown() {
      try {
        cache.save(CACHE_FILE);
        log.info(`cache: saved ${cache.size} entries to ${CACHE_FILE}`);
      } catch (e) {
        log.warn(`cache save failed: ${String(e)}`);
      }
    },
  };
}
