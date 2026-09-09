// "Auto mode": try a plain HTTP request first (fast, cheap, no browser) and tell the
// caller whether the page looks like it actually needs a browser.
import type { Config } from "./config.js";

const MAX_BYTES = 3 * 1024 * 1024;

export interface PlainResult {
  ok: boolean;              // we got an HTML document worth using
  needsBrowser: boolean;    // heuristics say render it for real
  reason: string;
  status: number | null;
  finalUrl: string;
  html: string;
  contentType: string | null;
  elapsedMs: number;
}

const JS_WALL = /enable javascript|javascript is (required|disabled)|just a moment|checking your browser|cf-challenge|__cf_chl|attention required|access denied|are you a human|verify you are human|captcha|please turn javascript on|browser is not supported/i;
const EMPTY_ROOT = /<div[^>]+id=["'](root|app|__next|___gatsby|__nuxt|main-app)["'][^>]*>\s*<\/div>/i;

export function judgeHtml(status: number, contentType: string | null, html: string): { needsBrowser: boolean; reason: string } {
  if (status === 401 || status === 403 || status === 429 || status === 503) return { needsBrowser: true, reason: `http ${status}` };
  if (contentType && !/html|xml/i.test(contentType)) return { needsBrowser: false, reason: `non-html ${contentType}` };
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (JS_WALL.test(text.slice(0, 4000))) return { needsBrowser: true, reason: "js/bot wall text" };
  if (EMPTY_ROOT.test(html) && text.length < 1500) return { needsBrowser: true, reason: "empty SPA root" };
  // A tiny page that also ships scripts is probably a JS app shell. A tiny page with no
  // scripts (example.com, a redirect stub, a plain notice) is just a tiny page.
  if (text.length < 400 && /<script[\s>]/i.test(html)) return { needsBrowser: true, reason: `thin body (${text.length} chars) with scripts` };
  return { needsBrowser: false, reason: "looks complete" };
}

export async function plainFetch(url: string, cfg: Config): Promise<PlainResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(cfg.fetchTimeoutMs, 20_000)),
      headers: {
        "user-agent": cfg.plainUserAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "upgrade-insecure-requests": "1",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
      },
    });
    const contentType = res.headers.get("content-type");
    let html = await res.text();
    if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    const { needsBrowser, reason } = judgeHtml(res.status, contentType, html);
    return { ok: res.ok && !needsBrowser, needsBrowser, reason, status: res.status, finalUrl: res.url || url, html, contentType, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, needsBrowser: true, reason: `plain fetch failed: ${e instanceof Error ? e.message : String(e)}`, status: null, finalUrl: url, html: "", contentType: null, elapsedMs: Date.now() - t0 };
  }
}
