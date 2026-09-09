// The ONLY file that imports Playwright's `chromium`. If Google ever starts
// blocking plain Playwright, swapping to a fork like `patchright` is a one-line
// change here and nowhere else.
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Config } from "./config.js";
import type { BrowserState } from "./types.js";
import { sleep } from "./humanize.js";
import { log } from "./logger.js";

let cfg: Config;
let context: BrowserContext | null = null;
let keepAlive: Page | null = null;          // see getContext() for why this exists
let launching: Promise<BrowserContext> | null = null;
let launchedAt: string | null = null;
let consecutiveLaunchFailures = 0;
let closingOnPurpose = false;

export function initBrowser(config: Config): void {
  cfg = config;
}

export class JobTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * "http://user:pass@host:port" -> Playwright's { server, username, password }.
 * (reddit-poster's version emitted "host:" when the port was missing; fixed here.)
 */
export function parseProxyUrl(raw: string): { server: string; username?: string; password?: string } {
  const u = new URL(raw);
  const port = u.port ? `:${u.port}` : "";
  return {
    server: `${u.protocol}//${u.hostname}${port}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/**
 * If Chrome was killed hard (crash, SIGKILL, power loss) it leaves lock files in
 * the profile and then refuses to start with "profile in use". Only safe to call
 * when we KNOW no Chrome is using this profile, i.e. right before we launch one.
 */
export function cleanStaleLocks(profileDir: string): void {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(profileDir, f), { force: true });
  }
}

async function launch(): Promise<BrowserContext> {
  mkdirSync(cfg.profileDir, { recursive: true });
  cleanStaleLocks(cfg.profileDir);

  const { width, height } = cfg.windowSize;
  const opts: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> = {
    // Use the Google Chrome that is installed on this machine, not Playwright's
    // bundled Chromium. Real Chrome has a real fingerprint; that is the whole trick.
    channel: "chrome",
    headless: cfg.headless,
    // null = let the actual window size be the viewport. Playwright's default
    // (a fixed 1280x720 emulated viewport) makes screen/inner/outer sizes all
    // identical, which is a well known automation tell.
    viewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--window-size=${width},${height}`,
      "--window-position=0,0",
    ],
    // Playwright adds --enable-automation by default, which sets
    // navigator.webdriver = true and shows the "controlled by automated software"
    // bar. Remove just that one flag. Never pass ignoreDefaultArgs: true.
    ignoreDefaultArgs: ["--enable-automation"],
    // We own shutdown ourselves in index.ts so the profile is flushed cleanly.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };

  if (cfg.proxyUrl) {
    opts.proxy = parseProxyUrl(cfg.proxyUrl);
    // Only override locale/timezone when going through a proxy, so they match
    // the proxy's country. Without a proxy, Chrome's real values are the most
    // believable ones.
    if (cfg.proxyLocale) opts.locale = cfg.proxyLocale;
    if (cfg.proxyTz) opts.timezoneId = cfg.proxyTz;
  }

  log.info(`launching Chrome (channel=chrome, headless=${cfg.headless}, profile=${cfg.profileDir}${cfg.proxyUrl ? ", proxy=on" : ""})`);
  const ctx = await chromium.launchPersistentContext(cfg.profileDir, opts);

  // A persistent context starts with one about:blank tab. If the LAST tab is
  // closed, Chrome exits. So we pin this tab and never close it; every job gets
  // its own fresh tab via withPage().
  keepAlive = ctx.pages()[0] ?? (await ctx.newPage());

  ctx.on("close", () => {
    if (closingOnPurpose) log.info("browser closed");
    else log.warn("browser context closed unexpectedly; will relaunch on next job");
    context = null;
    keepAlive = null;
    launchedAt = null;
  });

  return ctx;
}

export async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  if (launching) return launching;

  launching = (async () => {
    try {
      if (consecutiveLaunchFailures > 0) {
        const backoff = Math.min(30_000, 1000 * 2 ** consecutiveLaunchFailures);
        log.warn(`browser relaunch attempt ${consecutiveLaunchFailures + 1}, waiting ${backoff}ms`);
        await sleep(backoff);
      }
      const ctx = await launch();
      context = ctx;
      launchedAt = new Date().toISOString();
      consecutiveLaunchFailures = 0;
      return ctx;
    } catch (err) {
      consecutiveLaunchFailures++;
      throw err;
    } finally {
      launching = null;
    }
  })();

  return launching;
}

export interface JobControl {
  /** Push the deadline out, e.g. while a human is solving a captcha. */
  extendTimeout(ms: number): void;
}

/**
 * Run fn with a fresh tab that is always closed afterwards, racing a timeout.
 * Most bugs in browser automation are leaked tabs; this is the one place tabs
 * are opened and closed.
 */
export async function withPage<T>(
  fn: (page: Page, ctl: JobControl) => Promise<T>,
  opts: { timeoutMs: number; label: string },
): Promise<T> {
  const ctx = await getContext();
  const page = await ctx.newPage();

  let timer: NodeJS.Timeout | undefined;
  let rejectTimeout: (e: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(() => reject(new JobTimeoutError(opts.label, opts.timeoutMs)), opts.timeoutMs);
  });
  const ctl: JobControl = {
    extendTimeout(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => rejectTimeout(new JobTimeoutError(opts.label, ms)), ms);
    },
  };

  try {
    return await Promise.race([fn(page, ctl), timeout]);
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => {});
  }
}

export function browserState(): BrowserState {
  if (context) {
    return {
      status: "up",
      launchedAt,
      openPages: Math.max(0, context.pages().length - (keepAlive ? 1 : 0)),
    };
  }
  return { status: launching ? "starting" : "down", launchedAt: null, openPages: 0 };
}

export async function closeBrowser(): Promise<void> {
  const ctx = context;
  context = null;
  keepAlive = null;
  closingOnPurpose = true;
  if (ctx) {
    // context.close() flushes cookies and preferences to disk. Killing the
    // process instead leaves half-written SQLite journals in the profile.
    await ctx.close().catch((e) => log.warn(`error closing browser: ${String(e)}`));
  }
}
