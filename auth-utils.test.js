import test from "node:test";
import assert from "node:assert/strict";
import { isValidDemoLogin } from "./auth-utils.js";

test("accepts the configured demo credentials", () => {
  assert.equal(isValidDemoLogin("joshan", "F%AIP@ssw0rd"), true);
});

test("rejects an invalid username", () => {
  assert.equal(isValidDemoLogin("wrong-user", "F%AIP@ssw0rd"), false);
});

test("rejects an invalid password", () => {
  assert.equal(isValidDemoLogin("joshan", "wrong-pass"), false);
});

test("trims username before validation", () => {
  assert.equal(isValidDemoLogin("  joshan  ", "F%AIP@ssw0rd"), true);
});
