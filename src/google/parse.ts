import type { Page } from "playwright";
import type { OrganicResult, SerpExtras } from "../types.js";

/**
 * Pull organic results out of a Google results page.
 *
 * RULES FOR THIS FUNCTION (read before editing):
 *  - It runs INSIDE the browser: we send its source text to the page with
 *    page.evaluate. So it must be self-contained: no imports, no references to
 *    anything outside its own body, no module-level helpers.
 *  - It must not rely on Google's class names (like "yuRUbf"). Those are
 *    machine-generated and change all the time. It uses structure instead:
 *    "an <a> that contains an <h3>" is a result title, and the nearest ancestor
 *    with a data-hveid attribute is the result card.
 *  - It is pure (Document in, array out) so test/parse.test.ts can run it on
 *    saved HTML. When Google changes its markup, save the new page to
 *    test/fixtures and fix this function until the test passes again.
 *  - Since Aug 2026 Google wraps links as google.com/goto?url=<encrypted>. Those
 *    are kept and flagged with gotoUrl; src/google/resolve.ts resolves them later.
 */
export function extractOrganic(doc: Document): OrganicResult[] {
  const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$|googleusercontent\.com$|(^|\.)gstatic\.com$|(^|\.)googleadservices\.com$/i;

  const root = doc.querySelector("#rso") || doc.querySelector("#search") || doc.querySelector('div[role="main"]') || doc.body;
  if (!root) return [];

  const text = (el: Element | null | undefined): string => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();

  const unwrap = (href: string, depth = 0): { url: string; goto: boolean } | null => {
    if (depth > 3) return null;
    try {
      const u = new URL(href, "https://www.google.com/");
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (GOOGLE_HOST.test(u.hostname)) {
        if (u.pathname === "/goto") return { url: u.href, goto: true };
        if (u.pathname === "/url") {
          const real = u.searchParams.get("q") || u.searchParams.get("url");
          return real ? unwrap(real, depth + 1) : null;
        }
        return null;
      }
      return { url: u.href, goto: false };
    } catch {
      return null;
    }
  };

  const isAd = (el: Element): boolean => !!el.closest('#tads, #tadsb, #bottomads, [data-text-ad], [data-ad-slot], [aria-label="Ads"]');

  const anchors = Array.from(root.querySelectorAll("a[href]")).filter((a) => a.querySelector("h3"));
  const byContainer = new Map<Element, OrganicResult>();
  const seenUrls = new Set<string>();
  const results: OrganicResult[] = [];

  for (const a of anchors) {
    const dest = unwrap(a.getAttribute("href") || "");
    if (!dest) continue;
    const url = dest.url;
    if (isAd(a)) continue;

    const container: Element =
      a.closest("[data-hveid]") || a.closest("div.g") || (a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.parentElement) || a;

    const h3Title = text(a.querySelector("h3"));

    const existing = byContainer.get(container);
    if (existing) {
      if (h3Title && !seenUrls.has(url)) {
        if (!existing.sitelinks) existing.sitelinks = [];
        const sl: { title: string; url: string; gotoUrl?: string } = { title: h3Title, url };
        if (dest.goto) sl.gotoUrl = url;
        existing.sitelinks.push(sl);
        seenUrls.add(url);
      }
      continue;
    }

    if (seenUrls.has(url)) continue;
    if (!h3Title) continue;
    if (/^Sponsored\b/.test(text(container))) continue;

    let displayedUrl = text(container.querySelector("cite"));
    if (!displayedUrl && !dest.goto) {
      try {
        const u = new URL(url);
        displayedUrl = u.hostname + (u.pathname !== "/" ? u.pathname : "");
      } catch {
        displayedUrl = url;
      }
    }

    // Snippet. Google marks the description block (data-sncf, or a line-clamped
    // div); a sibling header block (data-snf + data-snhf) holds the title and
    // site name, so skip anything that contains the h3 or the cite.
    let snippet = "";
    const marked = Array.from(container.querySelectorAll('[data-sncf], [style*="-webkit-line-clamp"], [data-snf]')).filter(
      (el) => !el.querySelector("h3") && !el.querySelector("cite") && !el.closest("a"),
    );
    for (const el of marked) {
      const t = text(el);
      if (t.length >= 40) {
        snippet = t;
        break;
      }
    }
    if (snippet.length < 40) {
      const cands = Array.from(container.querySelectorAll("span, div")).filter((el) => {
        if (el.closest("a") || el.closest("cite") || el.querySelector("h3") || el.querySelector("cite")) return false;
        const t = text(el);
        if (t.length < 40 || t === h3Title || t === displayedUrl) return false;
        for (const c of Array.from(el.children)) {
          if (c.tagName !== "EM" && c.tagName !== "B" && text(c).length > 40) return false;
        }
        return true;
      });
      cands.sort((x, y) => text(y).length - text(x).length);
      if (cands[0]) snippet = text(cands[0]);
    }
    snippet = snippet.replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4} — /, "");

    const r: OrganicResult = { position: results.length + 1, title: h3Title, url, displayedUrl, snippet };
    if (dest.goto) r.gotoUrl = url;
    byContainer.set(container, r);
    seenUrls.add(url);
    results.push(r);
  }

  return results;
}

/**
 * Everything on the results page that is not an organic result: People Also Ask,
 * related searches, result count, ads, local pack, knowledge panel. Same rules as
 * extractOrganic: self-contained, structure-based, fixture-tested.
 * Most of these only appear on the normal results page (udm=0), not the "Web" tab.
 */
export function extractSerpExtras(doc: Document, query: string): SerpExtras {
  const text = (el: Element | null | undefined): string => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const q = query.trim().toLowerCase();

  // Result count: "About 55,000,000 results (0.39s)"
  let resultCount: number | null = null;
  const stats = text(doc.querySelector("#result-stats"));
  const m = /([\d.,]+)\s+results?/i.exec(stats);
  if (m) resultCount = Number(m[1].replace(/[.,]/g, "")) || null;

  // People Also Ask: each question carries a data-q attribute (the first one is the query itself).
  const peopleAlsoAsk: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[data-q]"))) {
    const v = (el.getAttribute("data-q") || "").trim();
    if (!v || v.toLowerCase() === q || peopleAlsoAsk.includes(v)) continue;
    if (v.length < 12) continue;
    peopleAlsoAsk.push(v);
  }

  // Related searches live at the bottom in #botstuff (skip pagination numbers and "Next").
  const relatedSearches: string[] = [];
  for (const a of Array.from(doc.querySelectorAll('#botstuff a[href*="/search?"], #bres a[href*="/search?"]'))) {
    const t = text(a);
    if (!t || /^\d+$/.test(t) || /^(next|more results|previous)$/i.test(t) || t.toLowerCase() === q) continue;
    if (t.length > 120 || relatedSearches.includes(t)) continue;
    relatedSearches.push(t);
  }

  // Ads (unverified against a fixture: no ads appeared in our captures).
  const ads: SerpExtras["ads"] = [];
  for (const a of Array.from(doc.querySelectorAll("#tads a[href], #tadsb a[href], #bottomads a[href]"))) {
    const heading = a.querySelector("h3, [role=heading]");
    if (!heading) continue;
    const pcu = (a.getAttribute("data-pcu") || "").split("|")[0];
    let url = pcu || a.getAttribute("href") || "";
    try {
      url = new URL(url, "https://www.google.com/").href;
    } catch {
      /* keep raw */
    }
    const card = a.closest("[data-hveid]") || a;
    ads.push({ title: text(heading), url, displayedUrl: text(card.querySelector("cite, span[role=text]")) });
  }

  // Local pack: the section under an h2 "Local Results"; items are role=heading level 3
  // with an aria-label like "Rated 4.4 out of 5, 2.1K user reviews" nearby.
  const localResults: SerpExtras["localResults"] = [];
  const localH2 = Array.from(doc.querySelectorAll("h2")).find((h) => /^local results$/i.test(text(h)) || /^places$/i.test(text(h)));
  if (localH2) {
    let section: Element | null = localH2;
    for (let i = 0; i < 5 && section; i++) {
      if (section.querySelectorAll('div[role="heading"][aria-level="3"]').length >= 1 && section !== localH2) break;
      section = section.parentElement;
    }
    if (section) {
      for (const h of Array.from(section.querySelectorAll('div[role="heading"][aria-level="3"]'))) {
        const name = text(h);
        if (!name) continue;
        let item: Element = h;
        for (let i = 0; i < 6 && item.parentElement; i++) {
          item = item.parentElement;
          if (item.querySelector('[aria-label^="Rated"]') || /\d\.\d\(/.test(text(item))) break;
        }
        const ratedLabel = item.querySelector('[aria-label^="Rated"]')?.getAttribute("aria-label") || "";
        const rm = /Rated ([\d.]+) out of 5,?\s*([\d.,]+[KkMm]?)?/.exec(ratedLabel);
        let details = text(item);
        if (details.startsWith(name)) details = details.slice(name.length);
        details = details.replace(/^\s*\d\.\d\([\d.,KkMm]+\)\s*·?\s*/, "").trim();
        localResults.push({ name, rating: rm ? Number(rm[1]) : null, reviews: rm && rm[2] ? rm[2] : null, details });
        if (localResults.length >= 10) break;
      }
    }
  }

  // Knowledge panel (unverified: none appeared in our captures). Google labels its parts with data-attrid.
  let knowledgeGraph: SerpExtras["knowledgeGraph"] = null;
  const kgTitle = doc.querySelector('[data-attrid="title"]');
  if (kgTitle && text(kgTitle)) {
    const facts: Record<string, string> = {};
    for (const f of Array.from(doc.querySelectorAll('[data-attrid^="kc:"], [data-attrid^="ss:"], [data-attrid^="hw:"]'))) {
      const key = (f.getAttribute("data-attrid") || "").replace(/^[a-z]+:\/?/, "");
      const v = text(f);
      if (key && v && v.length < 300 && !(key in facts)) facts[key] = v;
    }
    knowledgeGraph = {
      title: text(kgTitle),
      subtitle: text(doc.querySelector('[data-attrid="subtitle"]')) || null,
      description: text(doc.querySelector('[data-attrid="description"]')) || null,
      facts,
    };
  }

  return { resultCount, peopleAlsoAsk, relatedSearches, ads, localResults, knowledgeGraph };
}

export async function parseSerp(page: Page, query: string): Promise<{ results: OrganicResult[]; extras: SerpExtras; noResults: boolean }> {
  const results = (await page.evaluate(`(${extractOrganic.toString()})(document)`)) as OrganicResult[];
  const extras = (await page.evaluate(`(${extractSerpExtras.toString()})(document, ${JSON.stringify(query)})`)) as SerpExtras;
  const noResults =
    results.length === 0 &&
    (await page.evaluate(() => /did not match any documents|No results found for/i.test(document.body ? document.body.innerText : "")).catch(() => false));
  return { results, extras, noResults };
}
