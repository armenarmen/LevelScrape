// Runs a list of queries through the live API one at a time (the server paces
// Google hits) and records what came back, so you can measure the success rate.
//   npx tsx scripts/benchmark.ts data/exports/benchmark/queries.json data/exports/benchmark/run-<date>.jsonl
import "dotenv/config";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [queriesFile, outFile] = process.argv.slice(2);
if (!queriesFile || !outFile) {
  console.error("usage: tsx scripts/benchmark.ts <queries.json> <out.jsonl>");
  process.exit(2);
}
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3456}`;
const KEY = process.env.API_KEY!;

interface Q { q: string; cat: string; gl?: string }
interface Row {
  i: number; q: string; cat: string; gl: string; ts: string;
  http: number; ok: boolean; n: number; unresolved: number; emptySnippets: number;
  cached: boolean; elapsedMs: number; error?: string; top?: { title: string; url: string };
}

const queries: Q[] = JSON.parse(readFileSync(queriesFile, "utf8"));
// Resume support: skip queries already in the output file.
const done = new Set<string>();
if (existsSync(outFile)) {
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    if (line) done.add((JSON.parse(line) as Row).q);
  }
} else {
  writeFileSync(outFile, "");
}

let i = 0;
for (const { q, cat, gl = "us" } of queries) {
  i++;
  if (done.has(q)) continue;
  const t0 = Date.now();
  const url = `${BASE}/search?` + new URLSearchParams({ q, gl }).toString();
  const row: Row = { i, q, cat, gl, ts: new Date().toISOString(), http: 0, ok: false, n: 0, unresolved: 0, emptySnippets: 0, cached: false, elapsedMs: 0 };
  try {
    const res = await fetch(url, { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(240_000) });
    row.http = res.status;
    const body = (await res.json()) as any;
    row.elapsedMs = Date.now() - t0;
    if (res.ok) {
      const results: any[] = body.results ?? [];
      row.n = results.length;
      row.unresolved = results.filter((r) => r.gotoUrl && r.url === r.gotoUrl).length;
      row.emptySnippets = results.filter((r) => !r.snippet).length;
      row.cached = !!body.cached;
      row.ok = row.n >= 5 && row.unresolved === 0;
      if (results[0]) row.top = { title: results[0].title, url: results[0].url };
    } else {
      row.error = body.error ?? `http ${res.status}`;
      if (body.retryAfter) row.error += ` retryAfter=${body.retryAfter}`;
    }
  } catch (e) {
    row.elapsedMs = Date.now() - t0;
    row.error = e instanceof Error ? e.message : String(e);
  }
  appendFileSync(outFile, JSON.stringify(row) + "\n");
  console.log(`${String(i).padStart(3)}/${queries.length} ${row.ok ? "OK " : "BAD"} n=${row.n} unres=${row.unresolved} ${row.elapsedMs}ms ${row.error ?? ""} | ${q}`);
  // If Google blocked us, honour the cooldown before continuing instead of hammering 429s.
  if (row.error?.startsWith("blocked") || row.error?.startsWith("daily_limit")) {
    const m = /retryAfter=(\d+)/.exec(row.error);
    const wait = Math.min(Number(m?.[1] ?? 300), 1800);
    console.log(`   cooling down ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// Summary
const rows: Row[] = readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = (f: (r: Row) => boolean) => rows.filter(f);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
console.log("\n==== SUMMARY ====");
console.log(`total ${rows.length}  ok ${by((r) => r.ok).length} (${pct(by((r) => r.ok).length, rows.length)})  blocked ${by((r) => r.error?.startsWith("blocked") ?? false).length}  parse_failed ${by((r) => r.error === "parse_failed").length}  other errors ${by((r) => !!r.error && !r.error.startsWith("blocked") && r.error !== "parse_failed").length}`);
for (const cat of [...new Set(rows.map((r) => r.cat))]) {
  const c = by((r) => r.cat === cat);
  console.log(`  ${cat.padEnd(9)} ${c.length} queries, ok ${pct(c.filter((r) => r.ok).length, c.length)}, avg results ${(c.reduce((s, r) => s + r.n, 0) / c.length).toFixed(1)}, avg ms ${Math.round(c.reduce((s, r) => s + r.elapsedMs, 0) / c.length)}`);
}
const nonUs = by((r) => r.gl !== "us");
if (nonUs.length) console.log(`  non-US gl: ${nonUs.length} queries, ok ${pct(nonUs.filter((r) => r.ok).length, nonUs.length)}`);
console.log(`  results with unresolved goto links: ${rows.reduce((s, r) => s + r.unresolved, 0)} / ${rows.reduce((s, r) => s + r.n, 0)}`);
console.log(`  results with empty snippet: ${rows.reduce((s, r) => s + r.emptySnippets, 0)} / ${rows.reduce((s, r) => s + r.n, 0)}`);
