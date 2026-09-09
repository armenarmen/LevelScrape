// ScrapingBee-style "extract_rules": a JSON object of CSS selectors in, structured data out.
//
//   { "title": "h1",
//     "price": { "selector": ".price", "output": "text" },
//     "image": { "selector": "img.hero", "output": "@src" },
//     "products": { "selector": ".card", "type": "list",
//                   "output": { "name": ".name", "price": ".price", "url": { "selector": "a", "output": "@href" } } } }
//
// RULES FOR applyExtractRules: it runs INSIDE the browser (sent via page.evaluate) and also in Node on
// linkedom documents, so it must be self-contained: no imports, no outside references.

export type ExtractOutput = "text" | "html" | "inner_html" | `@${string}` | ExtractRules;
export interface ExtractRule {
  selector: string;
  type?: "item" | "list";
  output?: ExtractOutput;
  clean?: boolean;
}
export type ExtractRules = Record<string, string | ExtractRule>;

export function applyExtractRules(doc: Document, rules: ExtractRules, baseUrl: string): Record<string, unknown> {
  const URL_ATTRS = new Set(["href", "src", "action", "data-src", "poster", "content"]);

  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();

  const abs = (v: string) => {
    try {
      return new URL(v, baseUrl).href;
    } catch {
      return v;
    }
  };

  const normalize = (r: string | ExtractRule): Required<Pick<ExtractRule, "selector" | "type" | "output" | "clean">> =>
    typeof r === "string"
      ? { selector: r, type: "item", output: "text", clean: true }
      : { selector: r.selector, type: r.type || "item", output: r.output || "text", clean: r.clean !== false };

  const value = (el: Element, output: ExtractOutput, doClean: boolean): unknown => {
    if (typeof output === "object") return run(el, output);
    if (output === "html") return el.outerHTML;
    if (output === "inner_html") return el.innerHTML;
    if (output.startsWith("@")) {
      const name = output.slice(1);
      let v = el.getAttribute(name);
      if (v == null && name === "src" && (el as HTMLImageElement).currentSrc) v = (el as HTMLImageElement).currentSrc;
      if (v == null) return null;
      return URL_ATTRS.has(name) && /^[^:]*$|^https?:/.test(v) && !/^data:/.test(v) && name !== "content" ? abs(v) : v;
    }
    const t = el.textContent || "";
    return doClean ? clean(t) : t;
  };

  const run = (root: ParentNode, rs: ExtractRules): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rs)) {
      const r = normalize(rs[key]);
      let els: Element[];
      try {
        els = Array.from(root.querySelectorAll(r.selector));
      } catch {
        out[key] = { error: `invalid selector: ${r.selector}` };
        continue;
      }
      if (r.type === "list") out[key] = els.map((el) => value(el, r.output, r.clean));
      else out[key] = els[0] ? value(els[0], r.output, r.clean) : null;
    }
    return out;
  };

  return run(doc, rules);
}

/** Validate user-supplied rules before sending them into the page. Returns an error string or null. */
export function validateExtractRules(rules: unknown, depth = 0): string | null {
  if (depth > 4) return "rules nested too deep";
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return "extract_rules must be a JSON object";
  const entries = Object.entries(rules as Record<string, unknown>);
  if (entries.length === 0) return "extract_rules is empty";
  if (entries.length > 50) return "too many rules (max 50)";
  for (const [k, r] of entries) {
    if (typeof r === "string") {
      if (!r.trim()) return `rule "${k}": empty selector`;
      continue;
    }
    if (!r || typeof r !== "object") return `rule "${k}": must be a selector string or an object`;
    const o = r as ExtractRule;
    if (typeof o.selector !== "string" || !o.selector.trim()) return `rule "${k}": selector is required`;
    if (o.type && o.type !== "item" && o.type !== "list") return `rule "${k}": type must be item or list`;
    if (o.output !== undefined) {
      if (typeof o.output === "object") {
        const err = validateExtractRules(o.output, depth + 1);
        if (err) return `rule "${k}": ${err}`;
      } else if (typeof o.output !== "string" || !(o.output === "text" || o.output === "html" || o.output === "inner_html" || /^@[\w:-]+$/.test(o.output))) {
        return `rule "${k}": output must be text, html, inner_html, @attribute, or nested rules`;
      }
    }
  }
  return null;
}
