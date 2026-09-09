// Small "behave like a person" helpers, lifted from reddit-poster/src/browser/humanize.ts.
// The randomness is deliberate: perfectly regular timing is a bot signal.
import type { Page } from "playwright";

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ms plus or minus up to pct percent, e.g. jitter(30000, 40) is 18s..42s. */
export function jitter(ms: number, pct: number): number {
  const spread = ms * (pct / 100);
  return Math.max(0, Math.round(ms + randomFloat(-spread, spread)));
}

export async function humanDelay(minMs = 800, maxMs = 3000): Promise<void> {
  await sleep(randomInt(minMs, maxMs));
}

export async function humanScroll(page: Page, times?: number): Promise<void> {
  const scrollCount = times ?? randomInt(2, 6);
  for (let i = 0; i < scrollCount; i++) {
    const distance = randomInt(200, 600);
    await page.mouse.wheel(0, distance);
    await sleep(randomInt(500, 2000));

    // Occasionally scroll back up a bit, like someone re-reading.
    if (Math.random() < 0.15) {
      await page.mouse.wheel(0, -randomInt(50, 150));
      await sleep(randomInt(300, 800));
    }
  }
}

export async function humanMouseMove(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;

  const steps = randomInt(2, 4);
  for (let i = 0; i < steps; i++) {
    const x = randomInt(100, viewport.width - 100);
    const y = randomInt(100, viewport.height - 100);
    await page.mouse.move(x, y, { steps: randomInt(5, 15) });
    await sleep(randomInt(100, 400));
  }
}

/** Wait until an element's position stops changing (smooth scrolling, layout shifts). */
async function settle(el: ReturnType<Page["locator"]>, maxMs = 2000): Promise<void> {
  let last = await el.boundingBox();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(120);
    const now = await el.boundingBox();
    if (last && now && Math.abs(now.y - last.y) < 1 && Math.abs(now.x - last.x) < 1) return;
    last = now;
  }
}

export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 10_000 });
  // A raw mouse click at coordinates outside the viewport hits nothing, so bring the
  // element on screen first (Playwright's locator.click does this; page.mouse does not).
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await settle(el);
  const box = await el.boundingBox();
  const vp = page.viewportSize();
  const inView = box && (!vp || (box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width));
  if (!box || !inView) {
    await el.click();
    return;
  }
  // Click somewhere inside the element, not dead center every time.
  const x = box.x + box.width * randomFloat(0.2, 0.8);
  const y = box.y + box.height * randomFloat(0.2, 0.8);
  await page.mouse.move(x, y, { steps: randomInt(5, 12) });
  await sleep(randomInt(50, 200));
  await page.mouse.click(x, y);
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await humanClick(page, selector);
  await sleep(randomInt(200, 500));
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomInt(30, 150) });
    if (Math.random() < 0.03) await sleep(randomInt(300, 800)); // the occasional "thinking" pause
  }
}
