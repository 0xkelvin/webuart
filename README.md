# Online UART (v1)

A browser-based USB-UART terminal using the Web Serial API.

## What v1 does

- Connect to a USB-UART device from browser picker
- Configure UART settings:
  - baud rate
  - data bits
  - stop bits
  - parity
  - flow control
  - buffer size
- Stream RX data into terminal view
- Send TX text data with selectable line ending
- Connect/disconnect and clear log controls

## Requirements

- Chrome, Edge, or Firefox desktop (Web Serial API)
- HTTPS deployment, or localhost for local development
- USB-UART driver installed in OS if needed (chip dependent)

## Run locally

```bash
npm install
npm run dev
```

<img width="1370" height="951" alt="image" src="https://github.com/user-attachments/assets/a2bcae06-30a4-4951-89f7-66ff336ed94a" />


Open the shown localhost URL in Chrome, Edge, or Firefox.

## Build

```bash
npm run build
npm run preview
```

## Docker deployment (vHost)

This project runs the frontend as a static Nginx container. Share API/WebSocket should point to your Cloudflare Worker URL.

1. Build and start container:

```bash
docker compose up -d --build
```

2. Configure API/WS endpoint at runtime (recommended):

```bash
ONLINE_UART_SHARE_API_BASE="https://api.vietmq.com" \
ONLINE_UART_SHARE_WS_BASE="wss://api.vietmq.com" \
docker compose up -d --build
```

Notes:
- If `ONLINE_UART_SHARE_WS_BASE` is empty, container startup auto-derives it from `ONLINE_UART_SHARE_API_BASE` (`https` -> `wss`, `http` -> `ws`).
- If both are empty, app falls back to default runtime behavior in frontend code.

3. Deploy Cloudflare Worker separately from `worker/`:

```bash
cd worker
npm install
npm run deploy
```

## Redeploy and test checklist

1. Redeploy worker:

```bash
cd worker
npm run deploy
```

2. Redeploy frontend container:

```bash
cd ..
docker compose up -d --build
```

3. DNS and API checks:

```bash
nslookup api.vietmq.com
curl -i -X OPTIONS https://api.vietmq.com/api/sessions \
  -H 'Origin: https://vietmq.com' \
  -H 'Access-Control-Request-Method: POST'
curl -i -X POST https://api.vietmq.com/api/sessions \
  -H 'Origin: https://vietmq.com'
```

Expected:
- `OPTIONS` returns `204` with `Access-Control-Allow-Origin`.
- `POST` returns `201` with `sessionId` and `hostToken`.
- `GET /api/sessions` returns `404` by design (route is POST only).

## Troubleshooting

### Viewer link redirects to `/webuart/uart-a`

If opening `https://your-domain/viewer.html?s=<session-id>` redirects to the main app route, the frontend build is usually missing `dist/viewer.html`.

This project uses Vite multi-page build via `vite.config.ts` so both pages are emitted:
- `dist/index.html`
- `dist/viewer.html`

Quick verification:

```bash
npm run build
ls -la dist
```

If `viewer.html` is missing, check `vite.config.ts` and redeploy the frontend container:

```bash
docker compose up -d --build
```

## How to use

1. Plug USB-UART adapter/device into your computer.
2. Open the app in Chrome, Edge, or Firefox.
3. Set UART parameters.
4. Click Connect.
5. In browser serial picker, select the UART port.
6. View RX data in terminal panel.
7. Type TX data and click Send.

## Known limitations

- Safari support is limited.
- Browser requires explicit user gesture for `requestPort()`.
- Zero latency is not possible; this app aims for low latency.
