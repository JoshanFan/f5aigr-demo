# F5 AI Guardrails Demo

Interactive demo platform for **F5 AI Runtime Security / Guardrails** with two operation modes:

- **Inline**: real-time request enforcement
- **Out-of-Band (OOB)**: async monitor + feedback path

The app runs behind NGINX and uses an njs orchestrator to stream stage events to the frontend via SSE.

## What This Repo Contains

- Single-page frontend (`index.html`, `styles.css`, `app.js`)
- NGINX config + njs orchestrator (`nginx/default.conf.template`, `nginx/orchestrator.js`)
- Dockerized runtime (`Dockerfile`, `docker-compose.yml`)
- Utility and unit tests (`scan-utils.js`, `scan-utils.test.js`, `nginx/orchestrator.test.js`)

## Key Features

- Inline/OOB flow visualization with step-based animation
- SSE stage telemetry (`/inline/chat`, `/oob/chat`)
- Guardrail verdict + scanner breakdown + raw JSON tab
- Dynamic LLM model label from API response payload
- Connection health check in settings panel

## Requirements

- Docker + Docker Compose
- A valid Guardrails project and API token
- (For OOB mode) OpenRouter API key for upstream LLM inference

## Quick Start

1. Create env file:

```bash
cp .env.example .env
```

2. Edit `.env` and set your upstream:

```env
HOST_PORT=3000
NGINX_LISTEN_PORT=3000
GUARDRAILS_UPSTREAM=https://<your-guardrails-domain>
```

3. Build and run:

```bash
docker compose up -d --build
```

4. Open UI:

- `http://localhost:3000`

5. Verify service health:

```bash
curl -i http://localhost:3000/healthz
```

## Runtime Endpoints

- Frontend: `GET /`
- Health: `GET /healthz`
- Guardrails proxy passthrough: `POST /backend/v1/scans`, `POST /backend/v1/prompts`
- SSE orchestrator:
  - `POST /inline/chat`
  - `POST /oob/chat`

## How to Use the Demo

1. Fill **Project ID** and **API Token**, click **Save**.
2. (OOB only) Fill **OpenRouter API Key** and choose model.
3. Pick mode (**Inline** or **Out-of-Band**).
4. Enter prompt or click a preset sample.
5. Click **Send** and observe architecture flow + result panel.

## Development

Run tests:

```bash
node --test scan-utils.test.js nginx/orchestrator.test.js
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

## Notes

- Keep credentials out of source control.
- `.env` is local-only and not committed.
- `README-NGINX.md` contains a minimal NGINX-focused runbook.
