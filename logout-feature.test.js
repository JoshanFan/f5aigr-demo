import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("app shell includes a logout button", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<button[^>]*id="logoutBtn"[^>]*>/,
    "Expected a logout button with id=\"logoutBtn\" in index.html",
  );
});

test("app script clears auth session and wires logout click handler", () => {
  const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  assert.match(
    appJs,
    /sessionStorage\.removeItem\(AUTH_STORAGE_KEY\)/,
    "Expected logout flow to clear AUTH_STORAGE_KEY from sessionStorage",
  );
  assert.match(
    appJs,
    /logoutBtn:\s*document\.getElementById\("logoutBtn"\)/,
    "Expected dom mapping for logoutBtn",
  );
  assert.match(
    appJs,
    /logoutBtn\.addEventListener\("click",\s*handleLogoutClick\)/,
    "Expected click handler binding for logout button",
  );
});
