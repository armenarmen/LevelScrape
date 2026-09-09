import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { SearchParams } from "./types.js";

interface Entry<V> {
  v: V;
  exp: number;
}

/**
 * Least-recently-used cache with per-entry expiry. A JS Map remembers insertion
 * order, so "delete then re-insert on read" makes the first key the oldest.
 * Every cache hit is a Google request that never happens.
 */
export class TtlLru<V> {
  private map = new Map<string, Entry<V>>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { v: value, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** Persist to disk (called on shutdown) so a restart doesn't re-hit Google for everything. */
  save(path: string): void {
    const now = Date.now();
    const entries = [...this.map.entries()].filter(([, e]) => e.exp > now).map(([k, e]) => ({ k, v: e.v, exp: e.exp }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries));
  }

  load(path: string): number {
    if (!existsSync(path)) return 0;
    try {
      const entries = JSON.parse(readFileSync(path, "utf8")) as Array<{ k: string; v: V; exp: number }>;
      const now = Date.now();
      let n = 0;
      for (const { k, v, exp } of entries) {
        if (exp > now) {
          this.map.set(k, { v, exp });
          n++;
        }
      }
      return n;
    } catch {
      return 0;
    }
  }
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function searchCacheKey(p: SearchParams): string {
  return [normalizeQuery(p.q), p.gl, p.hl, p.udm, p.page].join("|");
}

/**
 * If two callers ask for the same key while the first is still in flight, the
 * second gets the same promise instead of a second Google request.
 */
export function coalesce<T>(inflight: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
