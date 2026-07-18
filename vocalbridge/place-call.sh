#!/usr/bin/env bash
# vocalbridge/place-call.sh — place a real outbound Vocal Bridge call.
# Usage:  bash vocalbridge/place-call.sh [+1E164PHONE]
#         (defaults to DEMO_TRAVELER_PHONE from .env)
#
# Only call numbers you have consent to call (TCPA/TSR — you certified this when
# you accepted the outbound ToU). Rate limits: 50/day per agent, 200/day per user.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
VB="${VOCAL_BRIDGE_CLI:-vb}"
: "${VOCAL_BRIDGE_API_KEY:?Set VOCAL_BRIDGE_API_KEY in .env}"
export VOCAL_BRIDGE_API_KEY
export VOCAL_BRIDGE_API_URL="${VOCAL_BRIDGE_BASE_URL:-https://vocalbridgeai.com}"

PHONE="${1:-${DEMO_TRAVELER_PHONE:-}}"
: "${PHONE:?Pass a phone number (E.164) or set DEMO_TRAVELER_PHONE in .env}"

# Ensure the right agent is the selected default (no top-level --agent flag exists).
[ -n "${VOCAL_BRIDGE_AGENT_ID:-}" ] && "$VB" agent use "$VOCAL_BRIDGE_AGENT_ID" >/dev/null 2>&1 || true

echo "▸ Calling $PHONE via agent ${VOCAL_BRIDGE_AGENT_ID:-<default>}…"
"$VB" call "$PHONE" --json
