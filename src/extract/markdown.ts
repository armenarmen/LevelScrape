// HTML -> Markdown, Node side. Used for format=markdown and as the input to AI extraction.
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.remove(["script", "style", "noscript", "template", "iframe", "svg", "form", "button", "select", "input"] as unknown as (keyof HTMLElementTagNameMap)[]);

export interface MarkdownOptions {
  /** Prefer <article>/<main> when present (default true). */
  mainContent?: boolean;
  /** Resolve relative links/images against this URL. */
  baseUrl?: string;
  /** Hard cap on output length. */
  maxChars?: number;
}

export function htmlToMarkdown(html: string, opts: MarkdownOptions = {}): { markdown: string; truncated: boolean } {
  const { document } = parseHTML(html);
  for (const sel of ["nav", "header", "footer", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[aria-hidden=true]"]) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
  let root: Element | null = null;
  if (opts.mainContent !== false) root = document.querySelector("article, main, [role=main]");
  if (!root) root = document.body || document.documentElement;

  if (opts.baseUrl) {
    for (const a of Array.from(root.querySelectorAll("a[href], img[src]"))) {
      const attr = a.tagName === "A" ? "href" : "src";
      const v = a.getAttribute(attr);
      if (v && !/^(https?:|data:|mailto:|#)/.test(v)) {
        try {
          a.setAttribute(attr, new URL(v, opts.baseUrl).href);
        } catch {
          /* leave as is */
        }
      }
    }
  }

  let md = td.turndown(root.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
  const max = opts.maxChars ?? 3 * 1024 * 1024;
  const truncated = md.length > max;
  if (truncated) md = md.slice(0, max);
  return { markdown: md, truncated };
}
