// Shared types. Kept dependency-free so both the Node side and the
// in-browser parser (which is stringified into page.evaluate) can use them.

export interface SearchParams {
  q: string;
  page: number;      // 1-based
  gl: string;        // country, e.g. "us"
  hl: string;        // language, e.g. "en"
  udm: number;       // 14 = "Web" tab, 0 = default results
  fresh: boolean;    // bypass cache
}

export interface Sitelink {
  title: string;
  url: string;
  gotoUrl?: string;
}

export interface OrganicResult {
  position: number;
  title: string;
  /** The real destination. If Google wrapped the link and we could not resolve it, this equals gotoUrl. */
  url: string;
  /** Present when Google served the link as an encrypted google.com/goto redirect (rolled out Aug 2026). */
  gotoUrl?: string;
  displayedUrl: string;
  snippet: string;
  sitelinks?: Sitelink[];
}

export interface SerpExtras {
  resultCount: number | null;
  peopleAlsoAsk: string[];
  relatedSearches: string[];
  ads: Array<{ title: string; url: string; displayedUrl: string }>;
  localResults: Array<{ name: string; rating: number | null; reviews: string | null; details: string }>;
  knowledgeGraph: { title: string; subtitle: string | null; description: string | null; facts: Record<string, string> } | null;
}

export interface SearchResponse extends SerpExtras {
  query: string;
  page: number;
  results: OrganicResult[];
  cached: boolean;
  fetchedAt: string;   // ISO
  elapsedMs: number;
  html?: string;       // only with full_html=1
}

export type FetchFormat = "html" | "text" | "markdown" | "meta" | "none";
export type FetchMode = "auto" | "browser" | "plain";

/** Structured page metadata, what you'd want from a link preview or an SEO audit. */
export interface PageMeta {
  title: string;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  h1: string[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  meta: Record<string, string>;       // every <meta name|property=...> not already in openGraph/twitter
  jsonLd: unknown[];
  images: Array<{ src: string; alt: string; width: number; height: number }>;
  mainImage: string | null;           // og:image, else largest visible image
  text: string;                       // first ~2000 chars of the main article/body text
  wordCount: number;
}

export interface FetchParams {
  url: string;
  format: FetchFormat;
  mode: FetchMode;
  wait?: string;             // CSS selector to wait for (forces browser)
  waitMs?: number;           // fixed delay after load (forces browser)
  waitBrowser?: "load" | "domcontentloaded" | "networkidle";
  blockResources?: boolean;  // skip images/fonts/media in browser mode
  screenshot: boolean;       // forces browser
  screenshotFullPage?: boolean;
  screenshotSelector?: string;
  extractRules?: Record<string, unknown>;
  aiQuery?: string;
  aiExtractRules?: Record<string, unknown>;
  jsScenario?: { instructions: Array<Record<string, unknown>>; strict?: boolean }; // forces browser
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  mode: "plain" | "browser";
  modeReason?: string;       // why auto mode picked what it picked
  html?: string;
  text?: string;
  markdown?: string;
  meta?: PageMeta;
  extracted?: Record<string, unknown>;
  ai?: unknown;
  scenario?: unknown;        // per-step results of js_scenario
  truncated: boolean;
  screenshot?: Buffer;
  elapsedMs: number;
}

/** What kind of "you are not welcome" page Google served, if any. */
export type BlockKind = "none" | "captcha" | "js_required" | "consent";

export type SearchOutcome =
  | { kind: "ok"; results: OrganicResult[]; extras: SerpExtras; noResults: boolean; html: string }
  | { kind: "blocked"; block: BlockKind; url: string }
  | { kind: "parse_failed"; html: string };

export interface RequestLogEntry {
  ts: string;
  kind: "search" | "fetch";
  target: string;                 // query or url
  outcome: "ok" | "cached" | "blocked" | "parse_failed" | "error" | "timeout";
  ms: number;
  n?: number;                     // result count
  detail?: string;
}

export interface BrowserState {
  status: "down" | "starting" | "up";
  launchedAt: string | null;
  openPages: number;
  strategy: string | null;     // which rung of the ladder is running (see src/environment.ts)
  quality: string | null;      // best | good | poor | worst
  note: string | null;
  environment: string | null;  // one-line machine description
}
