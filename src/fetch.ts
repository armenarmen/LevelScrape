import { lookup } from "dns/promises";
import { isIP } from "net";
import type { Page } from "playwright";
import { parseHTML } from "linkedom";
import { aiExtract, aiQuery } from "./ai.js";
import { withPage } from "./browser.js";
import type { Config } from "./config.js";
import { htmlToMarkdown } from "./extract/markdown.js";
import { extractPageMeta } from "./extract/meta.js";
import { applyExtractRules, type ExtractRules } from "./extract/rules.js";
import { domToText } from "./extract/text.js";
import { plainFetch } from "./plainfetch.js";
import { runScenario, type JsScenario } from "./scenario.js";
import type { FetchParams, FetchResult, PageMeta } from "./types.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;

export class BadUrlError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadUrlError";
  }
}
export class BadParamsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadParamsError";
  }
}

function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) return true;
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return false;
}

/**
 * Anyone holding the API key can make this machine open any URL. Make sure that
 * URL is a public website and not the router admin page or a cloud metadata endpoint.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadUrlError("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadUrlError("only http(s) urls are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) throw new BadUrlError("private host");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new BadUrlError("private address");
    return u;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new BadUrlError("dns lookup failed");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new BadUrlError("url resolves to a private address");
  return u;
}

/** Things only a real browser can do. */
export function requiresBrowser(p: FetchParams): string | null {
  if (p.jsScenario) return "js_scenario";
  if (p.screenshot) return "screenshot";
  if (p.wait) return "wait selector";
  if (p.waitMs) return "wait_ms";
  if (p.waitBrowser === "networkidle") return "wait_browser=networkidle";
  return null;
}

function cap(s: string): { body: string; truncated: boolean } {
  return s.length > MAX_BODY_BYTES ? { body: s.slice(0, MAX_BODY_BYTES), truncated: true } : { body: s, truncated: false };
}

/** Fill the requested outputs from static HTML (plain mode) using linkedom. */
function outputsFromHtml(result: FetchResult, html: string, p: FetchParams): void {
  const { document } = parseHTML(html);
  if (!document.querySelector("base[href]") && document.head) {
    const base = document.createElement("base");
    base.setAttribute("href", result.finalUrl);
    document.head.insertBefore(base, document.head.firstChild);
  }
  result.title = (document.title || "").replace(/\s+/g, " ").trim();

  if (p.format === "html") {
    const c = cap(html);
    result.html = c.body;
    result.truncated = c.truncated;
  } else if (p.format === "text") {
    const c = cap(document.body ? domToText(document.body) : "");
    result.text = c.body;
    result.truncated = c.truncated;
  } else if (p.format === "markdown") {
    const md = htmlToMarkdown(html, { baseUrl: result.finalUrl });
    result.markdown = md.markdown;
    result.truncated = md.truncated;
  } else if (p.format === "meta") {
    result.meta = extractPageMeta(document as unknown as Document);
  }
  if (p.extractRules) result.extracted = applyExtractRules(document as unknown as Document, p.extractRules as ExtractRules, result.finalUrl);
}

async function browserFetch(p: FetchParams, cfg: Config, result: FetchResult): Promise<string> {
  return withPage(
    async (page: Page) => {
      if (p.blockResources) {
        await page.route("**/*", (route) => {
          const t = route.request().resourceType();
          if (t === "image" || t === "media" || t === "font") return route.abort();
          return route.continue();
        });
      }
      const waitUntil = p.waitBrowser ?? "domcontentloaded";
      const resp = await page.goto(p.url, { waitUntil, timeout: 30_000 });
      result.status = resp ? resp.status() : null;

      if (p.wait) await page.waitForSelector(p.wait, { timeout: 20_000 });
      else if (waitUntil === "domcontentloaded") await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      if (p.waitMs) await page.waitForTimeout(Math.min(p.waitMs, 35_000));
      if (p.jsScenario) result.scenario = await runScenario(page, p.jsScenario as JsScenario);

      result.finalUrl = page.url();
      result.title = await page.title().catch(() => "");
      const html = await page.content();

      if (p.format === "html") {
        const c = cap(html);
        result.html = c.body;
        result.truncated = c.truncated;
      } else if (p.format === "text") {
        const text = (await page.evaluate(`(${domToText.toString()})(document.body)`)) as string;
        const c = cap(text);
        result.text = c.body;
        result.truncated = c.truncated;
      } else if (p.format === "markdown") {
        const md = htmlToMarkdown(html, { baseUrl: result.finalUrl });
        result.markdown = md.markdown;
        result.truncated = md.truncated;
      } else if (p.format === "meta") {
        result.meta = (await page.evaluate(`(${extractPageMeta.toString()})(document)`)) as PageMeta;
      }
      if (p.extractRules) {
        result.extracted = (await page.evaluate(
          `(${applyExtractRules.toString()})(document, ${JSON.stringify(p.extractRules)}, ${JSON.stringify(result.finalUrl)})`,
        )) as Record<string, unknown>;
      }
      if (p.screenshot) {
        if (p.screenshotSelector) {
          const loc = page.locator(p.screenshotSelector).first();
          await loc.waitFor({ state: "visible", timeout: 10_000 });
          result.screenshot = await loc.screenshot({ type: "png" });
        } else {
          result.screenshot = await page.screenshot({ type: "png", fullPage: !!p.screenshotFullPage });
        }
      }
      return html;
    },
    { timeoutMs: cfg.fetchTimeoutMs + (p.jsScenario ? cfg.scenarioTimeoutMs : 0), label: `fetch ${p.url}` },
  );
}

/**
 * Fetch a page. mode=auto tries a plain HTTP request first and only opens a Chrome
 * tab when the page looks like it needs JavaScript (or the request asks for
 * something only a browser can do).
 */
export async function fetchPage(p: FetchParams, cfg: Config): Promise<FetchResult> {
  const t0 = Date.now();
  const browserOnly = requiresBrowser(p);
  if (p.mode === "plain" && browserOnly) throw new BadParamsError(`${browserOnly} needs mode=browser or mode=auto`);

  const result: FetchResult = { url: p.url, finalUrl: p.url, status: null, title: "", mode: "plain", truncated: false, elapsedMs: 0 };
  let html = "";
  let usedBrowser = false;

  if (p.mode !== "browser" && !browserOnly) {
    const r = await plainFetch(p.url, cfg);
    result.status = r.status;
    result.finalUrl = r.finalUrl;
    if (r.ok || p.mode === "plain") {
      result.modeReason = r.reason;
      html = r.html;
      outputsFromHtml(result, html, p);
    } else {
      result.modeReason = `plain: ${r.reason}; rendered in browser`;
      usedBrowser = true;
    }
  } else {
    usedBrowser = true;
    result.modeReason = browserOnly ? `${browserOnly} requires browser` : "mode=browser";
  }

  if (usedBrowser) {
    result.mode = "browser";
    html = await browserFetch(p, cfg, result);
  }

  if (p.aiQuery || p.aiExtractRules) {
    const md = htmlToMarkdown(html, { baseUrl: result.finalUrl });
    const ai: Record<string, unknown> = {};
    if (p.aiQuery) ai.query = await aiQuery(cfg, md.markdown, p.aiQuery, result.finalUrl);
    if (p.aiExtractRules) ai.extract = await aiExtract(cfg, md.markdown, p.aiExtractRules, result.finalUrl);
    result.ai = ai;
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}
