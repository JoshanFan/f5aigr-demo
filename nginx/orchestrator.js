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

function initSSE(r) {
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

function parseBody(r) {
  try {
    var raw = r.requestText || r.requestBody || "";
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Use r.subrequest via NGINX static proxy locations (upstream keepalive + SSL session reuse)
// No per-request DNS resolution — resolved once at startup
async function calypsoSubrequest(r, path, token, body, label) {
  r.variables.calypso_auth = "Bearer " + token;

  var reply = await withTimeout(
    r.subrequest(path, {
      method: "POST",
      body: body,
    }),
    GUARDRAIL_TIMEOUT_MS,
    label
  );

  if (reply.status >= 400) {
    throw new Error(label + " failed (" + reply.status + "): " + String(reply.responseText || "").substring(0, 200));
  }

  return JSON.parse(reply.responseText);
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

    // 2. Check blocked
    if (isBlocked(guardrail)) {
      emitStage(r, "blocked", { reason: "pre-scan blocked" });
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

  var upstream = r.variables.guardrails_upstream;

  try {
    // 1. Prompt + inline guardrails via Calypso Prompts API
    emitStage(r, "guardrail_start");
    emitStage(r, "inline_dispatch", { model: body.model });
    emitStage(r, "inline_waiting");
    var promptResult = await callPromptProxy(
      r,
      body.guardrailToken,
      body.project,
      body.input
    );
    emitStage(r, "guardrail_result", { guardrail: promptResult });

    // 2. Check blocked
    if (isBlocked(promptResult)) {
      emitStage(r, "blocked", { reason: "pre-scan blocked" });
      emitStage(r, "done");
      r.finish();
      return;
    }

    // 3. LLM response already included in prompt result
    var content = getPromptResponseContent(promptResult);
    var resolvedModel = getPromptResponseModel(promptResult, body.model);
    emitStage(r, "llm_response", { llm: { model: resolvedModel, content: content } });

    // 4. Done
    emitStage(r, "done");
  } catch (e) {
    emitStage(r, "error", { message: String(e.message || e) });
  }

  r.finish();
}

export default {
  inlineChat,
  oobChat,
  buildGuardrailScanUrl,
  buildGuardrailPromptUrl,
  getPromptResponseModel,
  getLLMResponseModel,
};
