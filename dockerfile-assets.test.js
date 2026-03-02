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
