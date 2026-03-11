var OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
var GUARDRAIL_TIMEOUT_MS = 25000;
var LLM_TIMEOUT_MS = 35000;

function withTimeout(promise, timeoutMs, label) {
  var timerId;
  var timeoutPromise = new Promise(function (_resolve, reject) {
    timerId = setTimeout(function () {
      reject(new Error(label + " timeout after " + timeoutMs + "ms"));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(function () {
    if (timerId) {
      clearTimeout(timerId);
    }
  });
}

function buildGuardrailScanUrl(upstream) {
  var base = String(upstream || "").trim().replace(/\/+$/, "");
  if (!base) {
    return "/backend/v1/scans";
  }

  if (/\/backend$/i.test(base)) {
    return base + "/v1/scans";
  }

  return base + "/backend/v1/scans";
}

function buildGuardrailPromptUrl(upstream) {
  var base = String(upstream || "").trim().replace(/\/+$/, "");
  if (!base) {
    return "/backend/v1/prompts";
  }

  if (/\/backend$/i.test(base)) {
    return base + "/v1/prompts";
  }

  return base + "/backend/v1/prompts";
}

function sendSSE(r, data) {
  r.send("event: stage\ndata: " + JSON.stringify(data) + "\n\n");
}

function emitStage(r, stage, data) {
  var payload = { stage: stage, ts: Date.now() };
  if (data && typeof data === "object") {
    for (var key in data) {
      payload[key] = data[key];
    }
  }
  sendSSE(r, payload);
}

function applyCorsHeaders(r) {
  var corsOrigin =
    r &&
    r.variables &&
    typeof r.variables.cors_origin === "string"
      ? r.variables.cors_origin
      : "";

  if (!corsOrigin) {
    return;
  }

  r.headersOut["Access-Control-Allow-Origin"] = corsOrigin;
  r.headersOut["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  r.headersOut["Access-Control-Allow-Headers"] = "Content-Type, Authorization";

  var varyHeader = String(r.headersOut["Vary"] || "");
  if (!varyHeader) {
    r.headersOut["Vary"] = "Origin";
  } else if (varyHeader.indexOf("Origin") === -1) {
    r.headersOut["Vary"] = varyHeader + ", Origin";
  }
}

function initSSE(r) {
  applyCorsHeaders(r);
  r.headersOut["Content-Type"] = "text/event-stream";
  r.headersOut["Cache-Control"] = "no-cache";
  r.headersOut["Connection"] = "keep-alive";
  r.headersOut["X-Accel-Buffering"] = "no";
  r.status = 200;
  r.sendHeader();
  // Send an SSE comment frame immediately so clients can receive early bytes.
  r.send(": connected\n\n");
}

function isBlocked(guardrailPayload) {
  var result =
    guardrailPayload && typeof guardrailPayload === "object"
      ? guardrailPayload.result || {}
      : {};
  var outcome = String(result.outcome || "").trim().toLowerCase();
  var blocked = ["blocked", "block", "failed", "deny", "denied", "rejected"];
  for (var i = 0; i < blocked.length; i++) {
    if (outcome === blocked[i]) return true;
  }
  return false;
}

function isReviewOutcome(guardrailPayload) {
  var result =
    guardrailPayload && typeof guardrailPayload === "object"
      ? guardrailPayload.result || {}
      : {};
  var outcome = String(result.outcome || "").trim().toLowerCase();
  var review = ["review", "warning", "warn", "flagged", "caution"];
  for (var i = 0; i < review.length; i++) {
    if (outcome === review[i]) return true;
  }
  return false;
}

function shouldStopOobOnGuardrailOutcome(guardrailPayload, strictMode) {
  if (!strictMode) {
    return false;
  }
  return isBlocked(guardrailPayload) || isReviewOutcome(guardrailPayload);
}

function parseBody(r) {
  try {
    var raw = r.requestText || r.requestBody || "";
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Use ngx.fetch() with resolver ipv6=off to avoid IPv6 failures in Docker
async function calypsoSubrequest(r, path, token, body, label) {
  var base = String(r.variables.guardrails_upstream || "https://us1.calypsoai.app").replace(/\/+$/, "");
  var urlMap = {
    "/_internal/calypso_prompts": base + "/backend/v1/prompts",
    "/_internal/calypso_scans": base + "/backend/v1/scans",
  };
  var url = urlMap[path];
  if (!url) {
    throw new Error(label + " unknown path: " + path);
  }

  var res = await withTimeout(
    ngx.fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body,
    }),
    GUARDRAIL_TIMEOUT_MS,
    label
  );

  if (res.status >= 400) {
    var text = await res.text();
    throw new Error(label + " failed (" + res.status + "): " + text.substring(0, 200));
  }

  return await withTimeout(res.json(), 5000, label + " parse");
}

async function callGuardrailProxy(r, token, project, input) {
  var body = JSON.stringify({ project: project, input: input, verbose: true });
  return calypsoSubrequest(r, "/_internal/calypso_scans", token, body, "Guardrail pre-scan");
}

async function callPromptProxy(r, token, project, input) {
  var body = JSON.stringify({ project: project, input: input, verbose: true });
  return calypsoSubrequest(r, "/_internal/calypso_prompts", token, body, "Guardrail prompt");
}

// Legacy ngx.fetch versions (used for OpenRouter LLM calls which don't need keepalive)
async function callGuardrail(upstream, token, project, input) {
  var url = buildGuardrailScanUrl(upstream);
  var res = await withTimeout(ngx.fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: project, input: input, verbose: true }),
  }), GUARDRAIL_TIMEOUT_MS, "Guardrail pre-scan");
  return await withTimeout(res.json(), 5000, "Guardrail pre-scan parse");
}

async function callPrompt(upstream, token, project, input) {
  var url = buildGuardrailPromptUrl(upstream);
  var res = await withTimeout(ngx.fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: project, input: input, verbose: true }),
  }), GUARDRAIL_TIMEOUT_MS, "Guardrail prompt");
  return await withTimeout(res.json(), 5000, "Guardrail prompt parse");
}

function getPromptResponseContent(promptPayload) {
  var result =
    promptPayload && typeof promptPayload === "object"
      ? promptPayload.result || {}
      : {};

  if (typeof result.response === "string") {
    return result.response;
  }

  if (result.providerResults && typeof result.providerResults === "object") {
    var keys = Object.keys(result.providerResults);
    if (keys.length > 0) {
      var providerResult = result.providerResults[keys[0]];
      if (providerResult && typeof providerResult.data === "string") {
        return providerResult.data;
      }
    }
  }

  return "";
}

function tryParseJsonModel(raw) {
  if (typeof raw !== "string" || !raw) {
    return "";
  }

  try {
    var parsed = JSON.parse(raw);
    return extractModelFromObject(parsed);
  } catch (_e) {
    return "";
  }
}

function extractModelFromObject(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (typeof value.model === "string" && value.model) {
    return value.model;
  }
  if (typeof value.modelName === "string" && value.modelName) {
    return value.modelName;
  }
  if (typeof value.providerModel === "string" && value.providerModel) {
    return value.providerModel;
  }

  if (value.metadata && typeof value.metadata === "object") {
    var fromMetadata = extractModelFromObject(value.metadata);
    if (fromMetadata) {
      return fromMetadata;
    }
  }

  if (value.response && typeof value.response === "object") {
    var fromResponse = extractModelFromObject(value.response);
    if (fromResponse) {
      return fromResponse;
    }
  }

  if (value.data && typeof value.data === "object") {
    var fromData = extractModelFromObject(value.data);
    if (fromData) {
      return fromData;
    }
  }

  if (typeof value.data === "string") {
    var fromDataJson = tryParseJsonModel(value.data);
    if (fromDataJson) {
      return fromDataJson;
    }
  }

  return "";
}

function getPromptResponseModel(promptPayload, fallbackModel) {
  var result =
    promptPayload && typeof promptPayload === "object"
      ? promptPayload.result || {}
      : {};

  var model = extractModelFromObject(result.providerResult);
  if (model) {
    return model;
  }

  if (result.providerResults && typeof result.providerResults === "object") {
    var keys = Object.keys(result.providerResults);
    for (var i = 0; i < keys.length; i++) {
      model = extractModelFromObject(result.providerResults[keys[i]]);
      if (model) {
        return model;
      }
    }
  }

  if (result.files && Array.isArray(result.files)) {
    for (var j = 0; j < result.files.length; j++) {
      model = extractModelFromObject(result.files[j]);
      if (model) {
        return model;
      }
    }
  }

  model = extractModelFromObject(result);
  if (model) {
    return model;
  }

  return fallbackModel || "";
}

function getLLMResponseModel(llmPayload, fallbackModel) {
  var model = extractModelFromObject(llmPayload);
  if (model) {
    return model;
  }
  return fallbackModel || "";
}

async function callLLM(apiKey, model, userInput) {
  var res = await withTimeout(ngx.fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "user", content: userInput }],
    }),
  }), LLM_TIMEOUT_MS, "LLM inference");
  return await withTimeout(res.json(), 5000, "LLM response parse");
}

async function oobChat(r) {
  initSSE(r);

  var body = parseBody(r);
  if (!body) {
    emitStage(r, "error", { message: "Invalid JSON body" });
    r.finish();
    return;
  }

  var upstream = r.variables.guardrails_upstream;
  var strictGate = body.oobStrictGuardrailGate !== false;

  try {
    // 1. Guardrail pre-scan
    emitStage(r, "guardrail_start");
    var guardrail = await callGuardrailProxy(
      r,
      body.guardrailToken,
      body.project,
      body.input
    );
    emitStage(r, "guardrail_result", { guardrail: guardrail });

    // 2. Stop OOB flow unless Guardrails explicitly clears the request.
    if (shouldStopOobOnGuardrailOutcome(guardrail, strictGate)) {
      emitStage(r, "blocked", {
        reason: isReviewOutcome(guardrail) ? "pre-scan review required" : "pre-scan blocked",
      });
      emitStage(r, "done");
      r.finish();
      return;
    }

    // 3. LLM call
    emitStage(r, "llm_start", { model: body.model });
    var llm = await callLLM(body.openrouterKey, body.model, body.input);
    var content =
      llm.choices &&
      llm.choices[0] &&
      llm.choices[0].message &&
      llm.choices[0].message.content
        ? llm.choices[0].message.content
        : "";
    var llmModel = getLLMResponseModel(llm, body.model);
    emitStage(r, "llm_response", { llm: { model: llmModel, content: content } });

    // 4. Done
    emitStage(r, "done");
  } catch (e) {
    emitStage(r, "error", { message: String(e.message || e) });
  }

  r.finish();
}

async function inlineChat(r) {
  initSSE(r);

  var body = parseBody(r);
  if (!body) {
    emitStage(r, "error", { message: "Invalid JSON body" });
    r.finish();
    return;
  }

  try {
    // 1. Start guardrail phase
    emitStage(r, "guardrail_start");
    emitStage(r, "inline_dispatch", { model: body.model });
    emitStage(r, "inline_waiting");

    // Clear previous signals
    ngx.shared.llm_signals.delete("start");
    ngx.shared.llm_signals.delete("end");

    // Fire Guardrails subrequest (returns Promise)
    var guardrailPromise = callPromptProxy(
      r,
      body.guardrailToken,
      body.project,
      body.input
    ).then(function (res) {
      return { type: "done", value: res };
    });

    var promptResult = null;
    var llmStartEmitted = false;
    var llmEndEmitted = false;

    // Poll loop: check shared dict every 200ms while waiting for Guardrails
    while (!promptResult) {
      var raced = await Promise.race([
        guardrailPromise,
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve({ type: "tick" });
          }, 200);
        }),
      ]);

      if (raced.type === "done") {
        promptResult = raced.value;
      } else {
        // Check for LLM proxy start signal from shared dict
        if (!llmStartEmitted) {
          var startTs = ngx.shared.llm_signals.get("start");
          if (startTs) {
            emitStage(r, "llm_proxy_start", { ts: parseInt(startTs) });
            llmStartEmitted = true;
          }
        }
        // Check for LLM proxy end signal from shared dict
        if (llmStartEmitted && !llmEndEmitted) {
          var endTs = ngx.shared.llm_signals.get("end");
          if (endTs) {
            emitStage(r, "llm_proxy_done", { ts: parseInt(endTs) });
            llmEndEmitted = true;
          }
        }
      }
    }

    // 2. Guardrails returned — check blocked FIRST
    var blocked = isBlocked(promptResult);

    // For non-blocked: emit any signals that arrived but weren't caught in loop
    if (!blocked) {
      if (!llmStartEmitted) {
        var finalStart = ngx.shared.llm_signals.get("start");
        if (finalStart) {
          emitStage(r, "llm_proxy_start", { ts: parseInt(finalStart) });
          llmStartEmitted = true;
        }
      }
      if (!llmEndEmitted) {
        var finalEnd = ngx.shared.llm_signals.get("end");
        if (finalEnd) {
          emitStage(r, "llm_proxy_done", { ts: parseInt(finalEnd) });
          llmEndEmitted = true;
        }
      }
    }

    emitStage(r, "guardrail_result", { guardrail: promptResult });

    // 3. Blocked — return immediately, no LLM steps shown
    if (blocked) {
      emitStage(r, "blocked", { reason: "pre-scan blocked" });
      emitStage(r, "done");
      r.finish();
      return;
    }

    // 4. Extract LLM response from prompt result
    var content = getPromptResponseContent(promptResult);
    var resolvedModel = getPromptResponseModel(promptResult, body.model);
    emitStage(r, "llm_response", {
      llm: { model: resolvedModel, content: content },
    });

    // 5. Done
    emitStage(r, "done");
  } catch (e) {
    emitStage(r, "error", { message: String(e.message || e) });
  }

  r.finish();
}

async function llmProxy(r) {
  applyCorsHeaders(r);

  var auth = r.headersIn["Authorization"] || "";
  if (!auth) {
    r.headersOut["Content-Type"] = "application/json";
    r.return(401, JSON.stringify({ error: "missing authorization" }));
    return;
  }

  // Signal SSE handler: LLM request arrived
  ngx.shared.llm_signals.set("start", String(Date.now()));

  try {
    var res = await withTimeout(
      ngx.fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: r.requestText,
      }),
      LLM_TIMEOUT_MS,
      "LLM proxy"
    );

    // Signal SSE handler: LLM response received
    ngx.shared.llm_signals.set("end", String(Date.now()));

    var responseText = await withTimeout(res.text(), 5000, "LLM proxy read");
    r.headersOut["Content-Type"] = "application/json";
    r.return(res.status, responseText);
  } catch (e) {
    ngx.shared.llm_signals.set("end", String(Date.now()));
    r.headersOut["Content-Type"] = "application/json";
    r.return(502, JSON.stringify({ error: String(e.message || e) }));
  }
}

export default {
  applyCorsHeaders,
  inlineChat,
  oobChat,
  llmProxy,
  buildGuardrailScanUrl,
  buildGuardrailPromptUrl,
  getPromptResponseModel,
  getLLMResponseModel,
  isBlocked,
  isReviewOutcome,
  shouldStopOobOnGuardrailOutcome,
};
