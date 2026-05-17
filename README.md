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

- Chrome or Edge desktop (Web Serial API)
- HTTPS deployment, or localhost for local development
- USB-UART driver installed in OS if needed (chip dependent)

## Run locally

```bash
npm install
npm run dev
```

<img width="1370" height="951" alt="image" src="https://github.com/user-attachments/assets/a2bcae06-30a4-4951-89f7-66ff336ed94a" />


Open the shown localhost URL in Chrome/Edge.

## Build

```bash
npm run build
npm run preview
```

## How to use

1. Plug USB-UART adapter/device into your computer.
2. Open the app in Chrome/Edge.
3. Set UART parameters.
4. Click Connect.
5. In browser serial picker, select the UART port.
6. View RX data in terminal panel.
7. Type TX data and click Send.

## Known limitations

- Not supported in Safari/Firefox.
- Browser requires explicit user gesture for `requestPort()`.
- Zero latency is not possible; this app aims for low latency.
