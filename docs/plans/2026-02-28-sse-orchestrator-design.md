# SSE Orchestrator Design — NGINX njs

**Date:** 2026-02-28
**Status:** Approved

## Summary

Replace the current "fire-and-forget" API call pattern with a Server-Sent Events (SSE) architecture where NGINX njs orchestrates the Guardrail → LLM pipeline server-side, pushing real-time stage events to the frontend. Both Inline and OOB modes use SSE, giving users a live view of each processing stage.

## Architecture

### Single Container (unchanged)

```
┌─────────────────────────────────────────┐
│  nginx:alpine + njs module              │
│                                         │
│  /              → static HTML/CSS/JS    │
│  /backend/*     → Guardrails API proxy  │  (kept for connection check)
│  /inline/chat   → njs inlineChat (SSE)  │  NEW
│  /oob/chat      → njs oobChat (SSE)    │  NEW
│  /healthz       → 200 ok               │
└─────────────────────────────────────────┘
```

### Inline Flow (SSE)

```
POST /inline/chat
  ├─ SSE: guardrail_start        ← begin pre-scan
  ├─ ngx.fetch → /v1/scans       ← Guardrail pre-scan
  ├─ SSE: guardrail_result       ← pre-scan result
  │
  ├─ blocked? → SSE: blocked → done
  │
  ├─ SSE: llm_start              ← forward to LLM
  ├─ ngx.fetch → OpenRouter
  ├─ SSE: llm_response           ← LLM response
  │
  ├─ SSE: response_scan_start    ← begin post-scan (response audit)
  ├─ ngx.fetch → /v1/scans       ← Guardrail post-scan on LLM output
  ├─ SSE: response_scan_result   ← post-scan result
  │
  └─ SSE: done
```

### OOB Flow (SSE)

```
POST /oob/chat
  ├─ SSE: guardrail_start
  ├─ ngx.fetch → /v1/scans
  ├─ SSE: guardrail_result
  │
  ├─ blocked? → SSE: blocked → done
  │
  ├─ SSE: llm_start
  ├─ ngx.fetch → OpenRouter
  ├─ SSE: llm_response
  │
  └─ SSE: done
```

### Key Difference

| | Inline | OOB |
|---|---|---|
| Pre-scan | Yes | Yes |
| LLM call | After pass | After pass |
| **Post-scan** | **Yes — scans LLM response** | **No** |
| Story | "Dual protection: scan in & out" | "Entry gate: screen before sending" |

## SSE Protocol

All events use the same format:

```
event: stage
data: {"stage": "<stage_name>", ...payload}
```

### Events

| Stage | Payload | When |
|---|---|---|
| `guardrail_start` | `{}` | Always first |
| `guardrail_result` | `{"guardrail": {...}}` | After pre-scan completes |
| `blocked` | `{"reason": "pre-scan blocked"}` | If Guardrail blocks |
| `llm_start` | `{"model": "..."}` | Before LLM call |
| `llm_response` | `{"llm": {"model","content"}}` | After LLM responds |
| `response_scan_start` | `{}` | Inline only, before post-scan |
| `response_scan_result` | `{"guardrail": {...}}` | Inline only, after post-scan |
| `done` | `{}` | Always last |
| `error` | `{"message": "..."}` | On any failure |

## Request Format

```json
POST /inline/chat  or  /oob/chat
Content-Type: application/json

{
  "input": "user prompt text",
  "project": "project-id",
  "guardrailToken": "bearer-token",
  "openrouterKey": "sk-or-...",
  "model": "openai/gpt-4o-mini"
}
```

## File Changes

### New Files

| File | Purpose |
|---|---|
| `nginx/orchestrator.js` | njs module: inlineChat, oobChat, sendSSE, isBlocked |

### Modified Files

| File | Changes |
|---|---|
| `Dockerfile` | Add `apk add nginx-mod-http-js`, COPY orchestrator.js |
| `nginx/default.conf.template` | Add `load_module`, `js_import`, `/inline/chat` and `/oob/chat` locations |
| `index.html` | Add OpenRouter Key + Model fields in settings; add LLM Response section in result panel; update OOB flow diagram |
| `app.js` | Replace `requestGuardrails()` + `runFlowAnimation()` with SSE-driven flow; add `handleScanSSE()`; split animation into per-stage `highlightStage()`; read OpenRouter settings |
| `styles.css` | Styles for new settings fields and LLM response section |
| `scan-utils.js` | No changes needed |
| `.env` | No changes needed (OpenRouter key comes from frontend) |

## NGINX njs Details

### orchestrator.js Structure

```javascript
// Env var injected via js_var or nginx variable
// GUARDRAILS_UPSTREAM from nginx config

async function inlineChat(r) { /* SSE orchestration with post-scan */ }
async function oobChat(r)    { /* SSE orchestration without post-scan */ }

function sendSSE(r, data) {
  r.sendBuffer(`event: stage\ndata: ${JSON.stringify(data)}\n\n`, { last: false });
}

function isBlocked(guardrailResult) {
  // Check outcome for blocked/deny/rejected
}

export default { inlineChat, oobChat };
```

### Key njs APIs Used

- `ngx.fetch()` — direct external HTTP calls (njs >= 0.7.4)
- `r.sendBuffer(data, {last})` — chunked SSE output
- `r.sendHeader()` — send response headers before body
- `r.requestBody` — read POST body

### NGINX Config Additions

```nginx
load_module modules/ngx_http_js_module.so;
js_import orchestrator from /etc/nginx/njs/orchestrator.js;
js_var $guardrails_upstream;  # injected from env

location /inline/chat {
    js_content orchestrator.inlineChat;
    proxy_buffering off;
}

location /oob/chat {
    js_content orchestrator.oobChat;
    proxy_buffering off;
}
```

## Frontend Animation Mapping

| SSE Event | Animation Nodes | Color |
|---|---|---|
| `guardrail_start` | CHATBOT → NGINX → Guardrails | cyan (request) |
| `guardrail_result` | Scanner glow | teal (scan) |
| `blocked` | Guardrails → NGINX → CHATBOT | red (block) |
| `llm_start` | Guardrails → LLM | cyan (request) |
| `llm_response` | LLM glow | green (response) |
| `response_scan_start` | LLM → Guardrails | teal (scan) |
| `response_scan_result` | Scanner glow | teal (scan) |
| `done` | LLM → NGINX → CHATBOT | green (response) |

## Settings Panel

```
┌─ Settings ─────────────────────────────────────────────────┐
│  Project ID     [__________]   API Token     [__________]  │  existing
│  OpenRouter Key [__________]   Model         [▼ dropdown]  │  NEW
│  Connection  ● Connected                        [Save]     │
└────────────────────────────────────────────────────────────┘
```

Default models in dropdown:
- `openai/gpt-4o-mini` (default — fast, cheap)
- `openai/gpt-4o`
- `anthropic/claude-sonnet-4`
- `google/gemini-2.0-flash`

OpenRouter key and model stored in sessionStorage alongside existing credentials.

## Result Panel — LLM Response Section

New section between Scanner Breakdown and Context Preview:

```
▼ LLM Response
  「この文を日本語に翻訳してください...」
  Model: openai/gpt-4o-mini
```

If blocked: "Blocked by Guardrail — LLM was not called."

## What Stays Unchanged

- `/backend/*` proxy pass — kept for connection check
- Analytics KPI accumulation
- Adversarial Test Samples (presets 1-4)
- scan-utils.js mapping functions
- .env file
