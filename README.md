# F5 AI Guardrails Demo

Interactive demo platform for **F5 AI Guardrails** — an AI runtime security solution that inspects, evaluates, and optionally blocks LLM prompts and responses before they reach end users.

## Quick Overview

- Single-page demo UI for testing prompts against F5 AI Guardrails
- Supports both **Inline** and **Out-of-Band (OOB)** guardrail flows
- Uses **NGINX + njs** as the browser-facing orchestration layer
- Visualizes the pipeline in real time through **Server-Sent Events (SSE)**
- Returns scanner results, verdicts, model response content, and raw JSON in one place

## What It Does

- **Inline Mode** — the prompt goes through Guardrails, which evaluates it and routes it to the LLM. The UI shows each stage in real time.
- **Out-of-Band (OOB) Mode** — the prompt is pre-scanned first. If allowed, NGINX forwards it directly to the LLM.

Both modes show scanner results, risk scores, and the full request/response payload.

## Architecture

Two containers:

| Container | Role | Port |
|-----------|------|------|
| **Frontend** | Static file server (Node.js + `serve`) | 3000 |
| **NGINX** | API proxy + SSE orchestration (nginx + njs) | 8080 |

The browser loads the UI from the frontend container and sends API/SSE requests to the NGINX container. NGINX handles all communication with F5 AI Guardrails and OpenRouter — the browser never talks to them directly.

### Inline Mode Flow

```text
Browser -> NGINX -> Guardrails -> LLM -> Guardrails -> NGINX -> Browser
```

### OOB Mode Flow

```text
Browser -> NGINX -> Guardrails (pre-scan)
  If allowed: NGINX -> OpenRouter (LLM) -> NGINX -> Browser
  If blocked: NGINX -> Browser (blocked)
```

## Quick Start

```bash
docker compose up -d --build
```

- Frontend: `http://localhost:3000`
- Health check: `http://localhost:8080/healthz`

Stop:

```bash
docker compose down
```

## Requirements

- Docker and Docker Compose
- A valid F5 AI Guardrails **Project ID** and **API Token**
- An OpenRouter API key (for OOB mode)

## Configuration

### Option A: Enter values in the UI

After logging in, fill in **Project ID**, **API Token**, and optionally the **OpenRouter API Key** and **Model** in the Settings panel. Click **Save** and wait for **Connected**.

### Option B: Prefill via environment variables

Create a `.env` file (not committed to git):

```bash
DEMO_PROJECT_ID=project-app-xxxxxxxx
DEMO_API_TOKEN=your_guardrails_bearer_token
```

Optional:

```bash
API_BASE_URL=http://localhost:8080
```

Then:

```bash
docker compose up -d --build --force-recreate
```

If `API_BASE_URL` is empty, the frontend auto-derives it from the current origin (e.g. `http://localhost:3000` → `http://localhost:3000/api`). The default `docker-compose.yml` sets it to `http://localhost:8080`.

## Demo Usage

1. Log in (default: `admin` / `F5aidemo`)
2. Choose **Inline** or **OOB** mode
3. Enter or select a prompt
4. Click **Send**
5. Watch the real-time flow animation
6. Review scanner results, risk scores, and raw JSON

## Repository Layout

| File | Description |
|------|-------------|
| `index.html`, `styles.css`, `app.js` | Single-page frontend |
| `auth-utils.js` | Demo login validation |
| `scan-utils.js` | Guardrails response mapping and scanner labels |
| `runtime-config.js.template` | Template for runtime environment injection |
| `nginx/default.conf.template` | NGINX proxy and SSE configuration |
| `nginx/orchestrator.js` | njs orchestration logic |
| `Dockerfile.frontend` | Frontend container image |
| `Dockerfile.nginx` | NGINX container image |
| `docker-compose.yml` | Local development setup |

## Development

### Run tests

```bash
node --test auth-utils.test.js scan-utils.test.js nginx/orchestrator.test.js dockerfile-assets.test.js login-performance.test.js logout-feature.test.js
node --test runtime-prefill.test.js adversarial-samples.test.js
```

### Syntax checks

```bash
node --check app.js
node --check nginx/orchestrator.js
```

### Rebuild after changes

```bash
docker compose up -d --build --force-recreate
```

## Deployment Notes

This repository does not assume any single deployment platform. For a public deployment:

- the frontend is served on a public origin
- `/api/*` is routed to the NGINX container
- the `/api` prefix is stripped before traffic reaches NGINX

In many deployments, `API_BASE_URL` can be left empty if the reverse proxy exposes NGINX at `/api` on the same host as the frontend.

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Health check fails | Both containers running? Ports `3000`/`8080` free? Check `docker compose logs` |
| "Disconnected" status | Correct Project ID / API Token? `API Base URL` pointing to NGINX, not frontend? |
| `API 404` or HTML response | Request hitting wrong route — verify reverse proxy strips `/api` prefix |
| Inline mode hangs | Guardrails can reach your public `/v1/chat/completions`? Check NGINX logs |
| Request timeout | Upstream timeout in logs? Proxy re-enabling buffering? Outbound network access? |

## Security Notes

- The login gate is for demo purposes only — not production access control
- `DEMO_API_TOKEN` is exposed in `runtime-config.js` — do not use a production token
- Tokens are stored in `sessionStorage` (current tab only)
- Keep `.env` local and never commit real credentials
- Rotate demo credentials before sharing externally

## Known Limitations

- Guardrails upstream is hardcoded to `https://us1.calypsoai.app`
- Session state is browser-tab scoped, not server-side
- Demo-oriented — not designed for production multi-tenant use
- No RBAC, audit log, or backend credential vault

For detailed technical internals, see `NOTES.md` (local only, not tracked in git).
