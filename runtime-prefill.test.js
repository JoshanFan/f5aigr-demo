import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("frontend loads runtime config before app module", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const runtimeIndex = html.indexOf('src="./runtime-config.js');
  const appIndex = html.indexOf('src="./app.js');

  assert.ok(runtimeIndex >= 0, "index.html must load runtime-config.js");
  assert.ok(appIndex >= 0, "index.html must load app.js");
  assert.ok(runtimeIndex < appIndex, "runtime-config.js must load before app.js");
});

test("app applies runtime prefill only when fields are empty", () => {
  const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(
    appJs,
    /window\.__F5_DEMO_PREFILL__/,
    "app.js must read runtime prefill config from window.__F5_DEMO_PREFILL__",
  );
  assert.match(
    appJs,
    /if\s*\(!dom\.projectId\.value\.trim\(\)\s*&&\s*typeof runtimePrefill\.projectId === "string"\)/,
    "projectId prefill should only apply when current field is empty",
  );
  assert.match(
    appJs,
    /if\s*\(!dom\.apiToken\.value\.trim\(\)\s*&&\s*typeof runtimePrefill\.apiToken === "string"\)/,
    "apiToken prefill should only apply when current field is empty",
  );
});

test("compose file exposes runtime prefill environment variables", () => {
  const compose = readFileSync(new URL("./docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /DEMO_PROJECT_ID:\s*\$\{DEMO_PROJECT_ID:-\}/, "Missing DEMO_PROJECT_ID passthrough");
  assert.match(compose, /DEMO_API_TOKEN:\s*\$\{DEMO_API_TOKEN:-\}/, "Missing DEMO_API_TOKEN passthrough");
});
