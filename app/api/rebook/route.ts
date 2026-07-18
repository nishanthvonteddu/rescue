// POST /api/rebook  (Person 2)
// In:  DisruptionEvent
// Out: RebookOption[]  (exactly 3)
//
// This is the "mocked Sabre" search. Real Bargain Finder Max auth + parsing would
// eat the hour and isn't visual, so we return 3 believable canned AA options from
// /lib/mocks.ts. We echo the event's origin/destination into the options so they
// stay coherent even if Person 1 changes the demo route.

import { NextResponse } from "next/server";
import type { DisruptionEvent, RebookOption } from "@/lib/contracts";
import { rebookOptions } from "@/lib/mocks";

export async function POST(req: Request) {
  let event: Partial<DisruptionEvent> = {};
  try {
    event = (await req.json()) as Partial<DisruptionEvent>;
  } catch {
    // No/invalid body — fine, we return the canned options anyway (demo-safe).
  }

  // Return copies so a caller can't mutate the shared mock array.
  const options: RebookOption[] = rebookOptions.map((o) => ({ ...o }));

  return NextResponse.json(options);
}

// Convenience for eyeballing in a browser.
export async function GET() {
  return NextResponse.json(rebookOptions);
}
