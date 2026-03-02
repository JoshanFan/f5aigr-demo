# F5 AI Guardrails Demo

Interactive demo platform for **F5 AI Runtime Security / Guardrails** with two operation modes:

- **Inline**: real-time request enforcement
- **Out-of-Band (OOB)**: async monitor + feedback path

The app runs behind NGINX and uses an njs orchestrator to stream stage events to the frontend via SSE.

## What This Repo Contains

- Single-page frontend (`index.html`, `styles.css`, `app.js`)
- Login/auth helper (`auth-utils.js`)
- NGINX config + njs orchestrator (`nginx/default.conf.template`, `nginx/orchestrator.js`)
- Dockerized runtime (`Dockerfile`, `docker-compose.yml`)
- Utility and unit tests (`scan-utils.js`, `scan-utils.test.js`, `auth-utils.test.js`, `nginx/orchestrator.test.js`)
- Runtime guard tests for packaging/perf/logout (`dockerfile-assets.test.js`, `login-performance.test.js`, `logout-feature.test.js`)

## Key Features

- Inline/OOB flow visualization with step-based animation
- SSE stage telemetry (`/inline/chat`, `/oob/chat`)
- Guardrail verdict + scanner breakdown + raw JSON tab
- Dynamic LLM model label from API response payload
- Connection health check in settings panel
- Login gate with demo credential validation
- Session-based auth state in browser tab (`sessionStorage`)
- Header `Logout` action that clears session and returns to login gate

## Requirements

- Docker + Docker Compose
- A valid Guardrails project and API token
- (For OOB mode) OpenRouter API key for upstream LLM inference

## Quick Start

1. Build and run:

```bash
docker compose up -d --build
```

2. Open UI:

- `http://localhost:3000`

3. Verify service health:

```bash
curl -i http://localhost:3000/healthz
```

## Optional: Prefill Project ID / API Token

To prefill settings fields at startup without hardcoding credentials in HTML/JS, define environment variables in a local `.env` file:

```bash
DEMO_PROJECT_ID=project-app-xxxxxxxx
DEMO_API_TOKEN=your_guardrails_bearer_token
```

Then restart:

```bash
docker compose up -d --build --force-recreate
```

Notes:
- Prefill values are injected at container startup into `runtime-config.js`.
- If browser `sessionStorage` already has saved settings, saved values take precedence.

## Runtime Endpoints

- Frontend: `GET /`
- Health: `GET /healthz`
- Guardrails proxy passthrough: `POST /backend/v1/scans`, `POST /backend/v1/prompts`
- SSE orchestrator:
  - `POST /inline/chat`
  - `POST /oob/chat`

## How to Use the Demo

1. Log in with demo credentials:
   - Username: `joshan`
   - Password: `F%AIP@ssw0rd`
2. Fill **Project ID** and **API Token**, click **Save**.
3. (OOB only) Fill **OpenRouter API Key** and choose model.
4. Pick mode (**Inline** or **Out-of-Band**).
5. Enter prompt or click a preset sample.
6. Click **Send** and observe architecture flow + result panel.
7. Click **Logout** in the header to clear session and return to login page.

## Login Session Behavior

- Auth state is stored in `sessionStorage` key `f5_guardrails_demo_auth_v1`.
- Session is tab-scoped and cleared when the tab/window is closed.
- Logout explicitly clears that key and re-shows the login gate.

## Development

Run tests:

```bash
node --test auth-utils.test.js scan-utils.test.js nginx/orchestrator.test.js dockerfile-assets.test.js login-performance.test.js logout-feature.test.js
node --test runtime-prefill.test.js adversarial-samples.test.js
```

Syntax checks:

```bash
node --check app.js
node --check nginx/orchestrator.js
```

Rebuild container after changes:

```bash
docker compose up -d --build --force-recreate
```

## GitHub Actions Deployment

Workflow file: `.github/workflows/deploy.yml`

Pipeline:

1. Run syntax checks + unit tests
2. Build and push image to Harbor:
   - `harbor21.int.xxlab.run/f5aigr-demo/f5aigr-demo:sha-<commit>`
   - `harbor21.int.xxlab.run/f5aigr-demo/f5aigr-demo:latest`
3. SSH deploy to `172.21.70.72` and restart container on port `3000`

Required GitHub repository secrets:

- `HARBOR_USERNAME`
- `HARBOR_PASSWORD`
- `SSH_KEY`
- `DEMO_PROJECT_ID` (optional, for settings prefill)
- `DEMO_API_TOKEN` (optional, for settings prefill)

Trigger:

- Push to `main`
- Manual run via `workflow_dispatch`

Runner requirement:

- GitHub self-hosted runner with network access to:
  - `harbor21.int.xxlab.run`
  - deployment host `172.21.70.72`

## Notes

- Keep credentials out of source control.
- Guardrails upstream is hardcoded in `nginx/default.conf.template` as `https://us1.calypsoai.app`.
- `README-NGINX.md` contains a minimal NGINX-focused runbook.
