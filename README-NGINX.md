# F5 AI Guardrails Demo - NGINX Proxy

## 1) Start

```bash
docker compose up -d --build
```

## 2) Verify

```bash
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/
```

Guardrails upstream is hardcoded in `nginx/default.conf.template`:

```txt
https://us1.calypsoai.app
```

Proxy route:

- Frontend: `http://127.0.0.1:3000/`
- Guardrails API via proxy: `http://127.0.0.1:3000/backend/...`

## 3) Stop

```bash
docker compose down
```
