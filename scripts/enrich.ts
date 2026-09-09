// Phase 2 of the benchmark: take successful searches, open the top result(s)
// with /fetch?format=meta, and judge whether the page yields usable data.
//   npx tsx scripts/enrich.ts data/exports/benchmark/run-<date>.jsonl data/exports/benchmark/enrich-<date>.json [perCategory=12] [topN=1]
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

const [runFile, outFile, perCatArg = "12", topNArg = "1"] = process.argv.slice(2);
if (!runFile || !outFile) {
  console.error("usage: tsx scripts/enrich.ts <run.jsonl> <out.json> [perCategory] [topN]");
  process.exit(2);
}
const PER_CAT = Number(perCatArg);
const TOP_N = Number(topNArg);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3456}`;
const KEY = process.env.API_KEY!;

type Row = { q: string; cat: string; ok: boolean; top?: { title: string; url: string } };
const rows: Row[] = readFileSync(runFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Evenly spaced picks per category so the subset isn't just the first N.
function pick(cat: string): Row[] {
  const ok = rows.filter((r) => r.cat === cat && r.ok && r.top);
  if (ok.length <= PER_CAT) return ok;
  const step = ok.length / PER_CAT;
  return Array.from({ length: PER_CAT }, (_, i) => ok[Math.floor(i * step)]);
}

async function api(path: string, params: Record<string, string>) {
  const res = await fetch(`${BASE}${path}?` + new URLSearchParams(params), { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(120_000) });
  return { status: res.status, body: (await res.json()) as any };
}

const SOCIAL = /(facebook|instagram|reddit|youtube|tiktok|pinterest|x\.com|twitter)\./i;

function ldNodes(jsonLd: any[]): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "object") {
      out.push(n);
      if (n["@graph"]) walk(n["@graph"]);
    }
  };
  walk(jsonLd);
  return out;
}

function judge(cat: string, url: string, meta: any) {
  const nodes = ldNodes(meta.jsonLd ?? []);
  const types = [...new Set(nodes.flatMap((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]])).filter(Boolean))] as string[];
  const product = nodes.find((n) => /Product/i.test(String(n["@type"])));
  const offers = product ? (Array.isArray(product.offers) ? product.offers[0] : product.offers) : null;
  const price = offers?.price ?? offers?.lowPrice ?? meta.meta?.["product:price:amount"] ?? meta.meta?.["og:price:amount"] ?? null;
  const currency = offers?.priceCurrency ?? meta.meta?.["product:price:currency"] ?? null;
  const brand = product?.brand?.name ?? product?.brand ?? meta.meta?.["product:brand"] ?? null;
  const itemList = nodes.find((n) => /ItemList/i.test(String(n["@type"])));
  const listItems: string[] = itemList?.itemListElement?.map((it: any) => it?.name ?? it?.item?.name).filter(Boolean).slice(0, 10) ?? [];

  let pageType: "product" | "article" | "social" | "listing" | "thin";
  if (product && price != null) pageType = "product";
  else if (SOCIAL.test(url)) pageType = "social";
  else if (types.some((t) => /Article|BlogPosting|NewsArticle|Recipe|HowTo/i.test(t)) || (meta.wordCount ?? 0) >= 500) pageType = "article";
  else if (itemList || (meta.wordCount ?? 0) >= 200) pageType = "listing";
  else pageType = "thin";

  const fields = {
    title: !!meta.title,
    description: !!meta.description,
    mainImage: !!meta.mainImage,
    bodyText: (meta.wordCount ?? 0) >= 300,
    structuredData: types.length > 0,
    price: price != null,
    brand: !!brand,
  };
  // What "usable" means per intent. Purchase: a product page with price+image, OR a review/list article
  // with real body text and an image. Travel: an article/listing with description, image and body text.
  const usable =
    cat === "purchase"
      ? (pageType === "product" && fields.price && fields.mainImage) || ((pageType === "article" || pageType === "listing") && fields.bodyText && fields.mainImage)
      : (pageType === "article" || pageType === "listing") && fields.description && fields.mainImage && fields.bodyText;

  return {
    pageType,
    usable,
    fields,
    types,
    product: product ? { name: product.name, brand, price, currency, availability: offers?.availability, image: Array.isArray(product.image) ? product.image[0] : product.image } : null,
    listItems,
  };
}

const subset = [...pick("travel"), ...pick("purchase")];
console.log(`enriching ${subset.length} queries, top ${TOP_N} result(s) each`);
const results: any[] = [];

async function one(r: Row) {
  const { body } = await api("/search", { q: r.q }); // cached from the benchmark run
  const tops = (body.results ?? []).slice(0, TOP_N);
  for (const t of tops) {
    const t0 = Date.now();
    const f = await api("/fetch", { url: t.url, format: "meta" });
    const entry: any = { q: r.q, cat: r.cat, position: t.position, url: t.url, serpTitle: t.title, http: f.status, ms: Date.now() - t0 };
    if (f.status === 200 && f.body.meta) {
      const m = f.body.meta;
      Object.assign(entry, judge(r.cat, f.body.finalUrl, m), {
        pageStatus: f.body.status,
        title: m.title,
        description: m.description,
        mainImage: m.mainImage,
        wordCount: m.wordCount,
        h1: m.h1,
        excerpt: (m.text ?? "").slice(0, 300),
      });
    } else {
      entry.pageType = "error";
      entry.usable = false;
      entry.error = f.body.error ?? f.body.message ?? `http ${f.status}`;
    }
    results.push(entry);
    console.log(`${entry.usable ? "USABLE " : "weak   "} ${entry.pageType.padEnd(8)} ${r.cat.padEnd(8)} #${t.position} ${String(entry.http).padEnd(3)} ${r.q} -> ${t.url.slice(0, 70)}${entry.error ? " ERR " + entry.error : ""}`);
  }
}

// Two at a time, matching the server's fetch concurrency.
let idx = 0;
await Promise.all([0, 1].map(async () => { while (idx < subset.length) await one(subset[idx++]); }));

results.sort((a, b) => a.cat.localeCompare(b.cat) || a.q.localeCompare(b.q));
const summary: any = { total: results.length, usable: results.filter((r) => r.usable).length, byCat: {}, byPageType: {} };
for (const cat of ["travel", "purchase"]) {
  const c = results.filter((r) => r.cat === cat);
  summary.byCat[cat] = { n: c.length, usable: c.filter((r) => r.usable).length };
}
for (const r of results) {
  summary.byPageType[r.pageType] ??= { n: 0, usable: 0 };
  summary.byPageType[r.pageType].n++;
  if (r.usable) summary.byPageType[r.pageType].usable++;
}
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
console.log("\n==== SUMMARY ====\n" + JSON.stringify(summary, null, 2));
console.log(`wrote ${outFile}`);
