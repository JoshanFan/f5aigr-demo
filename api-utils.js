function trimTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/, "");
}

function looksLikeHtml(rawText) {
  const text = String(rawText || "").trim().toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html") || (text.includes("<head") && text.includes("<body"));
}

export function resolveApiBaseUrl({ prefill, locationOrigin } = {}) {
  const runtimePrefill =
    prefill ?? (typeof window !== "undefined" && typeof window.__F5_DEMO_PREFILL__ === "object" ? window.__F5_DEMO_PREFILL__ : null);
  const origin =
    locationOrigin ?? (typeof window !== "undefined" && window.location ? window.location.origin : "");
  const configuredBase = runtimePrefill && typeof runtimePrefill.apiBaseUrl === "string" ? runtimePrefill.apiBaseUrl.trim() : "";
  const base = configuredBase || (origin ? `${origin}/api` : "/api");
  return trimTrailingSlashes(base);
}

export function buildApiUrl(endpoint, options) {
  const normalizedEndpoint = String(endpoint || "").startsWith("/") ? String(endpoint || "") : `/${String(endpoint || "")}`;
  return `${resolveApiBaseUrl(options)}${normalizedEndpoint}`;
}

export function buildNonJsonApiErrorMessage(status, rawText, { url = "", contentType = "" } = {}) {
  const target = url ? ` from ${url}` : "";
  const isHtmlResponse = String(contentType || "").toLowerCase().includes("text/html") || looksLikeHtml(rawText);

  if (isHtmlResponse && url.includes("/api/")) {
    return `API ${status}${target} returned HTML instead of JSON. Check API_BASE_URL or the /api reverse-proxy rewrite.`;
  }

  if (isHtmlResponse) {
    return `API ${status}${target} returned HTML instead of JSON. The request likely hit the frontend/static server instead of the API proxy.`;
  }

  return `API ${status}${target} returned a non-JSON response.`;
}

export function extractApiErrorMessage(status, payload, rawText, { url = "", contentType = "" } = {}) {
  const target = url ? ` from ${url}` : "";

  if (payload && typeof payload === "object") {
    const detail =
      payload.message ||
      payload.detail ||
      payload.error?.message ||
      payload.error ||
      payload.result?.message;
    if (typeof detail === "string" && detail.trim()) {
      return `API ${status}${target}: ${detail.trim()}`;
    }
  }

  if (String(contentType || "").toLowerCase().includes("text/html") || looksLikeHtml(rawText)) {
    return buildNonJsonApiErrorMessage(status, rawText, { url, contentType });
  }

  const fallback = typeof rawText === "string" ? rawText.trim() : "";
  if (fallback) {
    return `API ${status}${target}: ${fallback.slice(0, 240)}`;
  }

  return `API request failed (${status}).`;
}
