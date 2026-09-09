// Google (Aug 2026) wraps every result link as google.com/goto?url=<encrypted>.
// The real URL is not in the page at all; the only way to get it is to ask
// Google's redirect, which answers 302 + Location. We do that with the browser
// context's own request client (same cookies/IP as the page), one at a time,
// with a short human-ish gap, and remember answers so repeats cost nothing.
import type { BrowserContext } from "playwright";
import { TtlLru } from "../cache.js";
import { randomInt, sleep } from "../humanize.js";
import { log } from "../logger.js";
import type { OrganicResult } from "../types.js";

const resolved = new TtlLru<string>(5000, 7 * 86_400_000);

async function resolveOne(context: BrowserContext, gotoUrl: string): Promise<string | null> {
  const hit = resolved.get(gotoUrl);
  if (hit) return hit;
  try {
    const resp = await context.request.get(gotoUrl, {
      maxRedirects: 0,
      timeout: 10_000,
      headers: { referer: "https://www.google.com/" },
    });
    const status = resp.status();
    const location = resp.headers()["location"];
    await resp.dispose();
    if (status >= 300 && status < 400 && location) {
      const real = new URL(location, "https://www.google.com/").href;
      resolved.set(gotoUrl, real);
      return real;
    }
    log.warn(`goto resolve: unexpected status ${status} for ${gotoUrl.slice(0, 80)}...`);
    return null;
  } catch (e) {
    log.warn(`goto resolve failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Replace result (and sitelink) URLs that are /goto redirects with their real destinations, in place. */
export async function resolveGotoLinks(context: BrowserContext, results: OrganicResult[]): Promise<{ resolved: number; failed: number }> {
  const targets: Array<{ obj: { url: string; gotoUrl?: string } }> = [];
  for (const r of results) {
    if (r.gotoUrl && r.url === r.gotoUrl) targets.push({ obj: r });
    for (const s of r.sitelinks ?? []) if (s.gotoUrl && s.url === s.gotoUrl) targets.push({ obj: s });
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const { obj } = targets[i];
    const real = await resolveOne(context, obj.gotoUrl!);
    if (real) {
      obj.url = real;
      ok++;
    } else {
      failed++;
    }
    // Don't fire ten redirects in the same instant.
    if (i < targets.length - 1 && !resolved.get(targets[i + 1].obj.gotoUrl!)) await sleep(randomInt(250, 800));
  }
  return { resolved: ok, failed };
}
