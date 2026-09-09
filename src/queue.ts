import { jitter, sleep } from "./humanize.js";

export class QueueFullError extends Error {
  constructor() {
    super("queue_full");
    this.name = "QueueFullError";
  }
}

export class DailyLimitError extends Error {
  constructor(max: number) {
    super(`daily_limit (${max}) reached`);
    this.name = "DailyLimitError";
  }
}

interface Pending {
  run: () => Promise<void>;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One job at a time, with a minimum (jittered) gap between job STARTS and a
 * daily ceiling. This is the "slow pacing" from the recipe: Google sees one
 * search every ~30s, never a burst.
 */
export class PacedSerialQueue {
  private pending: Pending[] = [];
  private running = false;
  private paused = false;
  private lastStartedAt = 0;
  private dayKey = todayKey();
  private dayCount = 0;

  constructor(
    private readonly opts: {
      minIntervalMs: number;
      jitterPct: number;
      maxPending: number;
      dailyMax: number;
    },
  ) {}

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.opts.maxPending) {
      return Promise.reject(new QueueFullError());
    }
    this.rollDay();
    if (this.dayCount + this.pending.length >= this.opts.dailyMax) {
      return Promise.reject(new DailyLimitError(this.opts.dailyMax));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: async () => {
          try {
            resolve(await job());
          } catch (e) {
            reject(e);
          }
        },
      });
      void this.kick();
    });
  }

  private async kick(): Promise<void> {
    if (this.running || this.paused) return;
    const next = this.pending.shift();
    if (!next) return;

    this.running = true;
    try {
      const gap = jitter(this.opts.minIntervalMs, this.opts.jitterPct);
      const wait = this.lastStartedAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStartedAt = Date.now();
      this.rollDay();
      this.dayCount++;
      await next.run();
    } finally {
      this.running = false;
      void this.kick();
    }
  }

  private rollDay(): void {
    const k = todayKey();
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.dayCount = 0;
    }
  }

  /** Stop starting new jobs (the current one finishes). Used while a captcha waits for a human. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.kick();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Jobs waiting plus the one running. */
  get depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  get todayCount(): number {
    this.rollDay();
    return this.dayCount;
  }

  /** Rough worst-case wait for a job enqueued right now. */
  estimatedWaitMs(): number {
    return this.depth * this.opts.minIntervalMs;
  }
}

/** N jobs at a time, no pacing. Used for /fetch. */
export class ConcurrentQueue {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {}

  async enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.waiters.length >= this.maxPending) throw new QueueFullError();
    if (this.active >= this.concurrency) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  get depth(): number {
    return this.active + this.waiters.length;
  }
}
