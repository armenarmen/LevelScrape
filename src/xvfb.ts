// Start a virtual X screen so real Chrome can run "headful" on a server with no monitor.
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { log } from "./logger.js";
import { sleep } from "./humanize.js";

let proc: ChildProcess | null = null;
let display: string | null = null;

function freeDisplay(): number {
  for (let n = 99; n < 199; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  throw new Error("no free X display number between :99 and :198");
}

export async function startXvfb(xvfbPath: string, width: number, height: number): Promise<string> {
  if (display) return display;
  const n = freeDisplay();
  const d = `:${n}`;
  proc = spawn(xvfbPath, [d, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (b) => (stderr += String(b)));
  proc.on("exit", (code) => {
    if (display) log.warn(`Xvfb ${d} exited (code ${code})${stderr ? ": " + stderr.trim().slice(0, 200) : ""}`);
    display = null;
    proc = null;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(`/tmp/.X11-unix/X${n}`)) {
      display = d;
      process.env.DISPLAY = d;
      log.info(`Xvfb started on ${d} (${width}x${height}x24)`);
      return d;
    }
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  proc.kill();
  proc = null;
  throw new Error(`Xvfb failed to start: ${stderr.trim().slice(0, 300) || "no socket appeared"}`);
}

export function stopXvfb(): void {
  if (proc) {
    display = null;
    proc.kill("SIGTERM");
    proc = null;
  }
}

export function xvfbDisplay(): string | null {
  return display;
}
