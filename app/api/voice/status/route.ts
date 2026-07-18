// GET /api/voice/status  (Person 2)
// Person 1's orchestrator polls this to learn the voice-call outcome:
//   status: "idle" | "calling" | "picked" | "failed"
//   chosenOptionId / chosenOption once the traveler decides.
//
// POST /api/voice/status  { reset: true }  clears state between demo runs.

import { NextResponse } from "next/server";
import { getVoiceState, resetVoiceState } from "@/lib/store";

export async function GET() {
  const s = getVoiceState();
  return NextResponse.json({
    status: s.status,
    mode: s.mode,
    callId: s.callId,
    chosenOptionId: s.chosenOptionId,
    chosenOption: s.chosenOption,
    options: s.options,
    transcript: s.transcript,
    updatedAt: s.updatedAt,
  });
}

export async function POST(req: Request) {
  let reset = true;
  try {
    const body = await req.json();
    reset = body?.reset !== false;
  } catch {
    /* default to reset */
  }
  if (reset) resetVoiceState();
  return NextResponse.json(getVoiceState());
}
