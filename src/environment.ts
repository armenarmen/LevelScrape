// Figure out what kind of machine we're on and which browser setups are possible,
// best first. The ladder matters: Google detects headless Chromium instantly, so we
// only fall that far when nothing better exists.
import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

export interface Environment {
  platform: NodeJS.Platform;
  arch: string;
  isRoot: boolean;
  overSsh: boolean;
  hasDisplay: boolean;        // a GUI we could open a window on (macOS/Windows console session, or $DISPLAY on Linux)
  display: string | null;
  chromePath: string | null;  // real Google Chrome
  chromiumPath: string | null;// Playwright's bundled Chromium
  xvfbPath: string | null;
  notes: string[];
}

export type StrategyName = "headful-chrome" | "xvfb-chrome" | "headless-chrome" | "headful-chromium" | "xvfb-chromium" | "headless-chromium";
export type BrowserMode = "auto" | StrategyName;

export interface Strategy {
  name: StrategyName;
  executablePath?: string;
  channel?: "chromium";
  headless: boolean;
  needsXvfb: boolean;
  stealth: boolean;            // inject the anti-detection script (only worth it on Chromium)
  quality: "best" | "good" | "poor" | "worst";
  note: string;
}

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")],
  linux: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/google-chrome"],
  win32: [
    join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ],
};

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function macConsoleUser(): string | null {
  try {
    return execSync("stat -f %Su /dev/console", { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

export function detectEnvironment(opts: { chromiumPath?: string | null; env?: NodeJS.ProcessEnv } = {}): Environment {
  const env = opts.env ?? process.env;
  const platform = process.platform;
  const notes: string[] = [];

  let chromePath: string | null = null;
  if (env.CHROME_EXECUTABLE) {
    if (existsSync(env.CHROME_EXECUTABLE)) chromePath = env.CHROME_EXECUTABLE;
    else notes.push(`CHROME_EXECUTABLE=${env.CHROME_EXECUTABLE} does not exist; ignoring`);
  }
  if (!chromePath) chromePath = (CHROME_CANDIDATES[platform] ?? []).find((p) => p && existsSync(p)) ?? null;
  if (!chromePath && platform === "linux" && process.arch !== "x64") notes.push("Google does not ship Chrome for ARM Linux; only Playwright's Chromium is possible here");

  const chromiumPath = opts.chromiumPath && existsSync(opts.chromiumPath) ? opts.chromiumPath : null;

  let hasDisplay = false;
  let display: string | null = null;
  if (platform === "darwin") {
    const u = macConsoleUser();
    hasDisplay = !!u && u !== "root" && u !== "_windowserver" && u !== "loginwindow";
    if (!hasDisplay) notes.push(`no macOS GUI session (console user: ${u ?? "unknown"}); a window cannot be opened`);
  } else if (platform === "win32") {
    hasDisplay = true;
  } else {
    display = env.DISPLAY ?? null;
    hasDisplay = !!display;
  }

  const xvfbPath = platform === "linux" ? which("Xvfb") : null;

  return {
    platform,
    arch: process.arch,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    overSsh: !!(env.SSH_CONNECTION || env.SSH_TTY),
    hasDisplay,
    display,
    chromePath,
    chromiumPath,
    xvfbPath,
    notes,
  };
}

/** Ordered list of things to try. The first that launches wins. */
export function chooseStrategies(e: Environment, mode: BrowserMode = "auto"): Strategy[] {
  const all: Strategy[] = [];
  if (e.chromePath) {
    if (e.hasDisplay) all.push({ name: "headful-chrome", executablePath: e.chromePath, headless: false, needsXvfb: false, stealth: false, quality: "best", note: "real Chrome in a real window" });
    if (e.platform === "linux" && e.xvfbPath) all.push({ name: "xvfb-chrome", executablePath: e.chromePath, headless: false, needsXvfb: true, stealth: false, quality: "best", note: "real Chrome drawing into an auto-started Xvfb virtual screen" });
    all.push({ name: "headless-chrome", executablePath: e.chromePath, headless: true, needsXvfb: false, stealth: false, quality: "good", note: "real Chrome in its new headless mode (same rendering as headful, no window). Expect somewhat more captchas." });
  }
  if (e.chromiumPath) {
    if (e.hasDisplay) all.push({ name: "headful-chromium", channel: "chromium", headless: false, needsXvfb: false, stealth: true, quality: "poor", note: "Playwright's Chromium in a window, with anti-detection script. Google blocks this often; install Google Chrome." });
    if (e.platform === "linux" && e.xvfbPath) all.push({ name: "xvfb-chromium", channel: "chromium", headless: false, needsXvfb: true, stealth: true, quality: "poor", note: "Playwright's Chromium on Xvfb, with anti-detection script. Install Google Chrome for real results." });
    all.push({ name: "headless-chromium", channel: "chromium", headless: true, needsXvfb: false, stealth: true, quality: "worst", note: "Headless Playwright Chromium. This is the setup Google detects instantly; /fetch will mostly work, /search mostly won't." });
  }
  if (mode === "auto") return all;
  const forced = all.find((s) => s.name === mode);
  if (forced) return [forced];
  // The user forced something the machine can't do; explain instead of silently doing something else.
  return [];
}

export function describeEnvironment(e: Environment): string {
  const parts = [
    `${e.platform} ${e.arch}${e.isRoot ? " (root)" : ""}${e.overSsh ? " over ssh" : ""}`,
    e.hasDisplay ? `display: ${e.display ?? "gui session"}` : "no display",
    e.chromePath ? `Chrome: ${e.chromePath}` : "Chrome: not found",
    e.chromiumPath ? "Playwright Chromium: available" : "Playwright Chromium: not installed",
    e.platform === "linux" ? (e.xvfbPath ? "Xvfb: available" : "Xvfb: not installed") : null,
  ].filter(Boolean);
  return parts.join(" | ");
}
