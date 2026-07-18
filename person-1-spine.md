# Person 1 — The Spine (Trigger + Orchestration + UI)

> Paste this whole file into your AI coding agent, plus the frozen contract from START-HERE.md. You are the integrator — the demo runs through your screen.

## Your role in one line
You build what the judge looks at, and you plug Person 2 and Person 3 together at the end.

## Where you sit in the golden path
You own steps **1, 2, 4, 6, 7** on screen, and the orchestration that calls everyone else. You are the conductor.

## Deliverables

### 1. Repo scaffold (do this FIRST, minute 0–10)
- `npx create-next-app` (TypeScript, App Router), push to GitHub, tell the others to clone.
- Create `/lib/contracts.ts` with the frozen shapes from START-HERE.md. **Commit and push it immediately** — this unblocks everyone.
- Create `/lib/mocks.ts` with a sample `DisruptionEvent` and a sample `Traveler` so you can build the UI before anyone else's endpoints exist.

### 2. The dashboard (`/app/page.tsx`)
A single screen with two states.

**Idle state:**
- A card: **Tracking AA123 · DFW → LGA · Fri Jul 18** with a green **On Time** pill.
- A big **Simulate Cancellation** button.

**Active state (after the button):** a vertical stepper that lights up stage by stage:
1. `Cancelled — controllable, overnight strand` (red)
2. `Calling traveler…` → then `Traveler picked Option 2`
3. `Rebooked on AA456 · new PNR ABC123 · fare difference $0 settled`
4. `Awaiting receipts` → upload widget appears
5. `Receipts read: Hilton $189 (hotel), Olive Garden $58 (meal)`
6. `Claim built — owed $247 against AA meal + hotel commitments`
7. `✓ $247 sent to traveler's PayPal` (green, celebratory)

Keep it clean and legible on a projector — big text, clear status colors, one column.

### 3. The orchestrator
On **Simulate Cancellation**, build a `DisruptionEvent` (from `/lib/mocks.ts`) and drive this sequence, updating the stepper after each call:

```
POST /api/rebook            (Person 2)  → RebookOption[]
POST /api/voice/call        (Person 2)  → triggers the phone call
   ...wait for the voice pick to come back (poll a status endpoint or use a shared in-memory store)
POST /api/rebook/confirm    (Person 2)  → Confirmation
--- traveler uploads receipts in your UI ---
POST /api/receipts (xN)     (Person 3)  → ReceiptExtract[]
POST /api/claim             (Person 3)  → ReceiptClaim
POST /api/payout            (Person 3)  → PayoutResult
```

## How to build in isolation (before others are done)
Every endpoint you call — stub it locally first. Return the shapes from the contract with hardcoded values. Build and polish the *entire* UI against stubs. When Person 2 and 3 hand you real endpoints at minute 45, you just swap the URLs. Your UI should never know the difference.

## Definition of done
- [ ] Repo pushed, `contracts.ts` frozen and shared by minute 10
- [ ] Idle → click → full stepper animates through all 7 stages
- [ ] Runs end to end with the other two's real endpoints
- [ ] Looks clean on a projector

## Guardrails
- Do **not** build flight-status polling. The button is the trigger. That's intentional.
- Keep all traveler/flight data in `/lib/mocks.ts` so the demo is deterministic.
- If an endpoint isn't ready at minute 50, fall back to your stub and move on. The show must run.
