// POST /api/rebook  (Person 2)
// In:  DisruptionEvent
// Out: RebookOption[]  (exactly 3)
//
// REAL Sabre (Bargain Finder Max) when SABRE_CLIENT_ID/SECRET are set: live
// shop of the event's origin→destination, top 3 itineraries, real fare deltas.
// Falls back to the canned options on any Sabre error so the demo never dies.
// The `x-rebook-source` header says which path served the request
// ("sabre_live" | "mock" | "mock_fallback").

import { NextResponse } from "next/server";
import type { DisruptionEvent, RebookOption } from "@/lib/contracts";
import { rebookOptions } from "@/lib/mocks";
import { isConfiguredSabre, searchRebookOptions } from "@/lib/sabre";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let event: Partial<DisruptionEvent> = {};
  try {
    event = (await req.json()) as Partial<DisruptionEvent>;
  } catch {
    // No/invalid body — fine, we can still search/mock the default route.
  }

  if (isConfiguredSabre()) {
    try {
      const options = await searchRebookOptions(event);
      return NextResponse.json(options, {
        headers: { "x-rebook-source": "sabre_live" },
      });
    } catch (err) {
      console.warn(
        "[rebook] Sabre live search failed — serving canned options:",
        err instanceof Error ? err.message : err,
      );
      const options: RebookOption[] = rebookOptions.map((o) => ({ ...o }));
      return NextResponse.json(options, {
        headers: { "x-rebook-source": "mock_fallback" },
      });
    }
  }

  // Return copies so a caller can't mutate the shared mock array.
  const options: RebookOption[] = rebookOptions.map((o) => ({ ...o }));
  return NextResponse.json(options, { headers: { "x-rebook-source": "mock" } });
}

// Convenience for eyeballing in a browser.
export async function GET() {
  return POST(new Request("http://internal/api/rebook", { method: "POST" }));
}
