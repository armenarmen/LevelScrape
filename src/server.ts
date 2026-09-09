import { timingSafeEqual } from "crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { AiError, AiNotConfiguredError, aiConfigured } from "./ai.js";
import { JobTimeoutError, browserState } from "./browser.js";
import type { Config } from "./config.js";
import { validateExtractRules } from "./extract/rules.js";
import { BadParamsError, BadUrlError, assertPublicHttpUrl, fetchPage } from "./fetch.js";
import { BlockedError, ParseFailedError, type SearchService } from "./google/service.js";
import { getStats, logRequest } from "./logger.js";
import { ConcurrentQueue, DailyLimitError, QueueFullError } from "./queue.js";
import { ScenarioError, validateScenario } from "./scenario.js";
import type { FetchFormat, FetchMode, FetchParams } from "./types.js";

export interface Deps {
  cfg: Config;
  searchService: SearchService;
  fetchQueue: ConcurrentQueue;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireApiKey(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("x-api-key");
    const query = typeof req.query.api_key === "string" ? req.query.api_key : undefined;
    const supplied = header ?? query;
    if (!supplied || !safeEqual(supplied, apiKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

const truthy = (v: unknown) => v === "1" || v === "true";

function jsonParam(req: Request, name: string): Record<string, unknown> | undefined {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadParamsError(`${name} must be a JSON string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadParamsError(`${name} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadParamsError(`${name} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Shared by GET /fetch (query string) and POST /fetch (JSON body). */
export function parseFetchParams(src: Record<string, unknown>, cfg: Config): FetchParams {
  const url = String(src.url ?? "");
  if (!url) throw new BadParamsError("url is required");

  const extractRules = src.extract_rules === undefined ? undefined : typeof src.extract_rules === "string" ? (JSON.parse(src.extract_rules) as Record<string, unknown>) : (src.extract_rules as Record<string, unknown>);
  if (extractRules) {
    const err = validateExtractRules(extractRules);
    if (err) throw new BadParamsError(`extract_rules: ${err}`);
  }
  const aiExtractRules = src.ai_extract_rules === undefined ? undefined : typeof src.ai_extract_rules === "string" ? (JSON.parse(src.ai_extract_rules) as Record<string, unknown>) : (src.ai_extract_rules as Record<string, unknown>);
  if (aiExtractRules && (typeof aiExtractRules !== "object" || Array.isArray(aiExtractRules) || Object.keys(aiExtractRules).length === 0)) {
    throw new BadParamsError("ai_extract_rules must be a non-empty JSON object of field: description");
  }
  const jsScenario = src.js_scenario === undefined ? undefined : typeof src.js_scenario === "string" ? (JSON.parse(src.js_scenario) as Record<string, unknown>) : (src.js_scenario as Record<string, unknown>);
  if (jsScenario) {
    const err = validateScenario(jsScenario);
    if (err) throw new BadParamsError(`js_scenario: ${err}`);
  }
  const aiQuery = src.ai_query === undefined ? undefined : String(src.ai_query);
  if (aiQuery !== undefined && (!aiQuery.trim() || aiQuery.length > 2000)) throw new BadParamsError("ai_query must be 1-2000 chars");
  if ((aiQuery || aiExtractRules) && !aiConfigured(cfg)) throw new AiNotConfiguredError();

  const formatRaw = src.format === undefined ? (extractRules || aiQuery || aiExtractRules ? "none" : "html") : String(src.format);
  if (!["html", "text", "markdown", "meta", "none"].includes(formatRaw)) throw new BadParamsError("format must be html, text, markdown, meta or none");

  const modeRaw = src.mode === undefined ? cfg.fetchDefaultMode : String(src.mode);
  if (!["auto", "browser", "plain"].includes(modeRaw)) throw new BadParamsError("mode must be auto, browser or plain");

  const wait = src.wait ? String(src.wait) : undefined;
  if (wait && wait.length > 200) throw new BadParamsError("wait selector too long");
  const waitMs = src.wait_ms === undefined ? undefined : Number(src.wait_ms);
  if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 35_000)) throw new BadParamsError("wait_ms must be 0-35000");
  const waitBrowser = src.wait_browser === undefined ? undefined : String(src.wait_browser);
  if (waitBrowser && !["load", "domcontentloaded", "networkidle"].includes(waitBrowser)) throw new BadParamsError("wait_browser must be load, domcontentloaded or networkidle");
  const screenshotSelector = src.screenshot_selector ? String(src.screenshot_selector) : undefined;

  return {
    url,
    format: formatRaw as FetchFormat,
    mode: modeRaw as FetchMode,
    wait,
    waitMs: waitMs || undefined,
    waitBrowser: waitBrowser as FetchParams["waitBrowser"],
    blockResources: truthy(src.block_resources),
    screenshot: truthy(src.screenshot) || !!screenshotSelector || truthy(src.screenshot_full_page),
    screenshotFullPage: truthy(src.screenshot_full_page),
    screenshotSelector,
    extractRules,
    aiQuery,
    aiExtractRules,
    jsScenario: jsScenario as FetchParams["jsScenario"],
  };
}

export function createApp({ cfg, searchService, fetchQueue }: Deps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(requireApiKey(cfg.apiKey));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      browser: browserState(),
      google: searchService.state(),
      fetchQueueDepth: fetchQueue.depth,
      ai: aiConfigured(cfg) ? { configured: true, model: cfg.aiModel } : { configured: false },
    });
  });

  app.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    if (q.length > 400) {
      res.status(400).json({ error: "q too long (max 400 chars)" });
      return;
    }
    const page = Number(req.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 5) {
      res.status(400).json({ error: "page must be an integer 1..5" });
      return;
    }
    const gl = String(req.query.gl ?? cfg.googleGl).toLowerCase();
    if (!/^[a-z]{2}$/.test(gl)) {
      res.status(400).json({ error: "gl must be a 2-letter country code" });
      return;
    }
    const hl = String(req.query.hl ?? cfg.googleHl);
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(hl)) {
      res.status(400).json({ error: "hl must look like en or pt-BR" });
      return;
    }
    const udm = req.query.udm === undefined ? cfg.googleUdm : Number(req.query.udm);
    if (!Number.isInteger(udm) || udm < 0 || udm > 100) {
      res.status(400).json({ error: "udm must be an integer (0 = normal results, 14 = web tab)" });
      return;
    }
    const fresh = truthy(req.query.fresh);
    const fullHtml = truthy(req.query.full_html);

    const result = await searchService.search({ q, page, gl, hl, udm, fresh }, { fullHtml });
    res.json(result);
  });

  const handleFetch = async (src: Record<string, unknown>, req: Request, res: Response) => {
    const p = parseFetchParams(src, cfg);
    const u = await assertPublicHttpUrl(p.url);
    p.url = u.href;
    const t0 = Date.now();
    try {
      const result = await fetchQueue.enqueue(() => fetchPage(p, cfg));
      logRequest({ ts: new Date().toISOString(), kind: "fetch", target: u.href, outcome: "ok", ms: Date.now() - t0, detail: result.mode });
      if (truthy(src.transparent_status_code) && result.status) res.status(result.status);
      if (p.screenshot && result.screenshot && p.format === "html" && !p.extractRules && !p.aiQuery && !p.aiExtractRules) {
        res.type("png").send(result.screenshot);
        return;
      }
      const { screenshot, ...json } = result;
      if (screenshot) (json as Record<string, unknown>).screenshotBase64 = screenshot.toString("base64");
      res.json(json);
    } catch (err) {
      logRequest({
        ts: new Date().toISOString(),
        kind: "fetch",
        target: u.href,
        outcome: err instanceof JobTimeoutError ? "timeout" : "error",
        ms: Date.now() - t0,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  app.get("/fetch", async (req, res) => {
    // Allow JSON-object params in the query string as strings; jsonParam validates them.
    const src: Record<string, unknown> = { ...req.query };
    if (src.extract_rules !== undefined) src.extract_rules = jsonParam(req, "extract_rules");
    if (src.ai_extract_rules !== undefined) src.ai_extract_rules = jsonParam(req, "ai_extract_rules");
    if (src.js_scenario !== undefined) src.js_scenario = jsonParam(req, "js_scenario");
    await handleFetch(src, req, res);
  });

  app.post("/fetch", async (req, res) => {
    await handleFetch((req.body ?? {}) as Record<string, unknown>, req, res);
  });

  app.get("/stats", (_req, res) => {
    res.json(getStats());
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BlockedError) {
      res.set("Retry-After", String(err.retryAfterSec));
      res.status(429).json({ error: "blocked", retryAfter: err.retryAfterSec, hint: "Google served a captcha/block page; cooling down" });
      return;
    }
    if (err instanceof DailyLimitError) {
      const retryAfter = secondsUntilUtcMidnight();
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ error: "daily_limit", retryAfter });
      return;
    }
    if (err instanceof QueueFullError) {
      res.status(503).json({ error: "queue_full", queueDepth: searchService.state().queueDepth });
      return;
    }
    if (err instanceof ParseFailedError) {
      res.status(502).json({ error: "parse_failed", debugFile: err.debugFile, hint: "Google's markup may have changed; see README 'Fixing the parser'" });
      return;
    }
    if (err instanceof JobTimeoutError) {
      res.status(504).json({ error: "timeout", message: err.message });
      return;
    }
    if (err instanceof BadUrlError) {
      res.status(400).json({ error: "bad_url", message: err.message });
      return;
    }
    if (err instanceof BadParamsError) {
      res.status(400).json({ error: "bad_params", message: err.message });
      return;
    }
    if (err instanceof ScenarioError) {
      res.status(422).json({ error: "scenario_failed", step: err.step });
      return;
    }
    if (err instanceof AiNotConfiguredError) {
      res.status(400).json({ error: "ai_not_configured", message: "Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env to enable ai_query / ai_extract_rules" });
      return;
    }
    if (err instanceof AiError) {
      res.status(502).json({ error: "ai_error", message: err.message, providerStatus: err.status });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "bad_json", message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/browser has been closed|Target page, context or browser|Failed to launch|executable doesn't exist/i.test(message)) {
      res.status(503).json({ error: "browser_down", message });
      return;
    }
    if (/Timeout \d+ms exceeded|waiting for (selector|locator)/i.test(message)) {
      res.status(504).json({ error: "timeout", message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal", message });
  });

  return app;
}
