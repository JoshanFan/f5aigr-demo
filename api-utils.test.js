import test from "node:test";
import assert from "node:assert/strict";

import { buildApiUrl, buildNonJsonApiErrorMessage, extractApiErrorMessage } from "./api-utils.js";

test("buildApiUrl trims the configured base URL before appending endpoints", () => {
  assert.equal(
    buildApiUrl("/backend/v1/scans", {
      prefill: { apiBaseUrl: "https://demo.example.com/api/" },
      locationOrigin: "https://demo.example.com",
    }),
    "https://demo.example.com/api/backend/v1/scans",
  );
});

test("buildNonJsonApiErrorMessage points to API base URL or rewrite issues for html responses", () => {
  const message = buildNonJsonApiErrorMessage(404, "<html><body>404</body></html>", {
    url: "https://demo.example.com/api/backend/v1/scans",
    contentType: "text/html",
  });

  assert.match(message, /API_BASE_URL/);
  assert.match(message, /reverse-proxy rewrite/);
  assert.match(message, /https:\/\/demo\.example\.com\/api\/backend\/v1\/scans/);
});

test("extractApiErrorMessage includes the request URL for json API errors", () => {
  const message = extractApiErrorMessage(
    401,
    { detail: "invalid token" },
    JSON.stringify({ detail: "invalid token" }),
    { url: "https://demo.example.com/backend/v1/scans", contentType: "application/json" },
  );

  assert.equal(message, "API 401 from https://demo.example.com/backend/v1/scans: invalid token");
});
