#!/usr/bin/env bash
# vocalbridge/setup-agent.sh — create + configure the Vocal Bridge outbound agent.
#
# Run this ONCE (re-run to update). Requires a PAID Vocal Bridge plan (agent
# creation + phone deploy are paid-only) and that you accept the outbound ToU.
#
# Prereqs:
#   - `vb` CLI installed (pip install vocal-bridge) and on PATH, or set VOCAL_BRIDGE_CLI
#   - .env filled in: VOCAL_BRIDGE_API_KEY and PUBLIC_BASE_URL (your ngrok https URL)
#
# Usage:  bash vocalbridge/setup-agent.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- load env ----
if [ -f .env ]; then set -a; . ./.env; set +a; fi
VB="${VOCAL_BRIDGE_CLI:-vb}"
: "${VOCAL_BRIDGE_API_KEY:?Set VOCAL_BRIDGE_API_KEY in .env}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL in .env (your ngrok https URL, no trailing slash)}"
export VOCAL_BRIDGE_API_KEY
export VOCAL_BRIDGE_API_URL="${VOCAL_BRIDGE_BASE_URL:-https://vocalbridgeai.com}"

echo "▸ Using vb: $($VB --version)"
echo "▸ Webhook target: ${PUBLIC_BASE_URL}/api/voice/webhook"

# ---- render api-tools.json from template (substitute the public URL) ----
sed "s#\$PUBLIC_BASE_URL#${PUBLIC_BASE_URL}#g" \
  vocalbridge/api-tools.template.json > vocalbridge/api-tools.json
echo "▸ Rendered vocalbridge/api-tools.json"

GREETING="$(cat vocalbridge/outbound-greeting.txt)"

# ---- create the agent (or reuse VOCAL_BRIDGE_AGENT_ID) ----
if [ -z "${VOCAL_BRIDGE_AGENT_ID:-}" ]; then
  echo "▸ Creating agent 'Rescue Rebooking' (paid plan required)…"
  CREATE_JSON="$("$VB" agent create \
    --name "Rescue Rebooking" \
    --style Chatty \
    --prompt-file vocalbridge/agent-prompt.txt \
    --greeting "$GREETING" \
    --deploy-targets phone \
    --json)"
  echo "$CREATE_JSON"
  AGENT_ID="$(printf '%s' "$CREATE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or d.get("agent_id") or d.get("agent",{}).get("id",""))')"
  [ -n "$AGENT_ID" ] || { echo "!! Could not parse agent id from create output"; exit 1; }
  echo "▸ Created agent: $AGENT_ID"
  echo "   → add this to .env:  VOCAL_BRIDGE_AGENT_ID=$AGENT_ID"
else
  AGENT_ID="$VOCAL_BRIDGE_AGENT_ID"
  echo "▸ Reusing agent: $AGENT_ID (updating prompt + config)"
  "$VB" --agent "$AGENT_ID" prompt set --file vocalbridge/agent-prompt.txt
  "$VB" --agent "$AGENT_ID" config set --greeting "$GREETING" --deploy-targets phone
fi

# ---- select it (so plain `vb call` uses it) ----
"$VB" agent use "$AGENT_ID" || true

# ---- outbound settings + the submit_choice HTTP tool ----
echo "▸ Enabling outbound + wiring submit_choice → webhook…"
"$VB" --agent "$AGENT_ID" config set \
  --outbound-enabled true \
  --outbound-greeting "$GREETING" \
  --outbound-wait-for-user true \
  --accept-outbound-tos \
  --api-tools-file vocalbridge/api-tools.json

echo "▸ Verifying api-tools on the agent:"
"$VB" --agent "$AGENT_ID" config get api-tools || true

echo
echo "✓ Agent ready: $AGENT_ID"
echo "  Set VOICE_MODE=real and VOCAL_BRIDGE_AGENT_ID=$AGENT_ID in .env, then"
echo "  place a test call:  bash vocalbridge/place-call.sh +1YOURPHONE"
