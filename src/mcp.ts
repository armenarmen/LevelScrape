// MCP server (stdio) so Claude Code and other agents can call the scraper as tools.
// It talks to the running HTTP API; start the API first (npm start), then register:
//   claude mcp add levels-scraper -e API_KEY=<key> -e BASE_URL=http://127.0.0.1:3456 -- node /ABS/PATH/levels-scraper/dist/mcp.js
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3456}`).replace(/\/$/, "");
const KEY = process.env.API_KEY ?? "";

async function api(path: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(300_000) });
  return { status: res.status, body: await res.json().catch(() => ({ error: `non-json response ${res.status}` })) };
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "levels-scraper", version: "0.1.0" });

server.registerTool(
  "google_search",
  {
    description:
      "Search Google through the self-hosted scraper. Returns organic results (title, url, snippet, sitelinks), People Also Ask questions, related searches, local results, and result count. Paced (~30s between uncached hits) and cached 24h.",
    inputSchema: z.object({
      query: z.string().min(1).max(400),
      page: z.number().int().min(1).max(5).optional(),
      gl: z.string().length(2).optional().describe("country code, e.g. us"),
      hl: z.string().optional().describe("language, e.g. en"),
      fresh: z.boolean().optional().describe("bypass the cache"),
    }),
  },
  async ({ query, page, gl, hl, fresh }) => {
    const r = await api("/search", { q: query, page, gl, hl, fresh: fresh ? 1 : undefined });
    return text(r.body);
  },
);

server.registerTool(
  "fetch_page",
  {
    description:
      "Fetch a public web page in a real browser (or a fast plain request when the page doesn't need JavaScript). format: markdown (default, best for reading), text, html, or meta (title/description/images/OpenGraph/JSON-LD).",
    inputSchema: z.object({
      url: z.string().url(),
      format: z.enum(["markdown", "text", "html", "meta"]).optional(),
      mode: z.enum(["auto", "browser", "plain"]).optional(),
      wait_for: z.string().optional().describe("CSS selector to wait for (forces browser)"),
    }),
  },
  async ({ url, format, mode, wait_for }) => {
    const r = await api("/fetch", { url, format: format ?? "markdown", mode, wait: wait_for });
    return text(r.body);
  },
);

server.registerTool(
  "extract_from_page",
  {
    description:
      'Extract structured data from a page with CSS-selector rules, e.g. {"title":"h1","products":{"selector":".card","type":"list","output":{"name":".name","price":".price","url":{"selector":"a","output":"@href"}}}}. Output can be text, html, @attribute, or nested rules.',
    inputSchema: z.object({
      url: z.string().url(),
      rules: z.record(z.string(), z.unknown()),
      mode: z.enum(["auto", "browser", "plain"]).optional(),
      wait_for: z.string().optional(),
    }),
  },
  async ({ url, rules, mode, wait_for }) => {
    const r = await api("/fetch", { url, extract_rules: rules, mode, wait: wait_for });
    return text(r.body);
  },
);

server.registerTool(
  "ai_extract_from_page",
  {
    description:
      'Ask an LLM to extract fields from a page. fields is {name: "description"}, e.g. {"price":"numeric price","brand":"brand name"}. Or pass question for a free-text answer. Requires AI_* to be configured on the scraper.',
    inputSchema: z.object({
      url: z.string().url(),
      fields: z.record(z.string(), z.unknown()).optional(),
      question: z.string().optional(),
    }),
  },
  async ({ url, fields, question }) => {
    const r = await api("/fetch", { url, ai_extract_rules: fields, ai_query: question });
    return text(r.body);
  },
);

server.registerTool(
  "scraper_status",
  { description: "Health and 24h stats of the scraper: browser state, queue depth, Google cooldown, success rate.", inputSchema: z.object({}) },
  async () => {
    const [h, s] = await Promise.all([api("/health", {}), api("/stats", {})]);
    return text({ health: h.body, stats: s.body });
  },
);

await server.connect(new StdioServerTransport());
