// js_scenario: a list of browser interactions to run before the page is read.
// Same shape as ScrapingBee's:
//   {"instructions":[{"click":"#load-more"},{"wait":1000},{"wait_for":".card"},{"scroll_y":800},
//                    {"fill":["#q","socks"]},{"evaluate":"document.title"},
//                    {"infinite_scroll":{"max_count":0,"delay":1000,"end_click":{"selector":"#more"}}}]}
import type { Page } from "playwright";
import { humanClick, humanDelay, randomInt, sleep } from "./humanize.js";

export type Instruction =
  | { click: string }
  | { wait: number }
  | { wait_for: string }
  | { wait_for_and_click: string }
  | { scroll_x: number }
  | { scroll_y: number }
  | { fill: [string, string] }
  | { press: string }
  | { evaluate: string }
  | { infinite_scroll: { max_count?: number; delay?: number; end_click?: { selector: string } } };

export interface JsScenario {
  instructions: Instruction[];
  /** Stop at the first failing instruction (default true). false = skip failures and continue. */
  strict?: boolean;
}

export interface ScenarioStepResult {
  step: number;
  instruction: string;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}

const MAX_STEPS = 40;

export function validateScenario(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "js_scenario must be a JSON object";
  const ins = (raw as JsScenario).instructions;
  if (!Array.isArray(ins) || ins.length === 0) return "js_scenario.instructions must be a non-empty array";
  if (ins.length > MAX_STEPS) return `too many instructions (max ${MAX_STEPS})`;
  for (const [i, step] of ins.entries()) {
    if (!step || typeof step !== "object") return `instruction ${i}: must be an object`;
    const keys = Object.keys(step);
    if (keys.length !== 1) return `instruction ${i}: exactly one key expected, got ${keys.join(",")}`;
    const k = keys[0];
    const v = (step as Record<string, unknown>)[k];
    switch (k) {
      case "click":
      case "wait_for":
      case "wait_for_and_click":
      case "evaluate":
      case "press":
        if (typeof v !== "string" || !v.trim()) return `instruction ${i}: ${k} needs a string`;
        break;
      case "wait":
      case "scroll_x":
      case "scroll_y":
        if (typeof v !== "number" || !Number.isFinite(v)) return `instruction ${i}: ${k} needs a number`;
        if (k === "wait" && (v < 0 || v > 35_000)) return `instruction ${i}: wait must be 0-35000 ms`;
        break;
      case "fill":
        if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return `instruction ${i}: fill needs [selector, text]`;
        break;
      case "infinite_scroll":
        if (v !== null && typeof v !== "object") return `instruction ${i}: infinite_scroll needs an object`;
        break;
      default:
        return `instruction ${i}: unknown instruction "${k}"`;
    }
  }
  return null;
}

async function scrollBy(page: Page, dx: number, dy: number): Promise<void> {
  // Scroll in human-sized wheel steps rather than one jump.
  const steps = Math.max(1, Math.min(12, Math.ceil(Math.abs(dy || dx) / 400)));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx / steps, dy / steps);
    await sleep(randomInt(80, 220));
  }
}

/** Page "size" for change detection: total height plus number of elements, so lazy grids that don't grow taller still count. */
async function pageSize(page: Page): Promise<{ height: number; nodes: number }> {
  return (await page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    nodes: document.getElementsByTagName("*").length,
  }))) as { height: number; nodes: number };
}

async function infiniteScroll(
  page: Page,
  opts: { max_count?: number; delay?: number; end_click?: { selector: string } },
): Promise<{ rounds: number; clicks: number; finalHeight: number; finalNodes: number }> {
  const maxCount = opts.max_count && opts.max_count > 0 ? opts.max_count : 50;
  const delay = opts.delay ?? 1000;
  let last = { height: -1, nodes: -1 };
  let unchanged = 0;
  let rounds = 0;
  let clicks = 0;
  for (; rounds < maxCount; rounds++) {
    const size = await pageSize(page);
    if (size.height === last.height && size.nodes === last.nodes) {
      unchanged++;
      if (unchanged >= 2) break; // nothing new loaded two rounds in a row
    } else {
      unchanged = 0;
    }
    last = size;
    await scrollBy(page, 0, Math.max(600, size.height)); // to the bottom, in wheel steps
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior }));
    await sleep(delay + randomInt(0, 400));
    if (opts.end_click?.selector) {
      const btn = page.locator(opts.end_click.selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await humanClick(page, opts.end_click.selector).catch(() => {});
        clicks++;
        // Give the click up to 3x delay to actually change the page.
        const before = await pageSize(page);
        const deadline = Date.now() + delay * 3;
        while (Date.now() < deadline) {
          await sleep(300);
          const now = await pageSize(page);
          if (now.height !== before.height || now.nodes !== before.nodes) break;
        }
        unchanged = 0;
      }
    }
  }
  const final = await pageSize(page);
  return { rounds, clicks, finalHeight: final.height, finalNodes: final.nodes };
}

export async function runScenario(page: Page, scenario: JsScenario): Promise<ScenarioStepResult[]> {
  const results: ScenarioStepResult[] = [];
  const strict = scenario.strict !== false;
  for (const [i, step] of scenario.instructions.entries()) {
    const k = Object.keys(step)[0];
    const v = (step as Record<string, unknown>)[k];
    const t0 = Date.now();
    const r: ScenarioStepResult = { step: i, instruction: k, ok: true, ms: 0 };
    try {
      switch (k) {
        case "click":
          await humanClick(page, v as string);
          await humanDelay(200, 600);
          break;
        case "wait":
          await sleep(v as number);
          break;
        case "wait_for":
          await page.waitForSelector(v as string, { timeout: 20_000 });
          break;
        case "wait_for_and_click":
          await page.waitForSelector(v as string, { timeout: 20_000 });
          await humanClick(page, v as string);
          await humanDelay(200, 600);
          break;
        case "scroll_x":
          await scrollBy(page, v as number, 0);
          break;
        case "scroll_y":
          await scrollBy(page, 0, v as number);
          break;
        case "fill": {
          const [sel, text] = v as [string, string];
          await humanClick(page, sel);
          await page.fill(sel, "");
          await page.type(sel, text, { delay: randomInt(40, 120) });
          break;
        }
        case "press":
          await page.keyboard.press(v as string);
          break;
        case "evaluate":
          r.result = await page.evaluate(v as string);
          break;
        case "infinite_scroll":
          r.result = await infiniteScroll(page, (v as Record<string, unknown>) ?? {});
          break;
      }
    } catch (e) {
      r.ok = false;
      r.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      r.ms = Date.now() - t0;
      results.push(r);
      if (strict) throw new ScenarioError(r);
      continue;
    }
    r.ms = Date.now() - t0;
    results.push(r);
  }
  return results;
}

export class ScenarioError extends Error {
  constructor(public readonly step: ScenarioStepResult) {
    super(`js_scenario step ${step.step} (${step.instruction}) failed: ${step.error}`);
    this.name = "ScenarioError";
  }
}
