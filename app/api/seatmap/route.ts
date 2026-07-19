// POST /api/seatmap — seat availability for a chosen rebooking option.
// In:  { option: RebookOption, date?: string, origin?: string, destination?: string }
// Out: SeatMapSummary — real cabin map when the Sabre credentials carry the
//      Seat Map product; otherwise { available:false, reason } plus the
//      fare-level availability we already know (seatsLeft), so callers can
//      always say something truthful about seats.

import { NextResponse } from "next/server";
import type { RebookOption } from "@/lib/contracts";
import { getSeatMap, isConfiguredSabre } from "@/lib/sabre";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: {
    option?: RebookOption;
    date?: string;
    origin?: string;
    destination?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.option) {
    return NextResponse.json({ error: "missing option" }, { status: 400 });
  }

  const fareLevel = {
    seatsLeftAtThisFare: body.option.seatsLeft ?? null,
    cabin: body.option.cabin ?? null,
    bookingCode: body.option.bookingCode ?? null,
  };

  if (!isConfiguredSabre()) {
    return NextResponse.json({
      available: false,
      reason: "Sabre not configured",
      ...fareLevel,
    });
  }

  const date = body.date || body.option.depTime.slice(0, 10);
  const summary = await getSeatMap(
    body.option,
    date,
    body.origin || "DFW",
    body.destination || "LGA",
  ).catch((e) => ({
    available: false as const,
    reason: e instanceof Error ? e.message : String(e),
  }));

  return NextResponse.json({ ...summary, ...fareLevel });
}
