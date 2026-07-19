#!/usr/bin/env bash
# vocalbridge/start-tunnel.sh — ensure a healthy public tunnel to the app,
# record it in .env, and sync the hosted agent's webhook to it. One command
# (`npm run voice:tunnel`) makes the live call deliverable end-to-end.
#
# Uses a Cloudflare quick tunnel (no account, no agent limit). If the current
# PUBLIC_BASE_URL already answers, it is kept as-is.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-3000}"
LOG=vocalbridge/.tunnel.log

healthy() {
  curl -sf --max-time 6 "$1/api/voice/webhook" | grep -q '"ok":true'
}

if [ -n "${PUBLIC_BASE_URL:-}" ] && healthy "$PUBLIC_BASE_URL"; then
  echo "✓ tunnel already healthy: $PUBLIC_BASE_URL"
else
  command -v cloudflared >/dev/null 2>&1 || {
    echo "!! cloudflared not installed — brew install cloudflared"; exit 1;
  }
  echo "▸ starting cloudflared quick tunnel → http://localhost:$PORT"
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  : > "$LOG"
  nohup cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
  done
  [ -n "$URL" ] || { echo "!! tunnel URL never appeared — see $LOG"; exit 1; }

  # Persist to .env (replace or append). next dev reloads env files on change.
  if grep -q '^PUBLIC_BASE_URL=' .env 2>/dev/null; then
    tmp=$(mktemp)
    sed "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=${URL}#" .env > "$tmp" && mv "$tmp" .env
  else
    echo "PUBLIC_BASE_URL=${URL}" >> .env
  fi
  export PUBLIC_BASE_URL="$URL"
  echo "✓ tunnel up: $URL (written to .env)"
fi

bash vocalbridge/sync-webhook.sh
