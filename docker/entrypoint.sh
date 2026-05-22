#!/bin/sh
set -eu

API_BASE="${ONLINE_UART_SHARE_API_BASE:-}"
WS_BASE="${ONLINE_UART_SHARE_WS_BASE:-}"

if [ -z "$WS_BASE" ] && [ -n "$API_BASE" ]; then
  case "$API_BASE" in
    https://*) WS_BASE="wss://${API_BASE#https://}" ;;
    http://*) WS_BASE="ws://${API_BASE#http://}" ;;
    *) WS_BASE="$API_BASE" ;;
  esac
fi

replace_placeholders() {
  file="$1"
  if [ -f "$file" ]; then
    sed -i "s|__ONLINE_UART_SHARE_API_BASE__|$API_BASE|g" "$file"
    sed -i "s|__ONLINE_UART_SHARE_WS_BASE__|$WS_BASE|g" "$file"
  fi
}

replace_placeholders /usr/share/nginx/html/index.html
replace_placeholders /usr/share/nginx/html/viewer.html

exec "$@"