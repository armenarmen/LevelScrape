import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { extractOrganic, extractSerpExtras } from "../src/google/parse.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

function parse(file: string) {
  const { document } = parseHTML(readFileSync(join(FIXTURES, file), "utf8"));
  return extractOrganic(document as unknown as Document);
}

test("synthetic fixture: structure-based extraction", () => {
  const r = parse("serp-synthetic.html");

  assert.equal(r.length, 3, JSON.stringify(r, null, 2));

  assert.equal(r[0].position, 1);
  assert.equal(r[0].title, "Browsers | Playwright");
  assert.equal(r[0].url, "https://playwright.dev/docs/browsers");
  assert.equal(r[0].displayedUrl, "playwright.dev › docs › browsers");
  assert.match(r[0].snippet, /^Each version of Playwright/);

  // /url?q= wrapper unwrapped, sitelinks attached
  assert.equal(r[1].url, "https://github.com/microsoft/playwright");
  assert.match(r[1].snippet, /framework for Web Testing/);
  assert.deepEqual(
    r[1].sitelinks?.map((s) => s.title),
    ["Releases", "Issues"],
  );

  // date prefix stripped, google-hosted link and duplicate url skipped, ads skipped
  assert.equal(r[2].url, "https://example.org/article");
  assert.match(r[2].snippet, /^Google detects headless/);
  assert.ok(!r.some((x) => /ads\d?\.example\.com/.test(x.url)));
});

test("live fixtures (serp-live-*.html): at least 5 complete results", () => {
  const live = readdirSync(FIXTURES).filter((f) => /^serp-live-.*\.html$/.test(f));
  for (const f of live) {
    const r = parse(f);
    assert.ok(r.length >= 5, `${f}: only ${r.length} results`);
    for (const x of r) {
      assert.ok(x.title, `${f}: missing title at position ${x.position}`);
      assert.match(x.url, /^https?:\/\//, `${f}: bad url ${x.url}`);
      // Since Aug 2026 Google wraps links in /goto; the parser must flag those so they get resolved later.
      if (/google\.[a-z.]+\/goto/.test(x.url)) assert.equal(x.gotoUrl, x.url, `${f}: goto link not flagged`);
      assert.ok(x.displayedUrl.length > 0, `${f}: empty displayedUrl for "${x.title}"`);
      assert.ok(x.snippet.length > 0, `${f}: empty snippet for "${x.title}"`);
    }
  }
});

test("udm=0 fixture: People Also Ask, related searches, local pack, result count", () => {
  const { document } = parseHTML(readFileSync(join(FIXTURES, "serp-live-udm0-2026-09-09.html"), "utf8"));
  const d = document as unknown as Document;
  const organic = extractOrganic(d);
  assert.ok(organic.length >= 5, `only ${organic.length} organic`);
  const x = extractSerpExtras(d, "best hot springs in Nevada");
  assert.ok(x.resultCount && x.resultCount > 1_000_000, `resultCount ${x.resultCount}`);
  assert.ok(x.peopleAlsoAsk.length >= 3, JSON.stringify(x.peopleAlsoAsk));
  assert.ok(x.peopleAlsoAsk.every((q) => q.toLowerCase() !== "best hot springs in nevada"));
  assert.ok(x.relatedSearches.length >= 5, JSON.stringify(x.relatedSearches));
  assert.ok(x.relatedSearches.every((r) => !/^\d+$/.test(r)));
  assert.equal(x.localResults.length, 3, JSON.stringify(x.localResults));
  assert.equal(x.localResults[0].name, "Carson Hot Springs");
  assert.equal(x.localResults[0].rating, 4.4);
  assert.equal(x.localResults[0].reviews, "2.1K");
  assert.match(x.localResults[0].details, /Carson City/);
});
