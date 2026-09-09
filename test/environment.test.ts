import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseStrategies, type Environment } from "../src/environment.js";

const base: Environment = { platform: "linux", arch: "x64", isRoot: false, overSsh: true, hasDisplay: false, display: null, chromePath: null, chromiumPath: null, xvfbPath: null, notes: [] };
const names = (e: Environment, mode?: Parameters<typeof chooseStrategies>[1]) => chooseStrategies(e, mode).map((s) => s.name);

test("mac with a GUI and Chrome: real window first, headless Chrome as fallback", () => {
  assert.deepEqual(names({ ...base, platform: "darwin", arch: "arm64", hasDisplay: true, chromePath: "/Applications/Google Chrome.app/x", chromiumPath: "/pw/chromium" }), [
    "headful-chrome",
    "headless-chrome",
    "headful-chromium",
    "headless-chromium",
  ]);
});

test("linux server, no monitor, Chrome + Xvfb installed: auto-Xvfb wins", () => {
  assert.deepEqual(names({ ...base, chromePath: "/opt/google/chrome/chrome", xvfbPath: "/usr/bin/Xvfb" }), ["xvfb-chrome", "headless-chrome"]);
});

test("linux server, no monitor, Chrome but no Xvfb: new headless Chrome", () => {
  assert.deepEqual(names({ ...base, chromePath: "/opt/google/chrome/chrome" }), ["headless-chrome"]);
});

test("linux with $DISPLAY (desktop or systemd Xvfb): real window", () => {
  assert.equal(names({ ...base, hasDisplay: true, display: ":99", chromePath: "/opt/google/chrome/chrome", xvfbPath: "/usr/bin/Xvfb" })[0], "headful-chrome");
});

test("ARM linux with only Playwright Chromium: worst rung, flagged", () => {
  const s = chooseStrategies({ ...base, arch: "arm64", chromiumPath: "/pw/chromium" });
  assert.deepEqual(s.map((x) => x.name), ["headless-chromium"]);
  assert.equal(s[0].quality, "worst");
  assert.equal(s[0].stealth, true);
});

test("mac over ssh with nobody logged in: skips the window", () => {
  assert.deepEqual(names({ ...base, platform: "darwin", hasDisplay: false, chromePath: "/Applications/Google Chrome.app/x" }), ["headless-chrome"]);
});

test("forced mode returns only that rung, or nothing if impossible", () => {
  const e = { ...base, chromePath: "/opt/google/chrome/chrome", xvfbPath: "/usr/bin/Xvfb" };
  assert.deepEqual(names(e, "headless-chrome"), ["headless-chrome"]);
  assert.deepEqual(names(e, "headful-chrome"), []);
});

test("nothing installed: empty ladder", () => {
  assert.deepEqual(names(base), []);
});
