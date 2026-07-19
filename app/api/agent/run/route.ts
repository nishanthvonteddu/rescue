// POST /api/agent/run — start an orchestration run.
// In:  { live?: boolean, mode?: "llm" | "direct", origin?: string, destination?: string }
//   mode "llm"    — Gemini decides + narrates every step (needs GEMINI_API_KEYS)
//   mode "direct" — the same pipeline with no LLM: fixed order, fixed narration
// Out: { started, status, mode, model, keyCount }  (409 if a run is in flight;
//       400 for llm mode with no keys — direct mode never needs keys)
//
// The loop runs server-side, fire-and-forget; the dashboard polls
// GET /api/agent/status for the live feed.

import { NextResponse } from "next/server";
import {
  getAgentRun,
  runAgent,
  runDirect,
  isConfiguredAgent,
  geminiKeys,
  geminiModel,
  type OrchestratorMode,
} from "@/lib/agent";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: {
    live?: boolean;
    mode?: OrchestratorMode;
    origin?: string;
    destination?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults are fine */
  }

  const mode: OrchestratorMode = body.mode === "direct" ? "direct" : "llm";

  if (mode === "llm" && !isConfiguredAgent()) {
    return NextResponse.json(
      {
        error:
          "No Gemini API keys configured. Add GEMINI_API_KEYS=key1,key2,key3 to .env — or run in direct mode (no LLM).",
      },
      { status: 400 },
    );
  }

  const current = getAgentRun();
  if (current.status === "running") {
    return NextResponse.json(
      { error: "a run is already in progress", status: current.status },
      { status: 409 },
    );
  }

  const base = new URL(req.url).origin;
  const opts = {
    live: Boolean(body.live),
    origin: body.origin,
    destination: body.destination,
  };
  if (mode === "direct") void runDirect(base, opts);
  else void runAgent(base, opts);

  return NextResponse.json({
    started: true,
    status: "running",
    mode,
    model: mode === "direct" ? "direct (no LLM)" : geminiModel(),
    keyCount: geminiKeys().length,
  });
}
