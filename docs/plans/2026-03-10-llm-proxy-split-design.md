# LLM Proxy + Container Split Design

**Date:** 2026-03-10
**Status:** Approved

## Problem

In Inline mode, after the request reaches F5 AI Guardrails, the frontend animation stalls on the Guardrails node because there is no visibility into the Guardrails-to-LLM segment. Guardrails internally calls OpenRouter for LLM inference, but the SSE stream has no signal to indicate when the LLM call starts or finishes. The animation only resumes when the entire Guardrails response returns.

Additionally, the frontend and Nginx are bundled in a single container, which should be separated for cleaner architecture.

## Solution: Approach A — Promise.race Polling with Shared Dict

Insert Nginx as a reverse proxy between Guardrails and OpenRouter. Configure Guardrails to send its LLM requests to `https://openrouterproxy.xxlab.run/v1/chat/completions` instead of directly to OpenRouter. Nginx proxies the request to OpenRouter and records timestamps in `js_shared_dict_zone`. The SSE handler uses `Promise.race` with a 200ms polling interval to detect these signals and emit real-time SSE events to the frontend.

## New Traffic Flow (Inline Mode)

```
Browser → Frontend Container (port 3000, static files)
Browser → Nginx Container (port 8080, API requests)
           ├── /inline/chat (SSE orchestrator)
           │     └── subrequest → /_internal/calypso_prompts → Guardrails
           │                        └── Guardrails calls https://openrouterproxy.xxlab.run/v1/chat/completions
           │                              └── Nginx /v1/chat/completions (llmProxy handler)
           │                                    └── subrequest → /_internal/openrouter → OpenRouter
           │                                    └── writes start/end timestamps to shared dict
           │                              └── SSE handler detects via polling, emits llm_proxy_start / llm_proxy_done
           ├── /backend/* (Guardrails direct proxy)
           └── /v1/chat/completions (LLM proxy, called by Guardrails externally)
```

## Container Architecture

### Frontend Container
- Base image: `node:alpine`
- Static file server: `serve` package
- Port: 3000
- Contains: index.html, app.js, styles.css, auth-utils.js, scan-utils.js, runtime-config.js
- No proxy or njs logic

### Nginx Container
- Base image: `nginx:alpine` + `nginx-module-njs`
- Port: 8080
- Contains: njs orchestrator, all proxy configurations, LLM proxy
- CORS headers for cross-origin requests from frontend
- Environment variables: DEMO_PROJECT_ID, DEMO_API_TOKEN, API_BASE_URL

## Nginx Config Changes

### New directives (top-level)
```nginx
js_shared_dict_zone zone=llm_signals:1m;
```

### New upstream
```nginx
upstream openrouter_api {
    server openrouter.ai:443;
    keepalive 8;
    keepalive_timeout 60s;
}
```

### New locations

**LLM proxy endpoint (external, called by Guardrails):**
```nginx
location = /v1/chat/completions {
    if ($http_authorization = '') {
        return 401 '{"error":"missing authorization"}';
    }
    js_content orchestrator.llmProxy;
    client_body_in_single_buffer on;
    client_body_buffer_size 64k;
    client_max_body_size 64k;
}
```

**Internal OpenRouter proxy (used via subrequest from njs):**
```nginx
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
    proxy_read_timeout 35s;
    proxy_send_timeout 10s;
}
```

### CORS headers on all API endpoints
```nginx
add_header Access-Control-Allow-Origin "<frontend-origin>" always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
```

## njs Orchestrator Changes

### New handler: `llmProxy`
- Validates Authorization header presence (reject 401 if missing)
- Writes `start` timestamp to `ngx.shared.llm_signals`
- Proxies request to OpenRouter via `/_internal/openrouter` subrequest
- Writes `end` timestamp to `ngx.shared.llm_signals`
- Returns OpenRouter response to caller (Guardrails)

### Modified: `inlineChat`
- Clears shared dict signals before starting
- Replaces direct `await callPromptProxy()` with Promise.race polling loop
- Every 200ms tick: checks shared dict for `start` and `end` signals
- Emits `llm_proxy_start` SSE event when `start` detected
- Emits `llm_proxy_done` SSE event when `end` detected
- After loop exits (Guardrails returned): continues with existing logic

### New SSE events

| Event | Trigger | Meaning |
|-------|---------|---------|
| `llm_proxy_start` | shared dict `start` detected | Guardrails scan complete, LLM request arrived at Nginx |
| `llm_proxy_done` | shared dict `end` detected | LLM inference complete, response arrived at Nginx |

### Full Inline SSE event sequence
```
guardrail_start       → animation: request enters Guardrails
inline_dispatch       → (empty)
inline_waiting        → (empty)
llm_proxy_start       → animation: traffic reaches LLM (hold)     ← NEW
llm_proxy_done        → animation: LLM response returns           ← NEW
guardrail_result      → animation: Guardrails decision finalized
llm_response          → animation: response returns to NGINX
done                  → end
```

## Frontend Changes

### Animation mapping (app.js)
- Add `llm_proxy_start` stage: animate Step 3 (Guardrails → LLM), hold at LLM node
- Add `llm_proxy_done` stage: animate Step 4 (LLM → Guardrails)
- Simplify existing `llm_response` stage: only Step 5 (Guardrails → NGINX) since Steps 3-4 are now handled by new events

### API base URL
- `runtime-config.js.template` adds `API_BASE_URL` env var
- Frontend fetch calls use `apiBaseUrl` prefix for all API endpoints
- `docker-entrypoint.d/20-runtime-config.sh` updated to substitute new var

### No changes to
- HTML architecture diagram
- CSS / styling
- OOB mode animation or flow
- Existing Guardrails proxy locations (`/_internal/calypso_*`)

## Docker Compose

```yaml
services:
  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    ports:
      - "3000:3000"
    restart: unless-stopped

  nginx:
    build:
      context: .
      dockerfile: Dockerfile.nginx
    environment:
      DEMO_PROJECT_ID: ${DEMO_PROJECT_ID:-}
      DEMO_API_TOKEN: ${DEMO_API_TOKEN:-}
      API_BASE_URL: ${API_BASE_URL:-http://localhost:8080}
    ports:
      - "8080:8080"
    restart: unless-stopped
```

## Risk / Considerations

- **njs Promise.race compatibility:** Requires njs >= 0.7.0. nginx:alpine ships with a compatible version.
- **Shared dict concurrency:** For demo use with low concurrency, simple `start`/`end` keys suffice. Not suitable for production multi-tenant use without correlation IDs.
- **200ms polling granularity:** Imperceptible to human eye, adequate for animation timing.
- **CORS:** Frontend on port 3000 calling Nginx on port 8080 requires proper CORS headers.
