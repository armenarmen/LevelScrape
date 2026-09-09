// Optional AI extraction. Talks to ANY OpenAI-compatible chat-completions endpoint
// (OpenAI, xAI, Anthropic's compatibility endpoint, OpenRouter, Meta, a local server...).
// Configure AI_BASE_URL + AI_API_KEY + AI_MODEL in .env; leave them blank to disable.
import type { Config } from "./config.js";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("ai_not_configured");
    this.name = "AiNotConfiguredError";
  }
}
export class AiError extends Error {
  constructor(msg: string, public readonly status?: number) {
    super(msg);
    this.name = "AiError";
  }
}

export interface AiResult {
  model: string;
  inputChars: number;
  truncated: boolean;
  answer?: string;               // for ai_query
  extracted?: unknown;           // for ai_extract_rules
  usage?: unknown;
}

export function aiConfigured(cfg: Config): boolean {
  return !!(cfg.aiApiKey && cfg.aiModel && cfg.aiBaseUrl);
}

async function chat(cfg: Config, messages: Array<{ role: string; content: string }>, json: boolean): Promise<{ text: string; usage?: unknown }> {
  if (!aiConfigured(cfg)) throw new AiNotConfiguredError();
  const body: Record<string, unknown> = { model: cfg.aiModel, messages, temperature: 0 };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(`${cfg.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.aiApiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.aiTimeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new AiError(data?.error?.message || `ai provider returned ${res.status}`, res.status);
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  return { text, usage: data?.usage };
}

function prep(cfg: Config, markdown: string): { doc: string; truncated: boolean } {
  const truncated = markdown.length > cfg.aiMaxInputChars;
  return { doc: truncated ? markdown.slice(0, cfg.aiMaxInputChars) : markdown, truncated };
}

/** Free-text question about the page. */
export async function aiQuery(cfg: Config, markdown: string, question: string, url: string): Promise<AiResult> {
  const { doc, truncated } = prep(cfg, markdown);
  const { text, usage } = await chat(
    cfg,
    [
      { role: "system", content: "You answer questions about a web page using only the page content provided. Be concise. If the page does not contain the answer, say so." },
      { role: "user", content: `URL: ${url}\n\nPAGE CONTENT (markdown):\n"""\n${doc}\n"""\n\nQUESTION: ${question}` },
    ],
    false,
  );
  return { model: cfg.aiModel, inputChars: doc.length, truncated, answer: text.trim(), usage };
}

/**
 * Schema-guided extraction. `rules` is a JSON object whose keys are the fields you want and
 * whose values describe them, e.g. { "price": "numeric price in USD", "brand": "brand name",
 * "sizes": "list of available sizes" }. Values may also be nested objects.
 */
export async function aiExtract(cfg: Config, markdown: string, rules: Record<string, unknown>, url: string): Promise<AiResult> {
  const { doc, truncated } = prep(cfg, markdown);
  const { text, usage } = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "You extract structured data from a web page. Respond with a single JSON object whose keys exactly match the requested fields. Use null for anything not present on the page. Use numbers for numeric values, arrays for lists. No commentary.",
      },
      { role: "user", content: `URL: ${url}\n\nFIELDS TO EXTRACT (key: description):\n${JSON.stringify(rules, null, 2)}\n\nPAGE CONTENT (markdown):\n"""\n${doc}\n"""` },
    ],
    true,
  );
  let extracted: unknown;
  try {
    extracted = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new AiError("model did not return valid JSON: " + text.slice(0, 200));
  }
  return { model: cfg.aiModel, inputChars: doc.length, truncated, extracted, usage };
}
