import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("adversarial sample cards remove risk labels and include six scenarios", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const cardCount = (html.match(/data-scenario="/g) || []).length;

  assert.equal(cardCount, 6, `Expected 6 scenario cards, found ${cardCount}`);
  assert.doesNotMatch(
    html,
    /\b(Low|Medium|High)\s+Risk\b/i,
    "Scenario cards should not display risk labels",
  );
  assert.match(
    html,
    /preset 1-6/i,
    "Prompt placeholder should mention presets 1-6",
  );
});

test("scenario prompts and keyboard selection support new adversarial plan", () => {
  const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  assert.match(appJs, /"6":\s*\{\s*prompt:/, "Expected scenarios to include key \"6\"");
  assert.match(appJs, /奶奶/, "Missing grandma attack sample prompt");
  assert.match(
    appJs,
    /忽略.*先前|提示注入|系統提示|安全規則/,
    "Prompt injection sample should be written in Traditional Chinese",
  );
  assert.match(appJs, /台灣|臺灣|手機號碼|號碼格式|範例/, "Missing Taiwan phone masking sample prompt");
  assert.match(appJs, /投資|股票|定存/, "Missing finance topic sample prompt");
  assert.match(appJs, /台灣.*中國|中國.*台灣|臺灣.*中國|中國.*臺灣|政治/, "Missing Taiwan-China political sample prompt");

  const scenario2Match = appJs.match(/"2":\s*\{\s*prompt:\s*"([^"]+)"/);
  assert.ok(scenario2Match, "Expected scenario 2 prompt definition");
  assert.doesNotMatch(
    scenario2Match[1],
    /金融|銀行|交易|OTP|券商|套利/,
    "Grandma attack sample should not contain finance-related wording",
  );

  assert.match(
    appJs,
    /Object\.prototype\.hasOwnProperty\.call\(scenarios,\s*event\.key\)/,
    "Preset keyboard handler should map keys from scenarios dynamically",
  );
});

test("scenario cards define distinct colors for data-scenario 1-6", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  for (const id of ["1", "2", "3", "4", "5", "6"]) {
    assert.match(
      css,
      new RegExp(`\\.scenario-card\\[data-scenario=\\"${id}\\"\\]\\s*\\{`),
      `Missing color rule for scenario ${id}`,
    );
  }
});
