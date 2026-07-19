// GET  /api/agent/status — poll the agent run: status + live feed + results.
// POST /api/agent/status { reset: true } — clear state between demo runs.

import { NextResponse } from "next/server";
import {
  getAgentRun,
  resetAgentRun,
  isConfiguredAgent,
  geminiKeys,
  geminiModel,
} from "@/lib/agent";
import { resetReceiptsInbox } from "@/lib/receiptsInbox";

export const runtime = "nodejs";

export async function GET() {
  const r = getAgentRun();
  return NextResponse.json({
    configured: isConfiguredAgent(),
    keyCount: geminiKeys().length,
    model: geminiModel(),
    status: r.status,
    live: r.live,
    mode: r.mode,
    origin: r.origin,
    destination: r.destination,
    log: r.log,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error: r.error,
    event: r.event,
    options: r.options,
    confirmation: r.confirmation,
    receipts: r.receipts,
    claim: r.claim,
    payout: r.payout,
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
  if (reset) {
    resetAgentRun();
    resetReceiptsInbox();
  }
  return NextResponse.json({ ok: true, status: getAgentRun().status });
}
