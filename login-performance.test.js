import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("login page particle count stays within performance budget", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const particleCount = (html.match(/class="space-particle"/g) || []).length;
  assert.ok(
    particleCount <= 8,
    `Expected <= 8 animated particles on login page, found ${particleCount}`,
  );
});

test("login background does not use continuous drift animation", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const loginBgRule = css.match(/\.login-mode\s+\.bg-grid\s*\{[\s\S]*?\}/);
  assert.ok(loginBgRule, "Missing .login-mode .bg-grid rule");
  assert.doesNotMatch(
    loginBgRule[0],
    /animation\s*:\s*spaceSkyDrift/i,
    "Login background should not run continuous drift animation",
  );
});
