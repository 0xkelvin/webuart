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

### Apply Config reports "device stored a DIFFERENT value" for every key

The ESP32 console doubles the carriage return: `at_cmd.c` prints
`"<< KEY=value\r\n\r\n"`, and the ESP-IDF UART VFS
(`CONFIG_NEWLIB_STDOUT_LINE_ENDING_CRLF`) expands each `\n` again, so the wire
carries `<< KEY=value\r\r\n\r\r\n`.

A reader that ends the value at the first `\r\n` therefore captures
`value\r` — one character too long — and the verification in `configService.ts`
rejects every key even though the device stored the right value. Line parsing
against this firmware must terminate on `\n` and strip trailing `\r`.

`src/configService.test.ts` reproduces the doubling in its `FakeDevice.send()`;
keep it that way or the regression becomes invisible again.

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

## Radar firmware (IWR6843) — flash through the ESP32 bridge

The **Radar** tab flashes a TI IWR6843 image on a GM1000 carrier board without any
soldering-iron, UniFlash or Python: it is a browser port of
`gm_radar/tools/flash_iwr6843_bridge.py`.

How it works: the board's `U6` mux routes the radar's flash UART to the ESP32, so the
tab talks to the ESP32's console, enters its boot-time AT window, sends
`AT+RADARBOOT=BRIDGE`, and the ESP32 puts the radar into its ROM bootloader and turns
itself into a transparent byte bridge. The tab then speaks TI's serial flashing
protocol (SYNC packets, `0xCC` acknowledgements, 240-byte data packets) directly to
the ROM, and finishes with `AT+RADARBOOT=OFF` + `AT+RST` so the board comes back in
normal operation.

1. Plug in **both** USB cables — the radar's own USB is its power supply.
2. Open the **Radar** tab, choose the route:
   - **Auto** for boards with the `GPIO4 → 1 kΩ → S1/SOP2` wire (nothing to press);
   - **Buttons** for unmodified boards: when the tab asks, hold `S1`, tap `S2`, keep
     `S1` held about a second, release, then press **continue**.
3. **Load .bin** — the MSS multicore image, e.g. `vital_1_0_demo-<hash>-<size>.bin`.
   Images named `BROKEN-do-not-flash-*` are refused.
4. **Connect** and pick the **ESP32 console port** (CH343), never the radar's CP2105.
5. **Flash radar**. About 80 s for a 620 KB image; the console shows every step.

Notes:
- The ESP32 raises its console to 921600 once the bridge is up. Web Serial cannot
  change baud in place, so the tab closes and reopens the port at 921600 — the same
  thing esptool-js does for its own baud switch.
- Cancel is honoured between data packets and still runs the cleanup, so a cancelled
  flash never leaves the board parked in bridge mode.
- `src/radarFlashService.test.ts` drives the whole flow against a fake board that
  models the auto-reset circuit, the baud jump and TI's packet framing.

## Known limitations

- Safari support is limited.
- Browser requires explicit user gesture for `requestPort()`.
- Zero latency is not possible; this app aims for low latency.
