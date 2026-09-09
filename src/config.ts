import "dotenv/config";

export interface Config {
  apiKey: string;
  port: number;
  host: string;

  proxyUrl: string | null;
  proxyLocale: string | null;
  proxyTz: string | null;

  googleUdm: number;
  googleHl: string;
  googleGl: string;
  googleMinIntervalMs: number;
  googleJitterPct: number;
  googleDailyMax: number;
  googleResolveGoto: boolean;

  cacheTtlMs: number;
  cacheMax: number;

  queueMaxPending: number;
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  scenarioTimeoutMs: number;   // extra budget when a js_scenario is present
  fetchConcurrency: number;

  captchaManualSolve: boolean;
  captchaWaitMs: number;

  windowSize: { width: number; height: number };
  profileDir: string;
  /** auto = detect the machine and pick the best available setup; or force one strategy. */
  browserMode: "auto" | "headful-chrome" | "xvfb-chrome" | "headless-chrome" | "headful-chromium" | "xvfb-chromium" | "headless-chromium";

  logRetentionDays: number;

  /** User agent for plain (non-browser) fetches. Should match the installed Chrome. */
  plainUserAgent: string;
  fetchDefaultMode: "auto" | "browser" | "plain";

  aiBaseUrl: string;
  aiApiKey: string | null;
  aiModel: string;
  aiMaxInputChars: number;
  aiTimeoutMs: number;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config: ${key} must be a number, got "${raw}"`);
  return n;
}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined || raw === "" ? def : raw;
}

function opt(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === "" ? null : raw;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = opt(env, "API_KEY");
  if (!apiKey || apiKey === "change-me") {
    throw new Error("Config: API_KEY is required. Copy .env.example to .env and set it (openssl rand -hex 32).");
  }

  const [w, h] = str(env, "WINDOW_SIZE", "1366,768").split(",").map((s) => Number(s.trim()));
  if (!w || !h) throw new Error('Config: WINDOW_SIZE must look like "1366,768"');

  return {
    apiKey,
    port: num(env, "PORT", 3456),
    host: str(env, "HOST", "127.0.0.1"),

    proxyUrl: opt(env, "PROXY_URL"),
    proxyLocale: opt(env, "PROXY_LOCALE"),
    proxyTz: opt(env, "PROXY_TZ"),

    googleUdm: num(env, "GOOGLE_UDM", 0),
    googleHl: str(env, "GOOGLE_HL", "en"),
    googleGl: str(env, "GOOGLE_GL", "us"),
    googleMinIntervalMs: num(env, "GOOGLE_MIN_INTERVAL_MS", 30_000),
    googleJitterPct: num(env, "GOOGLE_JITTER_PCT", 40),
    googleDailyMax: num(env, "GOOGLE_DAILY_MAX", 400),
    googleResolveGoto: bool(env, "GOOGLE_RESOLVE_GOTO", true),

    cacheTtlMs: num(env, "CACHE_TTL_MS", 86_400_000),
    cacheMax: num(env, "CACHE_MAX", 2000),

    queueMaxPending: num(env, "QUEUE_MAX_PENDING", 20),
    searchTimeoutMs: num(env, "SEARCH_TIMEOUT_MS", 60_000),
    fetchTimeoutMs: num(env, "FETCH_TIMEOUT_MS", 45_000),
    scenarioTimeoutMs: num(env, "SCENARIO_TIMEOUT_MS", 120_000),
    fetchConcurrency: num(env, "FETCH_CONCURRENCY", 2),

    captchaManualSolve: bool(env, "CAPTCHA_MANUAL_SOLVE", true),
    captchaWaitMs: num(env, "CAPTCHA_WAIT_MS", 600_000),

    windowSize: { width: w, height: h },
    profileDir: str(env, "PROFILE_DIR", "./data/profile"),
    browserMode: (() => {
      const m = str(env, "BROWSER_MODE", "auto");
      const ok = ["auto", "headful-chrome", "xvfb-chrome", "headless-chrome", "headful-chromium", "xvfb-chromium", "headless-chromium"];
      if (!ok.includes(m)) throw new Error(`Config: BROWSER_MODE must be one of ${ok.join(", ")}`);
      return m as Config["browserMode"];
    })(),

    logRetentionDays: num(env, "LOG_RETENTION_DAYS", 14),

    plainUserAgent: str(env, "PLAIN_USER_AGENT", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"),
    fetchDefaultMode: (["auto", "browser", "plain"].includes(str(env, "FETCH_DEFAULT_MODE", "auto")) ? str(env, "FETCH_DEFAULT_MODE", "auto") : "auto") as "auto" | "browser" | "plain",

    aiBaseUrl: str(env, "AI_BASE_URL", "https://api.openai.com/v1"),
    aiApiKey: opt(env, "AI_API_KEY"),
    aiModel: str(env, "AI_MODEL", ""),
    aiMaxInputChars: num(env, "AI_MAX_INPUT_CHARS", 60_000),
    aiTimeoutMs: num(env, "AI_TIMEOUT_MS", 60_000),
  };
}
