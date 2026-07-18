# Person 3 — Receipts + Money (LandingAI real + PayPal)

> Paste this whole file into your AI coding agent, plus the frozen contract from START-HERE.md. You own the most self-contained slice — build and test it entirely alone, then hand over endpoints.

## Your role in one line
Turn photographed receipts into a claim, and move all the money.

## Where you sit in the golden path
Steps **5, 6, 7**: read receipts → build the claim → pay the traveler. You also own the fare-difference charge that Person 2 calls.

## Deliverables

### 1. `POST /api/receipts` — LandingAI extraction (REAL — this is our differentiator)
- In: an uploaded receipt image (multipart/form-data). Out: one `ReceiptExtract`.
- Use **LandingAI Agentic Document Extraction** to pull `merchant`, `date`, `total`, and infer `category` (`hotel` / `meal` / `ground_transport` / `other`).
- **Check the LandingAI docs for the exact endpoint + auth** (key from the hackathon dashboard). Don't guess the request shape — read it. Then map their response fields onto our `ReceiptExtract`.
- Have 2 sample receipt images ready in the repo (a hotel folio + a restaurant bill) so you can test without a phone.

### 2. `POST /api/claim` — build the claim
- In: `{ receipts: ReceiptExtract[], event: DisruptionEvent }`. Out: `ReceiptClaim`.
- Logic: sum `total` across receipts → `owedTotal`. Collect the distinct categories that match the airline's commitments (hotel, meal) → `commitmentsMet`.
- This is where you encode the story: "under a controllable overnight cancellation, American owes meals + hotel, so this $247 is owed."

### 3. `POST /api/payout` — PayPal reimbursement
- In: `{ claim: ReceiptClaim, traveler }`. Out: `PayoutResult`.
- Send `claim.owedTotal` to `traveler.paypalId`.
- **PayPal Payouts sandbox** if you can get it working fast; otherwise return a realistic mock `PayoutResult` with `status: "sent"` and a fake `paypalTxnId`. A judge can't tell the difference on screen — don't burn 30 minutes on OAuth.

### 4. `POST /api/payment/fare-difference` — the other money flow
- In: `{ amount, traveler }`. Out: `PayoutResult`.
- Called by Person 2 when a rebook has a fare difference. Same real-or-mock decision as payout — keep both consistent.

## How to test in isolation (you can finish before anyone else)
```
# receipts
curl -F "file=@sample-hotel.jpg" localhost:3000/api/receipts
# claim
curl -X POST localhost:3000/api/claim -H "Content-Type: application/json" \
  -d '{"receipts":[{"merchant":"Hilton","date":"2026-07-18","total":189,"category":"hotel"},
                    {"merchant":"Olive Garden","date":"2026-07-18","total":58,"category":"meal"}],
       "event":{...}}'
# payout
curl -X POST localhost:3000/api/payout -H "Content-Type: application/json" \
  -d '{"claim":{"items":[],"owedTotal":247,"commitmentsMet":["hotel","meal"]},
       "traveler":{"paypalId":"sb-buyer@example.com","name":"..."}}'
```
Confirm every response matches the contract shape before you hand off. If curl returns the right JSON, Person 1's integration will just work.

## Definition of done
- [ ] `/api/receipts` really reads an uploaded receipt via LandingAI into `ReceiptExtract`
- [ ] `/api/claim` returns `owedTotal` + `commitmentsMet`
- [ ] `/api/payout` and `/api/payment/fare-difference` both return `PayoutResult`
- [ ] All four verified with curl against the contract

## Guardrails
- Make LandingAI **real** — it's fast and it's the differentiator. Don't mock it.
- PayPal can be mocked if the sandbox fights you. Decide by minute 30 and move on.
- Keep payout and fare-difference identical in style so there's no second PayPal debugging session.
