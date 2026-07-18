# Person 2 — Rebook + Voice (Sabre mock + Vocal Bridge)

> Paste this whole file into your AI coding agent, plus the frozen contract from START-HERE.md. You own the wow moment: the phone call.

## Your role in one line
When a flight cancels, you call the traveler, read them 3 options, and capture their pick by voice.

## Where you sit in the golden path
Steps **2b and 3**: the outbound call, the voice pick, the rebook confirm. You do **not** touch PayPal — you call Person 3's fare-difference endpoint for any price delta.

## Deliverables

### 1. `POST /api/rebook` — mocked Sabre
- In: `DisruptionEvent`. Out: `RebookOption[]` (exactly 3).
- **Hardcode** 3 realistic American Airlines options in `/lib/mocks.ts`. Do NOT wire real Sabre Bargain Finder Max — auth + parsing will eat your hour and it isn't visual.
- Make them believable, e.g.:
  - `opt_1` AA456 DFW→LGA dep 6:10am arr 10:30am, fareDifference 0
  - `opt_2` AA512 DFW→LGA dep 8:45am arr 1:05pm, fareDifference 0
  - `opt_3` AA/partner via CLT, dep 7:00am arr 12:40pm, fareDifference 45
- For a controllable cancellation, same-airline rebooking is free — keep most at `fareDifference: 0`. That matches the DOT-commitment story.

### 2. `POST /api/voice/call` — Vocal Bridge outbound (REAL)
- In: `{ event, options }`. Triggers a Vocal Bridge outbound call to `traveler.phone`.
- The agent script: greet by name → "Your flight AA123 was cancelled by the airline. I can rebook you right now." → read the 3 options → "Which would you like — one, two, or three?"
- Vocal Bridge makes a **tool call back into your backend** with the chosen option id → that hits `/api/voice/webhook`.
- **Check the Vocal Bridge docs for exact call-creation + tool-call syntax and auth** (from the hackathon dashboard). Don't guess the API shape — read it.
- Run **`ngrok http 3000`** and put the public URL where Vocal Bridge needs the webhook, so their servers can reach your laptop.

### 3. `POST /api/voice/webhook` — receive the pick
- Vocal Bridge posts the chosen option id here. Store it (a simple in-memory variable or a shared store Person 1 can poll) so the orchestrator knows the traveler chose `opt_2`.

### 4. `POST /api/rebook/confirm`
- In: `{ option: RebookOption, traveler }`. Out: `Confirmation`.
- Generate a fake `newPNR` (e.g. random 6 chars).
- If `option.fareDifference > 0`, call **`POST /api/payment/fare-difference`** (Person 3) with `{ amount, traveler }`, then set `fareDifferenceSettled: true`.
- Return the `Confirmation`.

## THE FALLBACK (build this too — non-negotiable)
Live phone calls flake on stage. Build a **scripted transcript mode**: a function that returns the same call as on-screen text with a hardcoded pick of `opt_2`, so Person 1 can show the exact same flow if the real call fails. Wire it behind a flag Person 1 can flip.

## How to test in isolation
- Test `/api/rebook` with curl → confirm 3 options in the contract shape.
- Test the real call by dialing **your own phone number** — set `traveler.phone` to yourself.
- Test `/api/rebook/confirm` with curl using a mock option that has `fareDifference: 45` to confirm the Person 3 call fires.

## Definition of done
- [ ] `/api/rebook` returns 3 valid `RebookOption`s
- [ ] Real call reaches a phone, reads options, captures a spoken pick
- [ ] Scripted-transcript fallback works with one flag
- [ ] `/api/rebook/confirm` returns a `Confirmation` and settles any fare difference via Person 3

## Guardrails
- Real Sabre = out of scope. Mock the options.
- Don't build PayPal yourself. One call to Person 3 for the fare difference.
- Have the fallback ready before you polish the real call.
