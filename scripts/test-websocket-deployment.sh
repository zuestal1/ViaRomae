#!/usr/bin/env bash

# Verify the WebSocket upgrade through the public player vHost.
# Usage: WS_TOKEN=<player-jwt> [PLAYER_BASE_URL=https://jlw2026.example.com] $0

set -euo pipefail

player_base_url="${PLAYER_BASE_URL:-https://jlw2026.example.com}"
ws_token="${WS_TOKEN:-}"

if [[ -z "$ws_token" ]]; then
  echo "WS_TOKEN must contain a valid player JWT." >&2
  exit 2
fi

endpoint="${player_base_url%/}/api/v1/geo/ws"
headers_file="$(mktemp)"
trap 'rm -f "$headers_file"' EXIT

# A successful WebSocket remains open, so curl normally reaches the timeout
# after recording the handshake. Both success and timeout are acceptable here;
# the response status below is the deployment assertion.
curl_exit=0
curl \
  --silent \
  --show-error \
  --http1.1 \
  --max-time 5 \
  --dump-header "$headers_file" \
  --output /dev/null \
  --get \
  --data-urlencode "token=${ws_token}" \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$endpoint" || curl_exit=$?

if [[ "$curl_exit" -ne 0 && "$curl_exit" -ne 28 ]]; then
  echo "WebSocket request failed (curl exit ${curl_exit})." >&2
  exit "$curl_exit"
fi

status="$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$headers_file")"
if [[ "$status" != "101" ]]; then
  echo "Expected WebSocket status 101 from ${endpoint}, received ${status:-no response}." >&2
  cat "$headers_file" >&2
  exit 1
fi

echo "WebSocket upgrade succeeded with status 101 via ${endpoint}."
