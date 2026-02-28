var OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function sendSSE(r, data) {
  r.sendBuffer("event: stage\ndata: " + JSON.stringify(data) + "\n\n", {
    last: false,
  });
}

function endSSE(r) {
  r.sendBuffer("", { last: true });
}

function initSSE(r) {
  r.headersOut["Content-Type"] = "text/event-stream";
  r.headersOut["Cache-Control"] = "no-cache";
  r.headersOut["Connection"] = "keep-alive";
  r.headersOut["X-Accel-Buffering"] = "no";
  r.status = 200;
  r.sendHeader();
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
    return JSON.parse(r.requestBody);
  } catch (e) {
    return null;
  }
}

async function callGuardrail(upstream, token, project, input) {
  var url = upstream.replace(/\/+$/, "") + "/v1/scans";
  var res = await ngx.fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: project, input: input, verbose: true }),
  });
  return await res.json();
}

async function callLLM(apiKey, model, userInput) {
  var res = await ngx.fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "user", content: userInput }],
    }),
  });
  return await res.json();
}

async function oobChat(r) {
  initSSE(r);

  var body = parseBody(r);
  if (!body) {
    sendSSE(r, { stage: "error", message: "Invalid JSON body" });
    endSSE(r);
    return;
  }

  var upstream = r.variables.guardrails_upstream;

  try {
    // 1. Guardrail pre-scan
    sendSSE(r, { stage: "guardrail_start" });
    var guardrail = await callGuardrail(
      upstream,
      body.guardrailToken,
      body.project,
      body.input
    );
    sendSSE(r, { stage: "guardrail_result", guardrail: guardrail });

    // 2. Check blocked
    if (isBlocked(guardrail)) {
      sendSSE(r, { stage: "blocked", reason: "pre-scan blocked" });
      sendSSE(r, { stage: "done" });
      endSSE(r);
      return;
    }

    // 3. LLM call
    sendSSE(r, { stage: "llm_start", model: body.model });
    var llm = await callLLM(body.openrouterKey, body.model, body.input);
    var content =
      llm.choices &&
      llm.choices[0] &&
      llm.choices[0].message &&
      llm.choices[0].message.content
        ? llm.choices[0].message.content
        : "";
    sendSSE(r, {
      stage: "llm_response",
      llm: { model: body.model, content: content },
    });

    // 4. Done
    sendSSE(r, { stage: "done" });
  } catch (e) {
    sendSSE(r, { stage: "error", message: String(e.message || e) });
  }

  endSSE(r);
}

async function inlineChat(r) {
  initSSE(r);

  var body = parseBody(r);
  if (!body) {
    sendSSE(r, { stage: "error", message: "Invalid JSON body" });
    endSSE(r);
    return;
  }

  var upstream = r.variables.guardrails_upstream;

  try {
    // 1. Guardrail pre-scan
    sendSSE(r, { stage: "guardrail_start" });
    var guardrail = await callGuardrail(
      upstream,
      body.guardrailToken,
      body.project,
      body.input
    );
    sendSSE(r, { stage: "guardrail_result", guardrail: guardrail });

    // 2. Check blocked
    if (isBlocked(guardrail)) {
      sendSSE(r, { stage: "blocked", reason: "pre-scan blocked" });
      sendSSE(r, { stage: "done" });
      endSSE(r);
      return;
    }

    // 3. LLM call
    sendSSE(r, { stage: "llm_start", model: body.model });
    var llm = await callLLM(body.openrouterKey, body.model, body.input);
    var content =
      llm.choices &&
      llm.choices[0] &&
      llm.choices[0].message &&
      llm.choices[0].message.content
        ? llm.choices[0].message.content
        : "";
    sendSSE(r, {
      stage: "llm_response",
      llm: { model: body.model, content: content },
    });

    // 4. Post-scan (Inline only) — scan the LLM response
    sendSSE(r, { stage: "response_scan_start" });
    var postScan = await callGuardrail(
      upstream,
      body.guardrailToken,
      body.project,
      content
    );
    sendSSE(r, { stage: "response_scan_result", guardrail: postScan });

    // 5. Done
    sendSSE(r, { stage: "done" });
  } catch (e) {
    sendSSE(r, { stage: "error", message: String(e.message || e) });
  }

  endSSE(r);
}

export default { inlineChat, oobChat };
