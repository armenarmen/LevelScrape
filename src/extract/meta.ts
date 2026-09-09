import type { PageMeta } from "../types.js";

/**
 * Structured page metadata: what you'd want for a link preview or an SEO audit.
 * Runs INSIDE the browser (via page.evaluate) and also on linkedom documents in
 * Node, so it must stay self-contained and tolerate missing browser-only APIs
 * (innerText, naturalWidth, currentSrc).
 */
export function extractPageMeta(doc: Document): PageMeta {
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
  // Real DOM: baseURI already honours <base>. linkedom: no baseURI, so look for <base>, then canonical.
  const baseEl = doc.querySelector("base[href]");
  const canonEl = doc.querySelector('link[rel="canonical"]');
  const base =
    (baseEl && baseEl.getAttribute("href")) ||
    (doc.baseURI && !/^about:/.test(doc.baseURI) ? doc.baseURI : "") ||
    (canonEl && canonEl.getAttribute("href")) ||
    "https://invalid.local/";
  const abs = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u, base).href;
    } catch {
      return null;
    }
  };

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const m of Array.from(doc.querySelectorAll("meta"))) {
    const key = m.getAttribute("property") || m.getAttribute("name") || m.getAttribute("itemprop");
    const content = m.getAttribute("content");
    if (!key || content == null) continue;
    const k = key.toLowerCase();
    if (k.startsWith("og:")) openGraph[k.slice(3)] = content;
    else if (k.startsWith("twitter:")) twitter[k.slice(8)] = content;
    else if (!(k in meta)) meta[k] = content;
  }

  const jsonLd: unknown[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      jsonLd.push(JSON.parse(s.textContent || ""));
    } catch {
      /* malformed */
    }
  }

  const seen = new Set<string>();
  const images: Array<{ src: string; alt: string; width: number; height: number }> = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const i = img as HTMLImageElement;
    const src = abs(i.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src"));
    if (!src || seen.has(src) || /^data:/.test(src)) continue;
    const w = i.naturalWidth || Number(img.getAttribute("width")) || 0;
    const h = i.naturalHeight || Number(img.getAttribute("height")) || 0;
    if (w && h && (w < 120 || h < 120)) continue; // icons, pixels, avatars
    seen.add(src);
    images.push({ src, alt: clean(img.getAttribute("alt")), width: w, height: h });
  }
  images.sort((a, b) => b.width * b.height - a.width * a.height);

  const main = doc.querySelector("article, main, [role='main']") || doc.body;
  let bodyText = "";
  if (main) {
    const anyMain = main as HTMLElement & { innerText?: string };
    bodyText = clean(typeof anyMain.innerText === "string" && anyMain.innerText ? anyMain.innerText : main.textContent);
  }

  return {
    title: clean(doc.title),
    description: meta["description"] || openGraph["description"] || twitter["description"] || null,
    canonical: abs((doc.querySelector('link[rel="canonical"]') || { getAttribute: () => null }).getAttribute("href")),
    lang: doc.documentElement ? doc.documentElement.getAttribute("lang") : null,
    h1: Array.from(doc.querySelectorAll("h1")).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 5),
    openGraph,
    twitter,
    meta,
    jsonLd,
    images: images.slice(0, 15),
    mainImage: abs(openGraph["image"] || openGraph["image:url"] || twitter["image"] || null) || (images[0] ? images[0].src : null),
    text: bodyText.slice(0, 2000),
    wordCount: bodyText ? bodyText.split(" ").length : 0,
  };
}
