import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { htmlToMarkdown } from "../src/extract/markdown.js";
import { extractPageMeta } from "../src/extract/meta.js";
import { applyExtractRules, validateExtractRules } from "../src/extract/rules.js";
import { domToText } from "../src/extract/text.js";
import { judgeHtml } from "../src/plainfetch.js";

const HTML = `<!doctype html><html lang="en"><head><title>Shop  Socks</title>
<meta name="description" content="Merino socks for hiking">
<meta property="og:image" content="/img/hero.jpg">
<link rel="canonical" href="https://shop.example/socks">
<script type="application/ld+json">{"@type":"CollectionPage","name":"Socks"}</script>
</head><body>
<nav><a href="/">Home</a></nav>
<main><h1>Hiking Socks</h1>
<p>Warm <b>merino</b> socks.</p>
<div class="card"><a href="/p/1"><span class="name">Trail Sock</span></a><span class="price">$24.00</span><img src="/img/1.jpg" width="600" height="400" alt="Trail"></div>
<div class="card"><a href="/p/2"><span class="name">Summit Sock</span></a><span class="price">$29.00</span></div>
</main></body></html>`;

function doc() {
  const { document } = parseHTML(HTML);
  return document as unknown as Document;
}

test("extract_rules: item, list, attribute, nested", () => {
  const out = applyExtractRules(
    doc(),
    {
      title: "h1",
      missing: ".nope",
      products: { selector: ".card", type: "list", output: { name: ".name", price: ".price", url: { selector: "a", output: "@href" }, img: { selector: "img", output: "@src" } } },
      prices: { selector: ".price", type: "list" },
      firstHtml: { selector: ".price", output: "html" },
    },
    "https://shop.example/socks",
  );
  assert.equal(out.title, "Hiking Socks");
  assert.equal(out.missing, null);
  assert.deepEqual(out.prices, ["$24.00", "$29.00"]);
  assert.equal(out.firstHtml, '<span class="price">$24.00</span>');
  const products = out.products as Array<Record<string, unknown>>;
  assert.equal(products.length, 2);
  assert.equal(products[0].name, "Trail Sock");
  assert.equal(products[0].url, "https://shop.example/p/1");
  assert.equal(products[0].img, "https://shop.example/img/1.jpg");
  assert.equal(products[1].img, null);
});

test("extract_rules validation", () => {
  assert.equal(validateExtractRules({ a: "h1" }), null);
  assert.match(validateExtractRules({})!, /empty/);
  assert.match(validateExtractRules({ a: { type: "item" } })!, /selector is required/);
  assert.match(validateExtractRules({ a: { selector: "x", output: "bogus" } })!, /output must be/);
  assert.match(validateExtractRules([1])!, /JSON object/);
});

test("domToText keeps block structure", () => {
  const t = domToText(doc().body);
  assert.match(t, /Hiking Socks\n/);
  assert.match(t, /Warm merino socks\./);
  assert.ok(!/<\/?\w+>/.test(t));
});

test("markdown: main content, absolute links, nav stripped", () => {
  const { markdown } = htmlToMarkdown(HTML, { baseUrl: "https://shop.example/socks" });
  assert.match(markdown, /^# Hiking Socks/m);
  assert.match(markdown, /\*\*merino\*\*/);
  assert.match(markdown, /\(https:\/\/shop\.example\/p\/1\)/);
  assert.ok(!/Home/.test(markdown), "nav should be removed");
});

test("page meta on a static document", () => {
  const m = extractPageMeta(doc());
  assert.equal(m.title, "Shop Socks");
  assert.equal(m.description, "Merino socks for hiking");
  assert.equal(m.canonical, "https://shop.example/socks");
  assert.equal(m.lang, "en");
  assert.deepEqual(m.h1, ["Hiking Socks"]);
  assert.equal(m.mainImage, "https://shop.example/img/hero.jpg");
  assert.equal((m.jsonLd[0] as any)["@type"], "CollectionPage");
  assert.equal(m.images[0].width, 600);
});

test("auto mode judge", () => {
  assert.equal(judgeHtml(403, "text/html", "<html>x</html>").needsBrowser, true);
  assert.equal(judgeHtml(200, "text/html", "<html><body>Please enable JavaScript to continue</body></html>").needsBrowser, true);
  assert.equal(judgeHtml(200, "text/html", '<html><body><div id="root"></div></body></html>').needsBrowser, true);
  assert.equal(judgeHtml(200, "text/html", '<html><body><div id="x"></div><script src="app.js"></script></body></html>').needsBrowser, true);
  assert.equal(judgeHtml(200, "text/html", "<html><body><h1>Example Domain</h1><p>This domain is for use in examples.</p></body></html>").needsBrowser, false);
  assert.equal(judgeHtml(200, "application/json", '{"a":1}').needsBrowser, false);
  assert.equal(judgeHtml(200, "text/html", `<html><body><p>${"Real content. ".repeat(60)}</p></body></html>`).needsBrowser, false);
});
