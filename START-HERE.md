# Disruption Rescue — START HERE (read this first, all 3 of you)

**Goal:** in 60 minutes, demo one cancelled flight becoming one phone call — fully rebooked, fully reimbursed.

**Core rule:** we are building a *demo*, not a product. One golden path. A few things real, everything else convincingly mocked behind clean interfaces. A demo that runs flawlessly beats an ambitious one that stutters.

---

## The golden path (the ONLY flow we demo)

1. Dashboard shows: **Tracking AA123 DFW→LGA — On Time**
2. Click **Simulate Cancellation** → status flips red: *Cancelled (controllable, overnight strand)*
3. System auto-calls the traveler. Voice agent explains what happened and reads 3 rebooking options. Traveler says *"option two."*
4. UI: **Rebooked on AA456. Fare difference $0 settled.** New PNR shown.
5. Traveler uploads a hotel photo + a dinner receipt photo.
6. Receipts get read into line items; a claim auto-builds: **owed $247** (hotel $189 + meal $58).
7. UI: **✓ $247 sent to traveler's PayPal.** Done.

Everything you build serves this 90-second story. If it's not on this path, don't build it.

---

## Stack (no debate)

- **One Next.js app** (App Router, TypeScript). Frontend + `/api/*` backend in one repo, one language.
- Run **locally** on Person 1's laptop for the demo. Do **not** deploy.
- Only exception: the voice call needs a public URL, so Person 2 runs `ngrok` for their webhook.

## Shared environment

- One GitHub repo, work on `main`, **own your folders** (don't branch — not worth it at this timescale).
- One shared `.env` posted in the group chat. Same keys for everyone.
- Sponsor API keys (Sabre, Vocal Bridge, LandingAI, PayPal) go in `.env` — grab them from the hackathon dashboard at minute 0.
- Everyone on one voice channel the whole time.

## Folder ownership

```
/app
  /page.tsx              → Person 1 (dashboard + orchestration)
  /api
    /rebook              → Person 2
    /voice               → Person 2
    /receipts            → Person 3
    /claim               → Person 3
    /payout              → Person 3
    /payment             → Person 3
/lib
  /contracts.ts          → FROZEN. shared by all. see below.
  /mocks.ts              → shared mock data
```

---

## THE FROZEN CONTRACT (copy of /lib/contracts.ts)

Every endpoint speaks these exact shapes. **Do not change a field without telling the other two.** This is what makes our work combine on the first try. Paste this into your AI agent so it builds to the same seams.

```ts
// /lib/contracts.ts — FROZEN

export interface Flight {
  flightNumber: string;   // "AA123"
  carrier: string;        // "American Airlines"
  date: string;           // "2026-07-18"
  origin: string;         // "DFW"
  destination: string;    // "LGA"
  scheduledDep: string;   // ISO 8601
  scheduledArr: string;   // ISO 8601
}

export interface Traveler {
  name: string;
  phone: string;          // E.164, e.g. "+14155550123"
  paypalId: string;       // sandbox receiver email
  homeAirport: string;    // "DFW"
}

export interface DisruptionEvent {
  flight: Flight;
  traveler: Traveler;
  reason: "controllable_cancellation" | "controllable_delay" | "diversion";
  strandedOvernight: boolean;
}

export interface RebookOption {
  id: string;             // "opt_1"
  carrier: string;
  flightNumber: string;
  depTime: string;        // ISO
  arrTime: string;        // ISO
  fareDifference: number; // USD, 0 for a free controllable rebook
}

export interface Confirmation {
  newPNR: string;
  chosenOption: RebookOption;
  fareDifferenceSettled: boolean;
}

export interface ReceiptExtract {
  merchant: string;
  date: string;                    // "2026-07-18"
  total: number;                   // USD
  category: "hotel" | "meal" | "ground_transport" | "other";
}

export interface ReceiptClaim {
  items: ReceiptExtract[];
  owedTotal: number;
  commitmentsMet: string[];        // ["hotel","meal"]
}

export interface PayoutResult {
  status: "sent" | "failed";
  amount: number;
  paypalTxnId: string;
}
```

## The API surface (who owns what)

| Endpoint | In → Out | Owner |
|---|---|---|
| `POST /api/rebook` | `DisruptionEvent` → `RebookOption[]` | Person 2 |
| `POST /api/voice/call` | `{ event, options }` → starts call | Person 2 |
| `POST /api/voice/webhook` | Vocal Bridge callback (voice pick) | Person 2 |
| `POST /api/rebook/confirm` | `{ option, traveler }` → `Confirmation` | Person 2 |
| `POST /api/receipts` | image (multipart) → `ReceiptExtract` | Person 3 |
| `POST /api/claim` | `{ receipts, event }` → `ReceiptClaim` | Person 3 |
| `POST /api/payout` | `{ claim, traveler }` → `PayoutResult` | Person 3 |
| `POST /api/payment/fare-difference` | `{ amount, traveler }` → `PayoutResult` | Person 3 |

**Person 1 orchestrates in this order:**
`/api/rebook` → (voice pick) → `/api/rebook/confirm` → `/api/receipts` → `/api/claim` → `/api/payout`

---

## Real vs mock (decided — don't relitigate)

| Piece | Real or Mock | Note |
|---|---|---|
| Flight status trigger | **Mock** | The "Simulate Cancellation" button *is* the trigger |
| LandingAI receipts | **REAL** | Fast, visual, it's our differentiator |
| Vocal Bridge call | **Real, with scripted fallback** | Our wow moment; keep a transcript backup |
| Sabre flight search | **Mock** | 3 canned realistic AA options in `/lib/mocks.ts` |
| PayPal payouts | **Mock unless sandbox is trivial** | "✓ $247 sent" reads the same to a judge |

---

## 60-minute timeline

- **0–10 (together):** grab API keys, Person 1 scaffolds + pushes repo, freeze `contracts.ts`, everyone clones. Reread the golden path.
- **10–45 (heads down, parallel):** each person builds their slice against the frozen contract, tested in isolation.
- **45–55 (integrate):** Person 1 chains all endpoints. First full run. Fix breaks.
- **55–60 (rehearse):** run the demo 2–3 times end to end. This is where you win.

## Dependency map (nobody blocks anybody)

- **Person 3** = fully independent. Build first, hand off endpoints.
- **Person 2** depends only on Person 3's `/api/payment/fare-difference` (one call).
- **Person 1** depends on both, but only at minute 45. Until then, builds the whole UI against hardcoded fake objects.
