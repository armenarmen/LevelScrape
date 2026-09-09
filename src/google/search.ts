import type { Page } from "playwright";
import type { SearchOutcome, SearchParams } from "../types.js";
import { humanDelay, humanMouseMove, humanScroll, randomInt } from "../humanize.js";
import { classifyPage } from "./block.js";
import { parseSerp } from "./parse.js";
import { resolveGotoLinks } from "./resolve.js";

/**
 * Build the same URL Chrome's own address bar produces when you type a search.
 * Going straight there is indistinguishable from a normal user and avoids the
 * per-keystroke autocomplete traffic of typing into the homepage box.
 * No `num=` parameter: Google dropped num=100 in Sept 2025 and other values
 * behave inconsistently, so we paginate with start= (10 per page).
 */
export function buildSearchUrl(p: SearchParams, domain = "www.google.com"): string {
  const u = new URL(`https://${domain}/search`);
  u.searchParams.set("q", p.q);
  if (p.udm) u.searchParams.set("udm", String(p.udm));
  u.searchParams.set("hl", p.hl);
  u.searchParams.set("gl", p.gl);
  if (p.page > 1) u.searchParams.set("start", String((p.page - 1) * 10));
  u.searchParams.set("sourceid", "chrome");
  u.searchParams.set("ie", "UTF-8");
  return u.href;
}

const CONSENT_BUTTON = /^(Accept all|Reject all|I agree|Alle akzeptieren|Alle ablehnen|Tout accepter|Tout refuser|Aceptar todo|Rechazar todo)$/i;

/**
 * EU IPs get a cookie-consent page first. Clicking either button stores a
 * 13-month SOCS cookie in our persistent profile, so this only happens once.
 */
export async function dismissConsent(page: Page): Promise<boolean> {
  const onConsentHost = /consent\.google\./.test(page.url());
  const btn = page.getByRole("button", { name: CONSENT_BUTTON }).first();
  try {
    await btn.waitFor({ state: "visible", timeout: onConsentHost ? 8000 : 1000 });
  } catch {
    return false;
  }
  await humanDelay(500, 1500);
  await btn.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  if (onConsentHost) {
    await page.waitForURL(/google\.[a-z.]+\/(search|webhp|$|\?)/, { timeout: 15_000 }).catch(() => {});
  }
  return true;
}

/** The "Sign in to Google" popup (an iframe). Harmless for parsing; dismiss if present. */
export async function dismissSignInPrompt(page: Page): Promise<void> {
  try {
    const stay = page.frameLocator('iframe[src*="accounts.google.com"]').getByText(/Stay signed out/i).first();
    await stay.waitFor({ state: "visible", timeout: 800 });
    await humanDelay(300, 900);
    await stay.click();
  } catch {
    /* not shown */
  }
}

export interface SearchHooks {
  /** Called when a captcha is detected. Return true if a human solved it and the page moved on. */
  onCaptcha?: (page: Page) => Promise<boolean>;
  /** Follow google.com/goto redirects to recover real URLs (default true). */
  resolveGoto?: boolean;
  /** Also return the raw page HTML (ScrapingBee's full_html). */
  includeHtml?: boolean;
}

export async function runSearch(page: Page, p: SearchParams, hooks: SearchHooks = {}): Promise<SearchOutcome> {
  const resp = await page.goto(buildSearchUrl(p), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const status = resp ? resp.status() : null;
  await humanDelay(400, 1200);

  let block = await classifyPage(page, status);

  if (block === "consent" || (block === "none" && (await dismissConsent(page)))) {
    if (block === "consent") await dismissConsent(page);
    block = await classifyPage(page, null);
  }

  if (block === "captcha" && hooks.onCaptcha) {
    const solved = await hooks.onCaptcha(page);
    if (solved) block = await classifyPage(page, null);
  }

  if (block !== "none") return { kind: "blocked", block, url: page.url() };

  await dismissSignInPrompt(page);
  await page.waitForSelector('#search, #rso, div[role="main"]', { timeout: 10_000 }).catch(() => {});

  // Look around a little like a person would, some of the time.
  if (Math.random() < 0.4) await humanScroll(page, randomInt(1, 3));

  const { results, extras, noResults } = await parseSerp(page, p.q);
  if (results.length === 0 && !noResults) {
    return { kind: "parse_failed", html: await page.content() };
  }
  const html = hooks.includeHtml ? await page.content() : "";
  if (hooks.resolveGoto !== false && results.some((r) => r.gotoUrl)) {
    await humanDelay(300, 900); // a person reads before clicking
    await resolveGotoLinks(page.context(), results);
  }
  return { kind: "ok", results, extras, noResults, html };
}

/**
 * First-launch only: visit the homepage so the profile picks up Google's
 * baseline cookies (NID, SOCS) before its first real search.
 */
export async function warmup(page: Page): Promise<void> {
  await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await humanDelay(800, 2000);
  await dismissConsent(page);
  await dismissSignInPrompt(page);
  await humanMouseMove(page);
  await humanDelay(2000, 5000);
}
