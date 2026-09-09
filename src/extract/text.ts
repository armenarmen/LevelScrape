// Block-aware text extraction that works on both real DOM and linkedom documents
// (linkedom has no reliable innerText). Self-contained so it can also run in the browser.
export function domToText(root: Node): string {
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "UL", "OL", "LI", "TABLE", "TR", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "BR", "HR", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "FORM", "ADDRESS"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "HEAD"]);
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      parts.push((n.textContent || "").replace(/\s+/g, " "));
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (el.getAttribute && (el.getAttribute("hidden") !== null || el.getAttribute("aria-hidden") === "true")) return;
    const block = BLOCK.has(tag);
    if (block) parts.push("\n");
    for (const c of Array.from(el.childNodes)) walk(c);
    if (block) parts.push("\n");
  };
  walk(root);
  return parts
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
