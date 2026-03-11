import test from "node:test";
import assert from "node:assert/strict";
import { isValidDemoLogin } from "./auth-utils.js";

test("accepts the configured demo credentials", () => {
  assert.equal(isValidDemoLogin("admin", "F5aidemo"), true);
});

test("rejects an invalid username", () => {
  assert.equal(isValidDemoLogin("wrong-user", "F5aidemo"), false);
});

test("rejects an invalid password", () => {
  assert.equal(isValidDemoLogin("admin", "wrong-pass"), false);
});

test("trims username before validation", () => {
  assert.equal(isValidDemoLogin("  admin  ", "F5aidemo"), true);
});
