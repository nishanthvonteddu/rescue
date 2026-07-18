// POST /api/rebook/confirm  (Person 2)
// In:  { option: RebookOption, traveler: Traveler }
// Out: Confirmation  { newPNR, chosenOption, fareDifferenceSettled }
//
// Mints a fake PNR. If the chosen option carries a fare difference, we settle it
// by calling Person 3's POST /api/payment/fare-difference — we do NOT touch PayPal
// ourselves. For a $0 controllable rebook (the golden path) there's nothing to
// settle, so fareDifferenceSettled is trivially true.

import { NextResponse } from "next/server";
import type { Confirmation, RebookOption, Traveler } from "@/lib/contracts";
import { sampleTraveler } from "@/lib/mocks";

// Unambiguous PNR alphabet (no 0/O/1/I).
const PNR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makePNR(): string {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += PNR_ALPHABET[Math.floor(Math.random() * PNR_ALPHABET.length)];
  }
  return s;
}

// Call Person 3 to charge/settle the fare difference. Returns true on a "sent"
// payout. Non-fatal: if Person 3 isn't up yet during isolated testing, we log and
// report the delta as unsettled rather than blowing up the whole confirm.
async function settleFareDifference(
  req: Request,
  amount: number,
  traveler: Traveler,
): Promise<{ settled: boolean; detail: unknown }> {
  const url = new URL("/api/payment/fare-difference", req.url).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, traveler }),
    });
    const detail = await res.json().catch(() => ({}));
    const settled = res.ok && (detail as { status?: string }).status === "sent";
    if (!settled) {
      console.warn(
        `[rebook/confirm] fare-difference not settled (status ${res.status})`,
        detail,
      );
    }
    return { settled, detail };
  } catch (err) {
    console.warn(
      "[rebook/confirm] fare-difference call failed (Person 3 endpoint unreachable):",
      err instanceof Error ? err.message : err,
    );
    return { settled: false, detail: { error: String(err) } };
  }
}

export async function POST(req: Request) {
  let body: { option?: RebookOption; traveler?: Traveler } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }

  const option = body.option;
  if (!option || typeof option.fareDifference !== "number") {
    return NextResponse.json(
      { error: "Missing or invalid `option` (a RebookOption is required)." },
      { status: 400 },
    );
  }
  const traveler = body.traveler ?? sampleTraveler;

  let fareDifferenceSettled = true; // nothing to settle for a $0 rebook
  let paymentDetail: unknown = null;

  if (option.fareDifference > 0) {
    const r = await settleFareDifference(req, option.fareDifference, traveler);
    fareDifferenceSettled = r.settled;
    paymentDetail = r.detail;
  }

  const confirmation: Confirmation = {
    newPNR: makePNR(),
    chosenOption: option,
    fareDifferenceSettled,
  };

  // Contract fields first; `_payment` is extra debug context Person 1 can ignore.
  return NextResponse.json({ ...confirmation, _payment: paymentDetail });
}
