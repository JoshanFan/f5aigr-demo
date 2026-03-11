# F5 AI Guardrails Demo

Interactive demo platform for **F5 AI Guardrails** — an AI runtime security solution that inspects, evaluates, and optionally blocks LLM prompts and responses before they reach end users. This project demonstrates how NGINX can serve as a front-end proxy to orchestrate and visualize the guardrail inspection flow in real time.

## What It Does

The demo supports two operation modes:

- **Inline Mode** — the prompt is sent through the Guardrails inspection flow. NGINX proxies the request to Guardrails, which evaluates the prompt and routes it to the LLM. The UI displays a real-time Server-Sent Events (SSE) animation showing each stage of the flow: request → Guardrails → LLM → response.
- **Out-of-Band (OOB) Mode** — the prompt is pre-scanned by Guardrails first. If allowed, NGINX forwards it directly to the LLM. The UI visualizes the scan result and the LLM response separately.

Both modes show Guardrails scanner results, risk scores, and the full request/response payload in a single-page UI.

## Architecture

The platform runs as two containers:

| Container | Role | Port |
|-----------|------|------|
| **Frontend** | Static file server (Node.js + `serve`) | 3000 |
| **NGINX** | API proxy + SSE orchestration (nginx + njs) | 8080 |

```
Browser ──────► NGINX (port 8080) ──────► F5 AI Guardrails ──────► LLM
                  │                                                  │
                  │◄──── SSE stream (real-time flow animation) ◄─────┘
                  │
                  ▼
            Frontend (port 3000)
```

### How NGINX Fits In

NGINX acts as the orchestration layer between the browser and the Guardrails API:

1. **Proxies API requests** to the Guardrails upstream (`us1.calypsoai.app`) with connection pooling and keepalive
2. **Streams SSE events** back to the browser so the UI can render each stage of the guardrail flow in real time
3. **Handles CORS** for cross-origin requests from the frontend
4. **Health check endpoint** at `/healthz` for monitoring

All orchestration logic is implemented in [nginx/orchestrator.js](nginx/orchestrator.js) using NGINX njs (JavaScript scripting for NGINX).

## Requirements

- Docker and Docker Compose
- A valid F5 AI Guardrails **Project ID** and **API Token**
- An OpenRouter API key (for OOB mode)

## Quick Start

### 1. Start the containers

```bash
docker compose up -d --build
```

### 2. Open the demo

- Frontend: `http://localhost:3000`
- Health check: `http://localhost:8080/healthz`

### 3. Verify NGINX is running

```bash
curl -i http://localhost:8080/healthz
```

Expected:

```
HTTP/1.1 200 OK
ok
```

### 4. Stop

```bash
docker compose down
```

## Configuration

### Option A: Enter values in the UI

After logging in, fill in the **Project ID**, **API Token**, and optionally the **OpenRouter API Key** and **Model** in the Settings panel. Click **Save** and wait for the connection status to show **Connected**.

### Option B: Prefill via environment variables

Create a `.env` file (not committed to git):

```bash
DEMO_PROJECT_ID=project-app-xxxxxxxx
DEMO_API_TOKEN=your_guardrails_bearer_token
API_BASE_URL=http://localhost:8080
```

Then start the containers:

```bash
docker compose up -d --build --force-recreate
```

The environment variables are injected into `runtime-config.js` at container startup. Browser `sessionStorage` values override prefilled values if the user has already saved settings in that tab.

## Demo Usage

1. Log in with the demo credentials
2. Enter or select a prompt from the preset scenarios
3. Choose **Inline** or **OOB** mode
4. Click **Send**
5. Watch the real-time flow animation as the request passes through Guardrails
6. Review the summary, scanner results, risk scores, and raw JSON payload

### Login Credentials

Default demo credentials (defined in `auth-utils.js`):

- Username: `joshan`
- Password: `F%AIP@ssw0rd`

## NGINX Proxy Details

### Upstream

Guardrails API upstream: `https://us1.calypsoai.app`

NGINX configuration:

- Listens on container port `8080`
- Resolver: `8.8.8.8`, `1.1.1.1` (IPv4 only)
- Upstream keepalive with connection reuse and SSL session caching

### SSE Streaming

The SSE endpoints disable proxy buffering to ensure events reach the browser immediately:

- `proxy_buffering off`
- `gzip off`
- `chunked_transfer_encoding on`
- `X-Accel-Buffering: no`
- `tcp_nodelay on`

### CORS

Allowed origins for cross-origin requests:

- `http://localhost` (any port)
- `https://f5aigrdemo.xxlab.run`

Additional origins can be added in the CORS map in `nginx/default.conf.template`.

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
| `.github/workflows/deploy.yml` | CI/CD pipeline |

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

## Deployment

GitHub Actions workflow: `.github/workflows/deploy.yml`

### Pipeline

1. Run syntax checks and tests
2. Build two Docker images (frontend + nginx)
3. Push images to the container registry
4. SSH into the deploy host
5. Start both containers

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `HARBOR_USERNAME` | Container registry login |
| `HARBOR_PASSWORD` | Container registry password |
| `SSH_KEY` | SSH key for the deploy host |
| `DEMO_PROJECT_ID` | Optional: frontend auto-prefill |
| `DEMO_API_TOKEN` | Optional: frontend auto-prefill |
| `API_BASE_URL` | NGINX endpoint URL for frontend API calls |

## Troubleshooting

### Health check fails

- Verify both containers are running: `docker compose ps`
- Check that ports `3000` and `8080` are not already in use
- Review logs: `docker compose logs --tail=200`

### Connection shows "Disconnected"

- Verify your **Project ID** and **API Token** are correct
- Confirm `API Base URL` points to the NGINX container (e.g., `http://localhost:8080`)
- Check outbound connectivity to `us1.calypsoai.app` from the container

### Request hangs or times out

- Check for upstream timeouts in the container logs
- Confirm there is no intermediate reverse proxy re-enabling response buffering
- Verify outbound network access from the deploy host

## Security Notes

- The login gate is for demo purposes only. Credentials are not production-grade access control.
- `DEMO_API_TOKEN` is exposed in `runtime-config.js` — do not use a high-privilege production token.
- User-entered tokens are stored in `sessionStorage` (current tab only).
- Keep `.env` local and never commit real credentials.
- Rotate demo credentials before sharing the repository externally.

## Known Limitations

- Guardrails upstream is hardcoded to `https://us1.calypsoai.app`
- Session state is browser-tab scoped, not server-side
- Demo-oriented — not designed for production multi-tenant use
- No RBAC, audit log, or backend credential vault
