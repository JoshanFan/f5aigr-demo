import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Dockerfile copies auth-utils.js into nginx static directory", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+auth-utils\.js\s+\/usr\/share\/nginx\/html\/?/,
    "Dockerfile must copy auth-utils.js so app.js module imports resolve in the container",
  );
});

test("Dockerfile includes runtime prefill assets and entrypoint script", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+runtime-config\.js\s+\/usr\/share\/nginx\/html\/?/,
    "Dockerfile must copy runtime-config.js as frontend fallback config",
  );
  assert.match(
    dockerfile,
    /COPY\s+runtime-config\.js\.template\s+\/usr\/share\/nginx\/html\/?/,
    "Dockerfile must copy runtime-config.js.template for env-based prefill injection",
  );
  assert.match(
    dockerfile,
    /COPY(?:\s+--chmod=755)?\s+docker-entrypoint\.d\/20-runtime-config\.sh\s+\/docker-entrypoint\.d\/20-runtime-config\.sh/,
    "Dockerfile must copy runtime-config entrypoint script",
  );
});
