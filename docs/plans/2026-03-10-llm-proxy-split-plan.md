# LLM Proxy + Container Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Nginx LLM proxy between Guardrails and OpenRouter with real-time SSE signals, and split frontend into a separate container.

**Architecture:** Nginx uses `js_shared_dict_zone` for cross-request communication. The `llmProxy` handler records timestamps when Guardrails' LLM request arrives/completes. The `inlineChat` SSE handler polls via `Promise.race` every 200ms to detect these signals and emit real-time SSE events. Frontend and Nginx are split into separate containers.

**Tech Stack:** Nginx + njs, Node.js `serve`, Docker, docker-compose

**Design doc:** `docs/plans/2026-03-10-llm-proxy-split-design.md`

---

### Task 1: Create Dockerfile.frontend

**Files:**
- Create: `Dockerfile.frontend`

**Step 1: Create the Dockerfile**

```dockerfile
FROM node:alpine

RUN npm install -g serve

WORKDIR /app

COPY index.html .
COPY styles.css .
COPY app.js .
COPY auth-utils.js .
COPY scan-utils.js .
COPY runtime-config.js .
COPY runtime-config.js.template .

COPY --chmod=755 docker-entrypoint.d/20-runtime-config.sh /docker-entrypoint.d/20-runtime-config.sh

EXPOSE 3000

# Run envsubst for runtime config, then serve
CMD ["/bin/sh", "-c", "/docker-entrypoint.d/20-runtime-config.sh && serve -s /app -l 3000"]
```

Note: `serve -s` enables single-page app mode (all routes fallback to index.html).

**Step 2: Verify the Dockerfile builds**

Run: `docker build -f Dockerfile.frontend -t f5ai-frontend:test .`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add Dockerfile.frontend
git commit -m "feat: add frontend Dockerfile with node serve"
```

---

### Task 2: Create Dockerfile.nginx (rename and strip static files)

**Files:**
- Create: `Dockerfile.nginx`
- Keep: `Dockerfile` (unchanged for now, remove later in Task 9)

**Step 1: Create the Dockerfile**

```dockerfile
FROM nginx:alpine

RUN apk add --no-cache nginx-module-njs ca-certificates \
 && sed -i '1s|^|load_module modules/ngx_http_js_module.so;\n|' /etc/nginx/nginx.conf

# Remove default nginx page (no static files served by this container)
RUN rm -rf /usr/share/nginx/html/*

# Copy njs orchestrator
COPY nginx/orchestrator.js /etc/nginx/njs/orchestrator.js

# Copy nginx config template
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
```

**Step 2: Verify the Dockerfile builds**

Run: `docker build -f Dockerfile.nginx -t f5ai-nginx:test .`
Expected: Build succeeds (may warn about missing orchestrator exports, that's OK at this stage)

**Step 3: Commit**

```bash
git add Dockerfile.nginx
git commit -m "feat: add nginx-only Dockerfile without static files"
```

---

### Task 3: Update Nginx config — listen port, shared dict, OpenRouter upstream, CORS

**Files:**
- Modify: `nginx/default.conf.template`

**Step 1: Add shared dict zone and new js_var at the top of the file**

After the existing `js_var $calypso_auth '';` line, add:

```nginx
js_var $llm_auth '';
js_shared_dict_zone zone=llm_signals:1m;
```

**Step 2: Add OpenRouter upstream**

After the existing `upstream calypso_api { ... }` block, add:

```nginx
upstream openrouter_api {
    server openrouter.ai:443;
    keepalive 8;
    keepalive_timeout 60s;
}
```

**Step 3: Change listen port from 3000 to 8080**

Change `listen 3000;` to `listen 8080;`.

**Step 4: Remove static file serving**

Remove the `root`, `index`, and `location / { try_files ... }` directives. The nginx container no longer serves static files.

**Step 5: Add CORS headers**

Add a map block before the server block for flexible origin handling:

```nginx
map $http_origin $cors_origin {
    default "";
    "~^https?://localhost(:[0-9]+)?$" $http_origin;
    "~^https?://f5aigrdemo\\.xxlab\\.run$" $http_origin;
}
```

Inside the server block, add CORS headers:

```nginx
# CORS
add_header Access-Control-Allow-Origin $cors_origin always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;

# Preflight
if ($request_method = OPTIONS) {
    return 204;
}
```

**Step 6: Add LLM proxy location**

After the existing `/_internal/calypso_scans` location, add:

```nginx
# LLM proxy endpoint (called externally by Guardrails)
location = /v1/chat/completions {
    if ($http_authorization = '') {
        return 401 '{"error":"missing authorization"}';
    }

    js_content orchestrator.llmProxy;

    client_body_in_single_buffer on;
    client_body_buffer_size 64k;
    client_max_body_size 64k;
}

# Internal OpenRouter proxy (used via r.subrequest from njs)
location = /_internal/openrouter {
    internal;
    proxy_pass https://openrouter_api/api/v1/chat/completions;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_name openrouter.ai;
    proxy_ssl_session_reuse on;
    proxy_set_header Host openrouter.ai;
    proxy_set_header Authorization $llm_auth;
    proxy_set_header Content-Type "application/json";
    proxy_set_header Connection "";
    proxy_buffer_size 32k;
    proxy_buffers 4 32k;
    proxy_busy_buffers_size 64k;
    proxy_read_timeout 35s;
    proxy_send_timeout 10s;
}
```

**Step 7: Verify nginx config syntax**

Run: `docker run --rm -v $(pwd)/nginx:/etc/nginx/templates:ro -v $(pwd)/nginx/orchestrator.js:/etc/nginx/njs/orchestrator.js:ro nginx:alpine nginx -t`
Expected: May fail because orchestrator.js doesn't export `llmProxy` yet — that's OK, move on.

**Step 8: Commit**

```bash
git add nginx/default.conf.template
git commit -m "feat: update nginx config with LLM proxy, shared dict, CORS, port 8080"
```

---

### Task 4: Add `llmProxy` handler to njs orchestrator

**Files:**
- Modify: `nginx/orchestrator.js`

**Step 1: Write the test for llmProxy export**

Add to `nginx/orchestrator.test.js`:

```javascript
test("orchestrator exports llmProxy function", () => {
  assert.equal(typeof orchestrator.llmProxy, "function");
});
```

**Step 2: Run the test to verify it fails**

Run: `node --test nginx/orchestrator.test.js`
Expected: FAIL — `llmProxy` is not exported

**Step 3: Add `llmProxy` function to orchestrator.js**

Add before the `export default` block:

```javascript
async function llmProxy(r) {
  var auth = r.headersIn["Authorization"] || "";
  if (!auth) {
    r.return(401, JSON.stringify({ error: "missing authorization" }));
    return;
  }

  // Signal SSE handler: LLM request arrived
  ngx.shared.llm_signals.set("start", String(Date.now()));

  try {
    r.variables.llm_auth = auth;

    var reply = await withTimeout(
      r.subrequest("/_internal/openrouter", {
        method: "POST",
        body: r.requestText,
      }),
      LLM_TIMEOUT_MS,
      "LLM proxy"
    );

    // Signal SSE handler: LLM response received
    ngx.shared.llm_signals.set("end", String(Date.now()));

    r.headersOut["Content-Type"] = "application/json";
    r.return(reply.status, reply.responseText);
  } catch (e) {
    ngx.shared.llm_signals.set("end", String(Date.now()));
    r.return(502, JSON.stringify({ error: String(e.message || e) }));
  }
}
```

**Step 4: Add `llmProxy` to the export block**

```javascript
export default {
  inlineChat,
  oobChat,
  llmProxy,
  buildGuardrailScanUrl,
  buildGuardrailPromptUrl,
  getPromptResponseModel,
  getLLMResponseModel,
};
```

**Step 5: Run the test to verify it passes**

Run: `node --test nginx/orchestrator.test.js`
Expected: PASS (note: `ngx` is not defined in test env, but the export test only checks the function exists)

**Step 6: Syntax check**

Run: `node --check nginx/orchestrator.js`
Expected: No errors

**Step 7: Commit**

```bash
git add nginx/orchestrator.js nginx/orchestrator.test.js
git commit -m "feat: add llmProxy handler to njs orchestrator"
```

---

### Task 5: Modify `inlineChat` to use Promise.race polling

**Files:**
- Modify: `nginx/orchestrator.js`

**Step 1: Replace the `inlineChat` function**

Replace the entire `async function inlineChat(r)` with:

```javascript
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
        // Check for LLM proxy start signal
        if (!llmStartEmitted) {
          var startTs = ngx.shared.llm_signals.get("start");
          if (startTs) {
            emitStage(r, "llm_proxy_start", { ts: parseInt(startTs) });
            llmStartEmitted = true;
          }
        }
        // Check for LLM proxy end signal
        if (llmStartEmitted && !llmEndEmitted) {
          var endTs = ngx.shared.llm_signals.get("end");
          if (endTs) {
            emitStage(r, "llm_proxy_done", { ts: parseInt(endTs) });
            llmEndEmitted = true;
          }
        }
      }
    }

    // 2. Guardrails returned
    emitStage(r, "guardrail_result", { guardrail: promptResult });

    // 3. Check blocked
    if (isBlocked(promptResult)) {
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
```

**Step 2: Syntax check**

Run: `node --check nginx/orchestrator.js`
Expected: No errors

**Step 3: Run existing tests to verify nothing is broken**

Run: `node --test nginx/orchestrator.test.js`
Expected: All existing tests PASS

**Step 4: Commit**

```bash
git add nginx/orchestrator.js
git commit -m "feat: inlineChat uses Promise.race polling for real-time LLM signals"
```

---

### Task 6: Update frontend — API base URL support

**Files:**
- Modify: `runtime-config.js.template`
- Modify: `runtime-config.js`
- Modify: `docker-entrypoint.d/20-runtime-config.sh`
- Modify: `app.js`

**Step 1: Update runtime-config.js.template**

```javascript
window.__F5_DEMO_PREFILL__ = Object.freeze({
  projectId: "${DEMO_PROJECT_ID}",
  apiToken: "${DEMO_API_TOKEN}",
  apiBaseUrl: "${API_BASE_URL}",
});
```

**Step 2: Update runtime-config.js (default for local dev)**

```javascript
window.__F5_DEMO_PREFILL__ = Object.freeze({
  projectId: "",
  apiToken: "",
  apiBaseUrl: "",
});
```

**Step 3: Update 20-runtime-config.sh to substitute new var**

Change the envsubst line to:

```bash
envsubst '${DEMO_PROJECT_ID} ${DEMO_API_TOKEN} ${API_BASE_URL}' < "${template_path}" > "${output_path}"
```

**Step 4: Update app.js — add apiBaseUrl helper and update endpoint constants**

At the top of `app.js`, after the existing constants (around line 12), add:

```javascript
function getApiBaseUrl() {
  const prefill = window.__F5_DEMO_PREFILL__;
  const base = (prefill && prefill.apiBaseUrl) || "";
  return base.replace(/\/+$/, "");
}
```

Change the endpoint constants to use the helper:

```javascript
const SSE_ENDPOINTS = {
  inline: "/inline/chat",
  oob: "/oob/chat",
};
const GUARDRAIL_CHECK_ENDPOINT = "/backend/v1/scans";
```

These stay as relative paths. The `getApiBaseUrl()` prefix is applied at fetch call sites.

**Step 5: Update fetch calls in app.js**

In `requestGuardrails` function (line ~1436), change:
```javascript
const response = await fetch(endpoint, {
```
to:
```javascript
const response = await fetch(getApiBaseUrl() + endpoint, {
```

In `handleScan` function (line ~1616), change:
```javascript
const responsePromise = fetch(endpoint, {
```
to:
```javascript
const responsePromise = fetch(getApiBaseUrl() + endpoint, {
```

**Step 6: Syntax check**

Run: `node --check app.js`
Expected: No errors

**Step 7: Commit**

```bash
git add runtime-config.js.template runtime-config.js docker-entrypoint.d/20-runtime-config.sh app.js
git commit -m "feat: add API_BASE_URL support for cross-origin API calls"
```

---

### Task 7: Update frontend — add new SSE stage animation mappings

**Files:**
- Modify: `app.js`

**Step 1: Add `llm_proxy_start` and `llm_proxy_done` cases in inline flow**

In the `getInlineFlowStepsForStage` function (or equivalent switch block for inline mode), find the `case "inline_waiting":` block (around line 1044). After it, add:

```javascript
case "llm_proxy_start":
  return [
    {
      stepNumber: 3,
      circles: ["i-n3"],
      phase: "request",
      durationMs: 220,
      label: "Step 3 \u2022 Guardrails -> LLM",
    },
    {
      nodes: ["i-llm"],
      phase: "request",
      durationMs: 240,
      label: "LLM receives request",
      hold: true,
    },
  ];
case "llm_proxy_done":
  return [
    {
      stepNumber: 4,
      circles: ["i-n4"],
      phase: "response",
      durationMs: 220,
      label: "Step 4 \u2022 LLM -> Guardrails",
    },
    {
      nodes: ["i-core"],
      phase: "response",
      durationMs: 240,
      persist: false,
      label: "F5 AI Runtime receives LLM response",
    },
  ];
```

**Step 2: Simplify existing `llm_response` case for inline mode**

Replace the current `case "llm_response":` block (around line 1058) with:

```javascript
case "llm_response":
  return [
    {
      stepNumber: 5,
      circles: ["i-n5"],
      phase: "response",
      durationMs: 220,
      label: "Step 5 \u2022 Guardrails -> NGINX",
    },
    {
      nodes: ["i-nginx"],
      phase: "response",
      durationMs: 240,
      label: "NGINX receives validated response",
    },
  ];
```

**Step 3: Handle SSE stage names in the event processing**

In the SSE event processing loop in `handleScan` (around line 1685-1688), the existing code already calls `highlightStage(stageName, ...)` for any stage. The new `llm_proxy_start` and `llm_proxy_done` stages will be routed through this automatically. No change needed here.

**Step 4: Syntax check**

Run: `node --check app.js`
Expected: No errors

**Step 5: Commit**

```bash
git add app.js
git commit -m "feat: add real-time LLM proxy animation stages for inline mode"
```

---

### Task 8: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Replace docker-compose.yml content**

```yaml
services:
  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    environment:
      DEMO_PROJECT_ID: ${DEMO_PROJECT_ID:-}
      DEMO_API_TOKEN: ${DEMO_API_TOKEN:-}
      API_BASE_URL: ${API_BASE_URL:-http://localhost:8080}
    ports:
      - "3000:3000"
    restart: unless-stopped

  nginx:
    build:
      context: .
      dockerfile: Dockerfile.nginx
    ports:
      - "8080:8080"
    restart: unless-stopped
```

**Step 2: Verify compose config**

Run: `docker compose config`
Expected: Valid YAML output with both services

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: split into frontend and nginx containers in docker-compose"
```

---

### Task 9: Update CI/CD pipeline

**Files:**
- Modify: `.github/workflows/deploy.yml`

**Step 1: Update the workflow**

The CI pipeline needs to:
- Build two images (frontend + nginx)
- Deploy two containers
- Syntax check still covers `app.js` and `nginx/orchestrator.js`
- Unit tests unchanged

Update the build job to build both images. Update the deploy job to run both containers. The frontend container gets `DEMO_PROJECT_ID`, `DEMO_API_TOKEN`, and `API_BASE_URL` env vars. The nginx container needs no special env vars.

Key changes:
- Build matrix or sequential build for two Dockerfiles
- Deploy step runs two `docker run` commands
- Frontend on port 3000, Nginx on port 8080
- Add `API_BASE_URL` secret or hardcode to `https://f5aigrdemo.xxlab.run:8080` (or whichever URL Guardrails will use)

**Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: update pipeline for two-container deployment"
```

---

### Task 10: Clean up old Dockerfile and verify full build

**Files:**
- Remove: `Dockerfile` (replaced by `Dockerfile.frontend` + `Dockerfile.nginx`)

**Step 1: Remove old Dockerfile**

```bash
git rm Dockerfile
```

**Step 2: Full build test**

Run: `docker compose build`
Expected: Both `frontend` and `nginx` images build successfully

**Step 3: Full run test**

Run: `docker compose up -d`
Expected: Both containers start. `http://localhost:3000` serves frontend. `http://localhost:8080/healthz` returns `ok`.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove legacy single-container Dockerfile"
```

---

### Task 11: End-to-end validation

**Step 1: Verify SSE stream includes new events**

Run the demo manually:
1. Open `http://localhost:3000` in browser
2. Configure settings (project ID, API token, OpenRouter key)
3. Set API Base URL to `http://localhost:8080` (if not auto-configured)
4. Select Inline mode
5. Send a prompt

Expected SSE event sequence:
```
guardrail_start
inline_dispatch
inline_waiting
llm_proxy_start    ← NEW: animation should move to LLM node
llm_proxy_done     ← NEW: animation should return from LLM
guardrail_result
llm_response
done
```

**Step 2: Verify animation flow**

- After `guardrail_start`: animation holds on Guardrails/scanner nodes
- After `llm_proxy_start`: animation moves to LLM node and holds
- After `llm_proxy_done`: animation returns to Guardrails
- After `llm_response`: animation returns through NGINX to chatbot

**Step 3: Verify LLM proxy rejects unauthenticated requests**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/v1/chat/completions`
Expected: `401`

**Step 4: Verify OOB mode is unaffected**

Switch to OOB mode and run a prompt. Behavior should be identical to before.
