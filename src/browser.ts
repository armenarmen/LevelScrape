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
import { chooseStrategies, describeEnvironment, detectEnvironment, type Strategy } from "./environment.js";
import { startXvfb, stopXvfb } from "./xvfb.js";

let cfg: Config;
let context: BrowserContext | null = null;
let keepAlive: Page | null = null;          // see getContext() for why this exists
let launching: Promise<BrowserContext> | null = null;
let launchedAt: string | null = null;
let consecutiveLaunchFailures = 0;
let closingOnPurpose = false;
let active: Strategy | null = null;
let envDescription: string | null = null;

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

/**
 * Anti-detection script, used ONLY for the Playwright-Chromium fallbacks. Real Chrome
 * needs none of this and spoofing it would only create contradictions.
 */
const CHROMIUM_STEALTH = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  const w = window as unknown as { chrome?: Record<string, unknown> };
  if (!w.chrome) w.chrome = { runtime: {} };
  else if (!w.chrome.runtime) w.chrome.runtime = {};
  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const p = [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      ];
      (p as unknown as { length: number }).length = 3;
      return p;
    },
  });
  const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
    parameters.name === "notifications" ? Promise.resolve({ state: Notification.permission } as PermissionStatus) : originalQuery(parameters);
};

function safeBundledChromium(): string | null {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

async function launchWith(s: Strategy, userAgent?: string): Promise<BrowserContext> {
  cleanStaleLocks(cfg.profileDir);
  const { width, height } = cfg.windowSize;
  const opts: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> = {
    headless: s.headless,
    // null = let the actual window size be the viewport. Playwright's default
    // (a fixed 1280x720 emulated viewport) makes screen/inner/outer sizes all
    // identical, which is a well known automation tell.
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled", `--window-size=${width},${height}`, "--window-position=0,0"],
    // Playwright adds --enable-automation by default, which sets
    // navigator.webdriver = true and shows the "controlled by automated software"
    // bar. Remove just that one flag. Never pass ignoreDefaultArgs: true.
    ignoreDefaultArgs: ["--enable-automation"],
    // We own shutdown ourselves in index.ts so the profile is flushed cleanly.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  // Headless has no real monitor and reports an 800x600 screen, smaller than our window.
  // Give it a believable one.
  if (s.headless) opts.args!.push(`--screen-info={${Math.max(1920, width)}x${Math.max(1080, height)}}`);
  if (s.executablePath) opts.executablePath = s.executablePath; // real Google Chrome
  else if (s.channel) opts.channel = s.channel;                 // Playwright's Chromium (new headless when headless)
  if (userAgent) opts.userAgent = userAgent;

  if (cfg.proxyUrl) {
    opts.proxy = parseProxyUrl(cfg.proxyUrl);
    // Only override locale/timezone when going through a proxy, so they match
    // the proxy's country. Without a proxy, Chrome's real values are the most
    // believable ones.
    if (cfg.proxyLocale) opts.locale = cfg.proxyLocale;
    if (cfg.proxyTz) opts.timezoneId = cfg.proxyTz;
  }

  const ctx = await chromium.launchPersistentContext(cfg.profileDir, opts);
  if (s.stealth) await ctx.addInitScript(CHROMIUM_STEALTH);

  // A persistent context starts with one about:blank tab. If the LAST tab is
  // closed, Chrome exits. So we pin this tab and never close it; every job gets
  // its own fresh tab via withPage().
  const first = ctx.pages()[0] ?? (await ctx.newPage());

  // Old-style headless announces itself in the user agent. If that happened, relaunch
  // with the word removed; nothing else about the UA changes.
  if (s.headless && !userAgent) {
    const ua = await first.evaluate(() => navigator.userAgent).catch(() => "");
    if (/HeadlessChrome/.test(ua)) {
      await ctx.close();
      log.warn(`${s.name}: user agent was "${ua.slice(0, 60)}..."; relaunching with "Headless" removed`);
      return launchWith(s, ua.replace("HeadlessChrome", "Chrome"));
    }
  }
  keepAlive = first;
  return ctx;
}

async function launch(): Promise<BrowserContext> {
  mkdirSync(cfg.profileDir, { recursive: true });
  const env = detectEnvironment({ chromiumPath: safeBundledChromium() });
  envDescription = describeEnvironment(env);
  log.info(`environment: ${envDescription}`);
  for (const n of env.notes) log.warn(`environment: ${n}`);

  const ladder = chooseStrategies(env, cfg.browserMode);
  if (ladder.length === 0) {
    throw new Error(
      cfg.browserMode === "auto"
        ? `no usable browser on this machine (${envDescription}). Install Google Chrome; on a Linux server without a monitor also install Xvfb.`
        : `BROWSER_MODE=${cfg.browserMode} is not possible here (${envDescription}). Use BROWSER_MODE=auto or run "npm run doctor".`,
    );
  }

  let lastErr: unknown = null;
  for (const s of ladder) {
    try {
      if (s.needsXvfb && env.xvfbPath) await startXvfb(env.xvfbPath, cfg.windowSize.width, cfg.windowSize.height);
      log.info(`launching ${s.name}: ${s.note}${cfg.proxyUrl ? " (proxy on)" : ""}`);
      const ctx = await launchWith(s);
      active = s;
      if (s.quality === "poor" || s.quality === "worst") {
        log.warn("=================================================================");
        log.warn(` Running on ${s.name}. ${s.note}`);
        log.warn("=================================================================");
      }
      ctx.on("close", () => {
        if (closingOnPurpose) log.info("browser closed");
        else log.warn("browser context closed unexpectedly; will relaunch on next job");
        context = null;
        keepAlive = null;
        launchedAt = null;
        active = null;
      });
      return ctx;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log.warn(`${s.name} failed to launch: ${msg}`);
      if (s.needsXvfb) stopXvfb();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
  const base = {
    strategy: active?.name ?? null,
    quality: active?.quality ?? null,
    note: active?.note ?? null,
    environment: envDescription,
  };
  if (context) {
    return { status: "up", launchedAt, openPages: Math.max(0, context.pages().length - (keepAlive ? 1 : 0)), ...base };
  }
  return { status: launching ? "starting" : "down", launchedAt: null, openPages: 0, ...base };
}

/** True when a human could actually see and interact with the browser window. */
export function hasVisibleWindow(): boolean {
  return active?.name === "headful-chrome" || active?.name === "headful-chromium";
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
  stopXvfb();
}
