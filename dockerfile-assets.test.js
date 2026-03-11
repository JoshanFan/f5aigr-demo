import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Dockerfile.frontend copies auth-utils.js", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile.frontend", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+auth-utils\.js\s+\./,
    "Dockerfile.frontend must copy auth-utils.js so app.js module imports resolve in the container",
  );
});

test("Dockerfile.frontend includes runtime prefill assets and entrypoint script", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile.frontend", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+runtime-config\.js\s+\./,
    "Dockerfile.frontend must copy runtime-config.js as frontend fallback config",
  );
  assert.match(
    dockerfile,
    /COPY\s+runtime-config\.js\.template\s+\./,
    "Dockerfile.frontend must copy runtime-config.js.template for env-based prefill injection",
  );
  assert.match(
    dockerfile,
    /COPY(?:\s+--chmod=755)?\s+docker-entrypoint\.d\/20-runtime-config\.sh\s+\/docker-entrypoint\.d\/20-runtime-config\.sh/,
    "Dockerfile.frontend must copy runtime-config entrypoint script",
  );
});

test("Dockerfile.nginx copies orchestrator.js and config template", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile.nginx", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+nginx\/orchestrator\.js\s+\/etc\/nginx\/njs\/orchestrator\.js/,
    "Dockerfile.nginx must copy njs orchestrator",
  );
  assert.match(
    dockerfile,
    /COPY\s+nginx\/default\.conf\.template\s+\/etc\/nginx\/templates\/default\.conf\.template/,
    "Dockerfile.nginx must copy nginx config template",
  );
});
