#!/usr/bin/env bash
# vocalbridge/sync-webhook.sh — push the CURRENT public webhook URL onto the
# hosted Vocal Bridge agent's submit_choice tool.
#
# Tunnel URLs rotate per run; the hosted agent keeps whatever URL it was last
# given. Run this (or `npm run voice:sync`) after the tunnel changes — though
# the app also auto-heals this in its real-call preflight.
#
# Reads from .env: VOCAL_BRIDGE_API_KEY, PUBLIC_BASE_URL,
#                  VOICE_WEBHOOK_TOKEN (optional), VOCAL_BRIDGE_AGENT_ID (optional)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
VB="${VOCAL_BRIDGE_CLI:-vb}"
: "${VOCAL_BRIDGE_API_KEY:?Set VOCAL_BRIDGE_API_KEY in .env}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL in .env (your public https URL, no trailing slash)}"
export VOCAL_BRIDGE_API_KEY
export VOCAL_BRIDGE_API_URL="${VOCAL_BRIDGE_BASE_URL:-https://vocalbridgeai.com}"

WEBHOOK="${PUBLIC_BASE_URL%/}/api/voice/webhook"
if [ -n "${VOICE_WEBHOOK_TOKEN:-}" ]; then
  WEBHOOK="${WEBHOOK}?token=${VOICE_WEBHOOK_TOKEN}"
fi

sed "s#\$PUBLIC_BASE_URL/api/voice/webhook#${WEBHOOK}#g" \
  vocalbridge/api-tools.template.json > vocalbridge/api-tools.json

if [ -n "${VOCAL_BRIDGE_AGENT_ID:-}" ]; then
  "$VB" agent use "$VOCAL_BRIDGE_AGENT_ID" >/dev/null
fi
"$VB" config set --api-tools-file vocalbridge/api-tools.json >/dev/null
echo "✓ hosted agent webhook → ${WEBHOOK}"
