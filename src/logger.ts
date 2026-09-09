import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { RequestLogEntry } from "./types.js";

const LOG_DIR = "./data/logs";
const DAY_MS = 86_400_000;

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let infoOut: (msg: string) => void = console.log;

/** Send INFO lines to stderr too, so stdout stays clean JSON (used by the CLI). */
export function logToStderr(): void {
  infoOut = console.error;
}

/** Plain console logging with a timestamp. */
export const log = {
  info: (msg: string) => infoOut(`${stamp()} INFO  ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} WARN  ${msg}`),
  error: (msg: string) => console.error(`${stamp()} ERROR ${msg}`),
};

export interface Stats {
  last24h: {
    searches: number;        // Google hits (cache hits excluded)
    ok: number;
    blocked: number;
    parseFailed: number;
    errors: number;
    cached: number;
    fetches: number;
    successRate: number | null; // ok / searches
  };
  lastSuccessAt: string | null;
  lastBlockAt: string | null;
}

// Rolling window of the last 24h, kept in memory so /stats never reads files.
let ring: Array<{ t: number; kind: RequestLogEntry["kind"]; outcome: RequestLogEntry["outcome"] }> = [];
let lastSuccessAt: string | null = null;
let lastBlockAt: string | null = null;
let retentionDays = 14;

function fileFor(d: Date): string {
  return join(LOG_DIR, `requests-${d.toISOString().slice(0, 10)}.jsonl`);
}

function remember(e: RequestLogEntry): void {
  const t = Date.parse(e.ts);
  ring.push({ t, kind: e.kind, outcome: e.outcome });
  if (e.kind === "search" && e.outcome === "ok") lastSuccessAt = e.ts;
  if (e.outcome === "blocked") lastBlockAt = e.ts;
}

function trimRing(): void {
  const cutoff = Date.now() - DAY_MS;
  if (ring.length && ring[0].t < cutoff) ring = ring.filter((r) => r.t >= cutoff);
}

export function initLogger(retention: number): void {
  retentionDays = retention;
  mkdirSync(LOG_DIR, { recursive: true });

  // Seed the 24h window from today's and yesterday's files.
  for (const d of [new Date(Date.now() - DAY_MS), new Date()]) {
    const f = fileFor(d);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        remember(JSON.parse(line) as RequestLogEntry);
      } catch {
        /* skip bad line */
      }
    }
  }
  trimRing();
  pruneLogs(retentionDays);

  // Prune old files roughly once a day; unref so it never keeps the process alive.
  setInterval(() => pruneLogs(retentionDays), 6 * 3_600_000).unref();
}

export function logRequest(e: RequestLogEntry): void {
  remember(e);
  trimRing();
  try {
    appendFileSync(fileFor(new Date()), JSON.stringify(e) + "\n");
  } catch (err) {
    log.warn(`could not write request log: ${String(err)}`);
  }
  const extra = e.n !== undefined ? ` n=${e.n}` : "";
  log.info(`${e.kind} ${e.outcome} ${e.ms}ms${extra} ${e.target}${e.detail ? ` (${e.detail})` : ""}`);
}

export function pruneLogs(days: number): void {
  if (!existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - days * DAY_MS;
  for (const name of readdirSync(LOG_DIR)) {
    const m = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (Date.parse(m[1]) < cutoff) {
      try {
        unlinkSync(join(LOG_DIR, name));
      } catch {
        /* ignore */
      }
    }
  }
}

export function getStats(): Stats {
  trimRing();
  const s = { searches: 0, ok: 0, blocked: 0, parseFailed: 0, errors: 0, cached: 0, fetches: 0 };
  for (const r of ring) {
    if (r.kind === "fetch") {
      s.fetches++;
      continue;
    }
    if (r.outcome === "cached") {
      s.cached++;
      continue;
    }
    s.searches++;
    if (r.outcome === "ok") s.ok++;
    else if (r.outcome === "blocked") s.blocked++;
    else if (r.outcome === "parse_failed") s.parseFailed++;
    else s.errors++;
  }
  return {
    last24h: { ...s, successRate: s.searches ? Math.round((s.ok / s.searches) * 1000) / 10 : null },
    lastSuccessAt,
    lastBlockAt,
  };
}
