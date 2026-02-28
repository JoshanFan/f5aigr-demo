# F5 AI Guardrails Demo - NGINX Proxy

## 1) Prepare env

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
GUARDRAILS_UPSTREAM=https://<your-guardrails-upstream>
```

## 2) Start

```bash
docker compose up -d
```

## 3) Verify

```bash
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/
```

Proxy route:

- Frontend: `http://127.0.0.1:3000/`
- Guardrails API via proxy: `http://127.0.0.1:3000/backend/...`

## 4) Stop

```bash
docker compose down
```
