# SSE Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current fire-and-forget API pattern with NGINX njs orchestrated SSE streaming, enabling real-time stage-by-stage animation for both Inline and OOB modes, with OpenRouter LLM integration.

**Architecture:** Single nginx:alpine container with njs module. NGINX handles all orchestration server-side: receives POST, calls Guardrails API via `ngx.fetch()`, decides pass/block, calls OpenRouter LLM if passed, streams SSE events at each stage. Frontend consumes SSE via `fetch()` + `ReadableStream`, triggering flow animation per event.

**Tech Stack:** NGINX njs (ngx.fetch, r.sendBuffer), vanilla JS (ES modules), SSE protocol, OpenRouter API (OpenAI-compatible), Docker

---

## Task 1: Dockerfile — Add njs Module

**Files:**
- Modify: `Dockerfile`

**Step 1: Update Dockerfile**

```dockerfile
FROM nginx:alpine

# Install njs module
RUN apk add --no-cache nginx-mod-http-js

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy njs orchestrator
COPY nginx/orchestrator.js /etc/nginx/njs/orchestrator.js

# Copy frontend static files
COPY index.html    /usr/share/nginx/html/
COPY styles.css    /usr/share/nginx/html/
COPY app.js        /usr/share/nginx/html/
COPY scan-utils.js /usr/share/nginx/html/

# Copy nginx config template
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${NGINX_LISTEN_PORT:-3000}/healthz || exit 1
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add njs module to Dockerfile"
```

---

## Task 2: NGINX Config — Add SSE Locations & njs Import

**Files:**
- Modify: `nginx/default.conf.template`

**Step 1: Update nginx config**

Add `load_module` at the very top (before `server` block), add `js_import`, and add two new `location` blocks. The `GUARDRAILS_UPSTREAM` env var is already available via nginx envsubst. We pass it to njs via `js_var`.

```nginx
load_module modules/ngx_http_js_module.so;

js_import orchestrator from /etc/nginx/njs/orchestrator.js;
js_var $guardrails_upstream ${GUARDRAILS_UPSTREAM};

server {
    listen ${NGINX_LISTEN_PORT};
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /backend/ {
        proxy_pass ${GUARDRAILS_UPSTREAM};
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_name $proxy_host;
        proxy_set_header Host $proxy_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # SSE orchestrator endpoints
    location = /inline/chat {
        js_content orchestrator.inlineChat;
        proxy_buffering off;
        sendfile off;
        tcp_nopush off;
        tcp_nodelay on;
    }

    location = /oob/chat {
        js_content orchestrator.oobChat;
        proxy_buffering off;
        sendfile off;
        tcp_nopush off;
        tcp_nodelay on;
    }
}
```

**Step 2: Commit**

```bash
git add nginx/default.conf.template
git commit -m "feat: add SSE orchestrator locations to nginx config"
```

---

## Task 3: orchestrator.js — njs SSE Orchestrator

**Files:**
- Create: `nginx/orchestrator.js`

**Step 1: Write orchestrator.js**

This is the core njs module. It handles both Inline and OOB flows using `ngx.fetch()` for external API calls and `r.sendBuffer()` for SSE streaming.

```javascript
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
```

**Step 2: Commit**

```bash
git add nginx/orchestrator.js
git commit -m "feat: add njs SSE orchestrator for Guardrail + LLM pipeline"
```

---

## Task 4: Build & Smoke Test njs Module

**Step 1: Build the container**

```bash
docker compose down --remove-orphans
docker compose up -d --build
```

**Step 2: Verify container starts**

```bash
docker compose ps
curl -s http://127.0.0.1:3000/healthz
```

Expected: container running, healthz returns `ok`.

**Step 3: Smoke test SSE endpoint (expect error due to missing body/credentials — that's OK, we just want to confirm njs loads)**

```bash
curl -s -X POST http://127.0.0.1:3000/oob/chat \
  -H "Content-Type: application/json" \
  -d '{"input":"test"}' \
  --no-buffer
```

Expected: SSE response with `event: stage` and `data: {"stage":"error",...}` or `{"stage":"guardrail_start"}` followed by a guardrail fetch error. This confirms njs is loaded and SSE is working.

**Step 4: Commit (if any fixes were needed)**

---

## Task 5: HTML — Settings Panel (OpenRouter Fields)

**Files:**
- Modify: `index.html`

**Step 1: Add OpenRouter Key and Model fields to the settings panel**

Insert after the API Token field and before the Connection field. Add a new row:

```html
<label class="field field--grow">
  <span>OpenRouter Key</span>
  <input
    id="openrouterKey"
    type="password"
    value=""
    placeholder="sk-or-v1-..."
    autocomplete="off"
  />
</label>
<label class="field field--grow">
  <span>Model</span>
  <select id="llmModel">
    <option value="openai/gpt-4o-mini" selected>openai/gpt-4o-mini</option>
    <option value="openai/gpt-4o">openai/gpt-4o</option>
    <option value="anthropic/claude-sonnet-4">anthropic/claude-sonnet-4</option>
    <option value="google/gemini-2.0-flash">google/gemini-2.0-flash</option>
  </select>
</label>
```

**Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add OpenRouter key and model selector to settings"
```

---

## Task 6: HTML — Result Panel LLM Response Section

**Files:**
- Modify: `index.html`

**Step 1: Add LLM Response section after Scanner Breakdown, before Context Preview**

```html
<div class="llm-response-section" id="llmResponseSection">
  <span class="llm-response-label">LLM Response</span>
  <p id="llmResponseContent" class="llm-response-content">No LLM response yet.</p>
  <span id="llmResponseModel" class="llm-response-model"></span>
</div>
```

Insert between the `scanner-details` div (line ~403) and the `result-preview` div (line ~405).

**Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add LLM response section to result panel"
```

---

## Task 7: HTML — Update OOB Flow Diagram

**Files:**
- Modify: `index.html`

**Step 1: Update OOB diagram to reflect serial flow (Guardrail before LLM)**

The current OOB diagram shows CHATBOT → NGINX → LLM (direct) with async Guardrail on the side. The new design is serial: CHATBOT → NGINX → GUARDRAILS → LLM, same as Inline but without post-scan.

Update the OOB diagram section (`flow-diagram--oob`) to use a linear layout similar to Inline:

```html
<!-- ── OOB DIAGRAM ── -->
<div class="flow-diagram flow-diagram--oob" data-diagram="oob" aria-label="Out-of-band architecture">
  <p class="diagram-tag">ARCHITECTURE FLOW · OUT-OF-BAND</p>

  <div class="flow-lane flow-lane--request">
    <div class="flow-node flow-node--chatbot" data-node="o-chatbot">CHATBOT</div>

    <div class="flow-conn">
      <div class="flow-step">
        <div class="step-circle step-circle--request" data-node="o-n1">1</div>
        <svg class="flow-arrow flow-arrow--request" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </div>
      <div class="flow-step">
        <div class="step-circle step-circle--response" data-node="o-n5">5</div>
        <svg class="flow-arrow flow-arrow--response" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </div>
    </div>

    <div class="flow-node flow-node--nginx" data-node="o-nginx">NGINX</div>

    <div class="flow-conn">
      <div class="flow-step">
        <div class="step-circle step-circle--request" data-node="o-n2">2</div>
        <svg class="flow-arrow flow-arrow--request" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </div>
      <div class="flow-step">
        <div class="step-circle step-circle--response" data-node="o-n4">4</div>
        <svg class="flow-arrow flow-arrow--response" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </div>
    </div>

    <div class="flow-core" data-node="o-core">
      <p>F5 AI GUARDRAILS</p>
      <div class="flow-node flow-node--scanner" data-node="o-scanner">SCANNER</div>
    </div>

    <div class="flow-conn">
      <div class="flow-step">
        <div class="step-circle step-circle--request" data-node="o-n3">3</div>
        <svg class="flow-arrow flow-arrow--request" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </div>
    </div>

    <div class="flow-node flow-node--llm" data-node="o-llm">LLM Inference</div>
  </div>

  <div class="flow-notes">
    <span class="flow-note flow-note--warn">Blocked → return safe response, LLM not called</span>
    <span class="flow-note flow-note--ok">Pass → forward to LLM inference</span>
  </div>

  <div class="flow-legend">
    <span class="legend-pill legend-pill--request">
      <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      REQUEST PATH
    </span>
    <span class="legend-pill legend-pill--response">
      <svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      RESPONSE PATH
    </span>
  </div>
</div>
```

Key changes: removed the `oob-scan-row` / `flow-bridge` async section, replaced with Inline-like linear layout (CHATBOT → NGINX → GUARDRAILS → LLM). Removed ASYNC OOB PATH legend pill. Step numbers: 1-2 request, 3 to LLM, 4-5 response.

**Step 2: Commit**

```bash
git add index.html
git commit -m "feat: update OOB diagram to serial Guardrail-before-LLM layout"
```

---

## Task 8: CSS — New Component Styles

**Files:**
- Modify: `styles.css`

**Step 1: Add styles for new components**

Add styles for: select dropdown (model selector), LLM response section.

```css
/* Model selector dropdown */
select {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 14px;
  transition: border-color var(--speed-fast) ease;
  appearance: none;
  cursor: pointer;
}

select:focus {
  outline: none;
  border-color: var(--accent-cyan);
  box-shadow: 0 0 0 3px rgba(0, 194, 255, 0.15);
}

/* LLM Response section */
.llm-response-section {
  margin-top: 16px;
  padding: 14px;
  background: rgba(0, 194, 255, 0.04);
  border: 1px solid var(--border-default);
  border-radius: 10px;
}

.llm-response-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.llm-response-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0 0 8px 0;
  max-height: 300px;
  overflow-y: auto;
}

.llm-response-model {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-ui);
}

.llm-response-section--blocked .llm-response-content {
  color: var(--risk-high);
  font-style: italic;
}
```

**Step 2: Commit**

```bash
git add styles.css
git commit -m "feat: add styles for model selector and LLM response section"
```

---

## Task 9: app.js — Settings Management (OpenRouter)

**Files:**
- Modify: `app.js`

**Step 1: Add DOM references for new elements**

Add to the `dom` object:

```javascript
openrouterKey: document.getElementById("openrouterKey"),
llmModel: document.getElementById("llmModel"),
llmResponseSection: document.getElementById("llmResponseSection"),
llmResponseContent: document.getElementById("llmResponseContent"),
llmResponseModel: document.getElementById("llmResponseModel"),
```

**Step 2: Update saveSettings / loadSettings**

Save and load `openrouterKey` and `llmModel` from sessionStorage alongside existing fields.

In `saveSettings()`:
```javascript
const payload = {
  projectId: dom.projectId.value.trim(),
  apiToken: dom.apiToken.value.trim(),
  openrouterKey: dom.openrouterKey.value.trim(),
  llmModel: dom.llmModel.value,
};
```

In `loadSettings()`:
```javascript
if (settings.openrouterKey) {
  dom.openrouterKey.value = settings.openrouterKey;
}
if (settings.llmModel) {
  dom.llmModel.value = settings.llmModel;
}
```

**Step 3: Add input listeners for new fields**

In `initListeners()`:
```javascript
dom.openrouterKey.addEventListener("input", handleSettingsInput);
dom.llmModel.addEventListener("change", handleSettingsInput);
```

**Step 4: Commit**

```bash
git add app.js
git commit -m "feat: add OpenRouter settings management"
```

---

## Task 10: app.js — SSE Client & Animation Refactor

**Files:**
- Modify: `app.js`

This is the largest change. Replace `handleScan()` internals with SSE consumption, and refactor animation to be event-driven.

**Step 1: Add SSE endpoint constants**

Update `API_ENDPOINTS`:
```javascript
const API_ENDPOINTS = {
  inline: "/inline/chat",
  oob: "/oob/chat",
};
```

Keep the old endpoints for connection check only:
```javascript
const GUARDRAIL_CHECK_ENDPOINT = "/backend/v1/scans";
```

Update `checkConnectionStatus` to use `GUARDRAIL_CHECK_ENDPOINT` instead of `API_ENDPOINTS.oob`.

**Step 2: Write SSE parser helper**

```javascript
function parseSSELines(text) {
  const events = [];
  const lines = text.split("\n");
  let currentData = null;

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentData !== null) {
      try {
        events.push(JSON.parse(currentData));
      } catch (_e) { /* skip malformed */ }
      currentData = null;
    }
  }
  return events;
}
```

**Step 3: Write per-stage animation function**

Replace `runFlowAnimation()` with `highlightStage(stage, mode)`:

```javascript
function getStageNodes(stage, mode) {
  const prefix = mode === "inline" ? "i" : "o";
  const p = (id) => `${prefix}-${id}`;

  const stageMap = {
    guardrail_start: {
      nodes: [p("chatbot"), p("nginx"), p("core")],
      circles: [p("n1"), p("n2")],
      phase: "request",
    },
    guardrail_result: {
      nodes: [p("scanner")],
      circles: [],
      phase: "scan",
    },
    blocked: {
      nodes: [p("core"), p("nginx"), p("chatbot")],
      circles: [p("n5"), p("n6")],
      phase: "block",
    },
    llm_start: {
      nodes: [p("core"), p("llm")],
      circles: [p("n3")],
      phase: "request",
    },
    llm_response: {
      nodes: [p("llm")],
      circles: [],
      phase: "response",
    },
    response_scan_start: {
      nodes: [p("core"), p("scanner")],
      circles: [],
      phase: "scan",
    },
    response_scan_result: {
      nodes: [p("scanner")],
      circles: [],
      phase: "scan",
    },
    done: {
      nodes: [p("llm"), p("nginx"), p("chatbot")],
      circles: [p("n4"), p("n5")],
      phase: "response",
    },
  };

  return stageMap[stage] || null;
}

async function highlightStage(stage, mode) {
  const mapping = getStageNodes(stage, mode);
  if (!mapping) return;

  clearFlowHighlights();
  const phaseClass = `flow-active-${mapping.phase}`;

  mapping.nodes.forEach((id) => {
    const el = dom.flowBoard.querySelector(`[data-node="${id}"]`);
    if (el) el.classList.add("flow-active", phaseClass);
  });

  mapping.circles.forEach((id) => {
    const el = dom.flowBoard.querySelector(`[data-node="${id}"]`);
    if (el) el.classList.add("flow-active", phaseClass);
  });

  await wait(600);
}
```

**Step 4: Write LLM response renderer**

```javascript
function renderLLMResponse(content, model, isBlocked) {
  if (isBlocked) {
    dom.llmResponseContent.textContent = "Blocked by Guardrail — LLM was not called.";
    dom.llmResponseSection.classList.add("llm-response-section--blocked");
    dom.llmResponseModel.textContent = "";
  } else {
    dom.llmResponseContent.textContent = content || "No content returned.";
    dom.llmResponseSection.classList.remove("llm-response-section--blocked");
    dom.llmResponseModel.textContent = model ? `Model: ${model}` : "";
  }
}
```

**Step 5: Rewrite handleScan() to use SSE**

```javascript
async function handleScan() {
  if (state.isScanning) return;

  const prompt = dom.promptInput.value.trim();
  const projectId = dom.projectId.value.trim();
  const token = dom.apiToken.value.trim();
  const openrouterKey = dom.openrouterKey.value.trim();
  const model = dom.llmModel.value;
  const endpoint = API_ENDPOINTS[state.mode];

  if (!projectId) {
    dom.scanState.textContent = "Please fill Project ID first.";
    dom.projectId.focus();
    return;
  }
  if (!token) {
    dom.scanState.textContent = "Please fill API Token first.";
    dom.apiToken.focus();
    return;
  }
  if (!openrouterKey) {
    dom.scanState.textContent = "Please fill OpenRouter Key first.";
    dom.openrouterKey.focus();
    return;
  }
  if (!prompt) {
    dom.scanState.textContent = "Please input a prompt first.";
    dom.promptInput.focus();
    return;
  }

  setScanning(true);
  dom.flowBoard.classList.add("is-running");
  clearFlowHighlights();

  let guardrailPayload = null;
  let llmContent = "";
  let wasBlocked = false;
  let fullPayload = {};

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: prompt,
        project: projectId,
        guardrailToken: token,
        openrouterKey: openrouterKey,
        model: model,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = parseSSELines(buffer);

      // Keep any incomplete line in the buffer
      const lastNewline = buffer.lastIndexOf("\n\n");
      if (lastNewline >= 0) {
        buffer = buffer.slice(lastNewline + 2);
      }

      for (const event of events) {
        dom.scanState.textContent = `Stage: ${event.stage}`;
        await highlightStage(event.stage, state.mode);

        if (event.stage === "guardrail_result" || event.stage === "response_scan_result") {
          guardrailPayload = event.guardrail;
          fullPayload = event.guardrail;
        }

        if (event.stage === "blocked") {
          wasBlocked = true;
          guardrailPayload = guardrailPayload || {};
        }

        if (event.stage === "llm_response") {
          llmContent = event.llm?.content || "";
        }

        if (event.stage === "error") {
          throw new Error(event.message || "Unknown SSE error");
        }
      }
    }

    // Render final results
    if (guardrailPayload) {
      const mapped = mapScanApiResult(guardrailPayload);
      if (wasBlocked) {
        mapped.verdict = "Block";
        mapped.level = "high";
      }
      renderResult(mapped);
      renderRawJson(guardrailPayload);
      updateAnalytics(mapped);
      dom.scanState.textContent = `Scan complete • ${mapped.meta.outcome}`;
    }

    renderLLMResponse(llmContent, model, wasBlocked);

  } catch (error) {
    if (error.name === "AbortError") {
      error.message = "Request timeout after 90s.";
    }
    await highlightStage("blocked", state.mode);
    renderApiError(error.message);
    renderRawJson({ error: error.message });
    renderLLMResponse("", "", true);
    dom.scanState.textContent = `Scan failed: ${error.message}`;
  } finally {
    clearFlowHighlights();
    dom.flowBoard.classList.remove("is-running");
    setScanning(false);
  }
}
```

**Step 6: Update checkConnectionStatus to use GUARDRAIL_CHECK_ENDPOINT**

Change the `endpoint` in `checkConnectionStatus` from `API_ENDPOINTS.oob` to `GUARDRAIL_CHECK_ENDPOINT`.

**Step 7: Remove old animation functions**

Remove `getInlineSequence()`, `getOobSequence()`, and `runFlowAnimation()` — they are replaced by `getStageNodes()` and `highlightStage()`.

**Step 8: Commit**

```bash
git add app.js
git commit -m "feat: rewrite scan flow to SSE-driven animation with LLM integration"
```

---

## Task 11: Rebuild & Integration Test

**Step 1: Rebuild container**

```bash
docker compose down --remove-orphans
docker compose up -d --build
```

**Step 2: Verify healthz**

```bash
curl -s http://127.0.0.1:3000/healthz
```

Expected: `ok`

**Step 3: Test SSE endpoint with curl**

```bash
curl -s -X POST http://127.0.0.1:3000/oob/chat \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","project":"test","guardrailToken":"test","openrouterKey":"test","model":"openai/gpt-4o-mini"}' \
  --no-buffer
```

Expected: SSE events streaming (`event: stage\ndata: {...}`). Will show `guardrail_start` then likely an error from the Guardrails API (invalid token) — that's expected.

**Step 4: Open browser and test manually**

1. Open `http://127.0.0.1:3000/`
2. Fill in Guardrails credentials + OpenRouter key
3. Select a model
4. Choose a preset scenario
5. Click "Run Guardrail Scan" in both Inline and OOB modes
6. Verify: animation lights up stage-by-stage, LLM response appears in result panel, blocked prompts show red flow

**Step 5: Commit any fixes**

---

## Task 12: Update OOB Animation Node Mapping

**Files:**
- Modify: `app.js`

**Step 1: Verify OOB node data-attributes match new diagram**

After Task 7 changed the OOB diagram HTML, verify the `data-node` attributes in the new OOB diagram match what `getStageNodes()` expects. The new OOB diagram uses:
- `o-chatbot`, `o-nginx`, `o-core`, `o-scanner`, `o-llm`
- `o-n1`, `o-n2`, `o-n3`, `o-n4`, `o-n5`

Adjust `getStageNodes()` if the step numbers differ. In particular, the `done` stage for OOB should use `o-n4` and `o-n5` (the response path circles in the updated diagram).

**Step 2: Test both modes and verify animation correctness**

**Step 3: Commit if changes needed**

```bash
git add app.js
git commit -m "fix: align OOB animation mapping with updated diagram"
```
