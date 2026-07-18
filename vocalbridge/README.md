# Vocal Bridge — real outbound call (Person 2)

The live phone call is **agent-centric**: you configure one Vocal Bridge agent
(prompt + outbound greeting + a `submit_choice` HTTP tool that POSTs the pick to
our webhook), then dial it with `vb call`. The app's `/api/voice/call` shells out
to `vb call` in `real` mode; in `mock` mode it plays the scripted fallback.

## Files here
- `agent-prompt.txt` — the agent's system prompt (reads the 3 options, asks 1/2/3, calls `submit_choice`)
- `outbound-greeting.txt` — the opening line when the traveler answers
- `api-tools.template.json` — the `submit_choice` HTTP tool (`$PUBLIC_BASE_URL` filled in at setup)
- `gen-config.mjs` — regenerates the three files above from the frozen options
- `setup-agent.sh` — creates + configures + deploys the agent (one command)
- `place-call.sh` — places a real call: `bash vocalbridge/place-call.sh +1YOURPHONE`

## Prerequisites (the real blockers)
1. **Paid Vocal Bridge plan.** `vb agent create` and `--deploy-targets phone` are
   paid-only; outbound needs an active Pilot subscription. The account key we have
   is authenticated but currently has **0 agents** and can't create one on a free plan.
2. **`vb` CLI** installed and on PATH: `pip install vocal-bridge` (v0.23.0+).
   (Override the binary path with `VOCAL_BRIDGE_CLI` if it's in a venv.)
3. **A public HTTPS URL** so Vocal Bridge's `submit_choice` tool can reach this
   laptop: `ngrok http 3000` → put the https URL in `.env` as `PUBLIC_BASE_URL`.
4. **Consent** to call the number (TCPA/TSR). Use your own phone to test.

## Go-live steps
```bash
# 0) one-time
pip install vocal-bridge
vb auth login vb_your_key            # or rely on VOCAL_BRIDGE_API_KEY in .env

# 1) expose the app
npm run dev                          # app on :3000
ngrok http 3000                      # copy the https URL

# 2) fill .env
#    VOCAL_BRIDGE_API_KEY=vb_...
#    PUBLIC_BASE_URL=https://<your>.ngrok-free.app
#    DEMO_TRAVELER_PHONE=+1YOURPHONE

# 3) create + configure the agent (paid plan)
bash vocalbridge/setup-agent.sh
#    → prints an agent id; add VOCAL_BRIDGE_AGENT_ID=<id> to .env

# 4) flip to real and place a call
#    set VOICE_MODE=real in .env, restart the app
bash vocalbridge/place-call.sh +1YOURPHONE     # direct CLI test
# or drive it through the app:
curl -X POST localhost:3000/api/voice/call -H 'content-type: application/json' -d '{"mode":"real"}'
```

When the traveler says "two", the agent calls `submit_choice{ optionId: "opt_2" }`,
Vocal Bridge POSTs it to `PUBLIC_BASE_URL/api/voice/webhook`, and Person 1's
orchestrator sees `status: picked` at `/api/voice/status`.

## Two things we learned the hard way (both already baked in here)
1. **Custom HTTP API tools are BACKGROUND-AI tools, not realtime tools.** The voice
   model's direct tool list is fixed (`end_call`, `submit_background_query`, …) and
   does NOT include `submit_choice`. If the prompt tells the agent to "call
   submit_choice", it fails with *"Unknown function: submit_choice"*. Instead the
   agent must delegate: call `submit_background_query` with an instruction like
   *"Call submit_choice with optionId opt_2"*, and the background AI invokes the
   HTTP tool. The agent prompt (`agent-prompt.txt`) already does this.
2. **Each api-tool parameter needs a `location`** (`body` | `query` | `path` |
   `header`). Without it the argument is dropped and the webhook gets an empty body
   (→ 422). Ours uses `location: "body"` so `optionId` arrives as JSON.

Validate the whole background→tool→webhook path offline (no phone call) with:
```bash
vb mcp test "Record the traveler's choice by calling submit_choice with optionId opt_2."
# → our /api/voice/webhook should log {"optionId":"opt_2"} and status should flip to "picked"
```

## Notes
- If a real call fails or the plan isn't active, the app **auto-falls back** to the
  scripted transcript (`VOICE_AUTO_FALLBACK=true`), so the demo never dead-ends.
- The webhook URL on the agent (`vb config get api-tools`) must match your current
  public tunnel. Tunnel URLs change per run — re-run `setup-agent.sh` (or just
  `vb config set --api-tools-file vocalbridge/api-tools.json`) after starting a new tunnel.
- This session validated live against agent `Rescue Rebooking` (phone +14122036478)
  using a **Cloudflare quick tunnel** (`cloudflared tunnel --url http://localhost:3000`)
  because the reserved ngrok domain was already in use. cloudflared needs no account
  and avoids the ngrok one-agent limit — a good default.
- Watch a live call: `vb config set --debug-mode true` then `vb debug`.
- Tear down the provisioned agent/number when done: `vb agent delete <id>`.
