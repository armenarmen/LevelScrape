import type { Page } from "playwright";
import type { BlockKind } from "../types.js";
import { sleep } from "../humanize.js";

/** Look at the page Google actually served and decide whether it is a real results page. */
export async function classifyPage(page: Page, status: number | null): Promise<BlockKind> {
  const url = page.url();
  if (status === 429 || /\/sorry\//.test(url)) return "captcha";
  if (/consent\.google\./.test(url)) return "consent";

  const found = await page
    .evaluate(() => {
      const has = (s: string) => !!document.querySelector(s);
      if (has("#captcha-form") || has('form[action*="/sorry/"]') || has('iframe[src*="recaptcha"]') || has("#recaptcha")) {
        return "captcha";
      }
      const t = document.body ? document.body.innerText : "";
      if (/unusual traffic|Our systems have detected/i.test(t)) return "captcha";
      // Google's "JavaScript required" shell. We HAVE JavaScript on, so getting
      // this page means Google decided we are probably a bot. Treat as a soft block.
      if (!has("#search") && !has("#rso") && /enable JavaScript|click here if you are not redirected/i.test(t)) {
        return "js_required";
      }
      return "none";
    })
    .catch(() => "none");

  return found as BlockKind;
}

/**
 * What to do after a block: back off, doubling each time (5m, 10m, 20m ... max 2h).
 * Three clean successes in a row reset the strike count.
 */
export class BlockPolicy {
  strikes = 0;
  cooldownUntil = 0;
  awaitingHuman = false;
  captchaSince: string | null = null;
  private successes = 0;

  constructor(
    private readonly baseMs = 5 * 60_000,
    private readonly capMs = 2 * 3_600_000,
  ) {}

  /** Returns the cooldown length in ms. */
  onBlock(): number {
    const ms = Math.min(this.baseMs * 2 ** this.strikes, this.capMs);
    this.strikes++;
    this.successes = 0;
    this.cooldownUntil = Date.now() + ms;
    return ms;
  }

  onSuccess(): void {
    this.successes++;
    if (this.successes >= 3) this.strikes = 0;
    this.cooldownUntil = 0;
  }

  isBlocked(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  retryAfterSec(): number {
    return Math.max(1, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }
}

/**
 * Headful perk: a person can solve the captcha in the Chrome window. Poll until
 * the page leaves /sorry/ (Google then redirects back to the results) or give up.
 */
export async function waitForHumanSolve(page: Page, maxMs: number): Promise<boolean> {
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (page.isClosed()) return false;
    if (!/\/sorry\//.test(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}
