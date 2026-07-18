// POST /api/voice/call  (Person 2)  — the wow moment.
// In:  { event: DisruptionEvent, options: RebookOption[], mode?: "real" | "mock" }
// Out: { mode, status, callId?, transcript, chosenOptionId?, webhookUrl }
//
// Two modes, one interface:
//   • "real" — places a live Vocal Bridge outbound call to traveler.phone. The
//     traveler's spoken pick arrives later at /api/voice/webhook.
//   • "mock" — THE FALLBACK. Renders the exact same call as a scripted transcript
//     and records a hardcoded pick (opt_2) into the store, so Person 1 can show
//     the identical flow if the live call flakes on stage.
//
// Mode selection (so Person 1 has one flag to flip):
//   body.mode  >  ?mode=  >  env VOICE_MODE  >  default "mock" (demo-safe).
// If a real call throws and VOICE_AUTO_FALLBACK !== "false", we auto-run mock so
// the on-screen flow still completes.

import { NextResponse } from "next/server";
import type { DisruptionEvent, RebookOption } from "@/lib/contracts";
import { rebookOptions, sampleEvent, DEFAULT_PICK_ID } from "@/lib/mocks";
import { resetVoiceState, setVoiceState, resolvePick } from "@/lib/store";
import { buildTranscript } from "@/lib/voiceScript";
import { placeCall, isConfigured } from "@/lib/vocalbridge";

type Mode = "real" | "mock";

function pickMode(bodyMode: unknown, url: URL): Mode {
  const q = url.searchParams.get("mode");
  const raw = (bodyMode ?? q ?? process.env.VOICE_MODE ?? "mock").toString().toLowerCase();
  return raw === "real" ? "real" : "mock";
}

function publicBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_BASE_URL || process.env.NGROK_URL || "";
  const base = fromEnv || new URL(req.url).origin;
  return base.replace(/\/$/, "");
}

// The FALLBACK path: build the scripted transcript and record the pick.
function runMock(
  event: DisruptionEvent,
  options: RebookOption[],
  pickId: string,
) {
  const transcript = buildTranscript(event, options, pickId);
  const chosen = resolvePick(pickId, options) ?? options[1] ?? options[0];

  resetVoiceState();
  setVoiceState({ mode: "mock", options, transcript, status: "calling" });

  const delay = parseInt(process.env.VOICE_MOCK_DELAY_MS || "0", 10);
  const commit = () =>
    setVoiceState({
      status: "picked",
      chosenOptionId: chosen.id,
      chosenOption: chosen,
    });

  if (delay > 0) {
    // Let the orchestrator observe "calling" -> "picked".
    setTimeout(commit, delay);
    return { transcript, chosenOptionId: chosen.id, status: "calling" as const };
  }
  commit();
  return { transcript, chosenOptionId: chosen.id, status: "picked" as const };
}

export async function POST(req: Request) {
  const url = new URL(req.url);

  let body: {
    event?: DisruptionEvent;
    options?: RebookOption[];
    mode?: Mode;
    pickId?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — fall back to demo defaults */
  }

  const event = body.event ?? sampleEvent;
  const options =
    body.options && body.options.length ? body.options : rebookOptions;
  const mode = pickMode(body.mode, url);
  const pickId = body.pickId || DEFAULT_PICK_ID;
  const webhookUrl = `${publicBaseUrl(req)}/api/voice/webhook`;

  // ---- MOCK (fallback) ----
  if (mode === "mock") {
    const r = runMock(event, options, pickId);
    return NextResponse.json({ mode: "mock", webhookUrl, ...r });
  }

  // ---- REAL ----
  if (!isConfigured()) {
    // Asked for real but no key — behave gracefully for the demo.
    const autoFallback = process.env.VOICE_AUTO_FALLBACK !== "false";
    if (autoFallback) {
      const r = runMock(event, options, pickId);
      return NextResponse.json({
        mode: "mock",
        webhookUrl,
        fellBackFrom: "real",
        reason: "VOCAL_BRIDGE_API_KEY not set",
        ...r,
      });
    }
    return NextResponse.json(
      { error: "VOCAL_BRIDGE_API_KEY not set; cannot place a real call." },
      { status: 400 },
    );
  }

  try {
    resetVoiceState();
    setVoiceState({ mode: "real", options, status: "calling" });
    const { callId } = await placeCall({ event, options, webhookUrl });
    setVoiceState({ callId });
    return NextResponse.json({
      mode: "real",
      status: "calling",
      callId,
      webhookUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const autoFallback = process.env.VOICE_AUTO_FALLBACK !== "false";
    if (autoFallback) {
      const r = runMock(event, options, pickId);
      return NextResponse.json({
        mode: "mock",
        webhookUrl,
        fellBackFrom: "real",
        reason: message,
        ...r,
      });
    }
    setVoiceState({ status: "failed" });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
