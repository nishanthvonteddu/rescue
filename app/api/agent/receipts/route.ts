// POST /api/agent/receipts — the UI drops the traveler's receipt data here for
// the agent's read_receipts tool, which is blocking on this inbox.
//   { receipts: ReceiptExtract[] } — extracts from the traveler's uploaded
//                                    photos (UI already ran them through
//                                    /api/receipts = real LandingAI)
//   { useBundled: true }          — traveler chose the bundled sample photos;
//                                    the agent will OCR those itself
//   { reset: true }               — clear between demo runs
// GET — inspect the inbox.

import { NextResponse } from "next/server";
import type { ReceiptExtract } from "@/lib/contracts";
import {
  getReceiptsInbox,
  setReceiptsInbox,
  resetReceiptsInbox,
} from "@/lib/receiptsInbox";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getReceiptsInbox());
}

export async function POST(req: Request) {
  let body: {
    receipts?: ReceiptExtract[];
    useBundled?: boolean;
    reset?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.reset) {
    return NextResponse.json(resetReceiptsInbox());
  }
  if (Array.isArray(body.receipts) && body.receipts.length) {
    return NextResponse.json(setReceiptsInbox({ receipts: body.receipts }));
  }
  if (body.useBundled) {
    return NextResponse.json(setReceiptsInbox({ useBundled: true }));
  }
  return NextResponse.json(
    { error: "expected { receipts: [...] }, { useBundled: true } or { reset: true }" },
    { status: 400 },
  );
}
