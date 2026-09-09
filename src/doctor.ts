// Prints what the machine can do and which browser setup will be used.
//   npm run doctor            detection only
//   npm run doctor -- --launch   also launch the browser once and report what Google would see
import "dotenv/config";
import { chromium } from "playwright";
import { browserState, closeBrowser, getContext, initBrowser, withPage } from "./browser.js";
import { loadConfig } from "./config.js";
import { chooseStrategies, describeEnvironment, detectEnvironment } from "./environment.js";
import { logToStderr } from "./logger.js";

logToStderr();
if (!process.env.API_KEY) process.env.API_KEY = "doctor";
const cfg = loadConfig();
const env = detectEnvironment({ chromiumPath: chromium.executablePath() });
console.log("Environment : " + describeEnvironment(env));
for (const n of env.notes) console.log("  note      : " + n);
const ladder = chooseStrategies(env, cfg.browserMode);
console.log(`Browser mode: ${cfg.browserMode}`);
if (ladder.length === 0) {
  console.log("No usable browser setup. Install Google Chrome (and Xvfb on a headless Linux box).");
  process.exit(1);
}
ladder.forEach((s, i) => console.log(`  ${i === 0 ? "->" : "  "} ${s.name.padEnd(18)} [${s.quality}] ${s.note}`));

if (process.argv.includes("--launch")) {
  initBrowser(cfg);
  try {
    await getContext();
    const st = browserState();
    console.log(`\nLaunched with : ${st.strategy} (${st.quality})`);
    const info = await withPage(
      async (page) => {
        await page.goto("about:blank");
        return page.evaluate(() => ({
          userAgent: navigator.userAgent,
          webdriver: navigator.webdriver,
          platform: (navigator as any).userAgentData?.platform,
          inner: [innerWidth, innerHeight],
          outer: [outerWidth, outerHeight],
          screen: [screen.width, screen.height],
          webgl: (() => {
            try {
              const c = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
              const d = c?.getExtension("WEBGL_debug_renderer_info");
              return c && d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
            } catch {
              return null;
            }
          })(),
        }));
      },
      { timeoutMs: 20_000, label: "doctor" },
    );
    console.log(JSON.stringify(info, null, 2));
    if (/HeadlessChrome/.test(info.userAgent)) console.log("WARNING: user agent says HeadlessChrome; Google will block this.");
    if (info.webdriver) console.log("WARNING: navigator.webdriver is true.");
  } finally {
    await closeBrowser();
  }
}
process.exit(0);
