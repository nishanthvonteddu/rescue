// POST /api/voice/webhook  (Person 2)
// Vocal Bridge tool-calls this when the traveler picks an option. We extract the
// chosen option id (payload shapes vary between providers, so we dig defensively),
// resolve it against the options presented on the current call, store it, and
// reply with a short line the voice agent can read back to confirm.

import { NextResponse } from "next/server";
import { getVoiceState, setVoiceState, resolvePick } from "@/lib/store";
import { rebookOptions } from "@/lib/mocks";
import { fmtTime } from "@/lib/voiceScript";

// Field names a voice platform might carry the pick under.
const PICK_KEYS = [
  "optionId",
  "option_id",
  "chosenOptionId",
  "option",
  "choice",
  "selection",
  "answer",
  "value",
];

// Walk an arbitrary payload looking for a pick value. Handles nested tool-call
// envelopes and stringified JSON `arguments`.
function extractPick(payload: unknown, depth = 0): string | null {
  if (payload == null || depth > 6) return null;

  if (typeof payload === "string") {
    // Might be a stringified JSON arguments blob.
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractPick(JSON.parse(trimmed), depth + 1);
      } catch {
        /* not JSON — fall through */
      }
    }
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractPick(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // Direct hit on a known key.
    for (const key of PICK_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    // Common nesting: { arguments }, { function: { arguments } }, { tool_call },
    // { message: { tool_calls: [...] } }, { data }, { parameters }, { input }.
    for (const key of [
      "arguments",
      "function",
      "tool_call",
      "toolCall",
      "tool_calls",
      "toolCalls",
      "message",
      "data",
      "parameters",
      "params",
      "input",
      "payload",
      "body",
      "result",
    ]) {
      if (key in obj) {
        const found = extractPick(obj[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

async function readPayload(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return req.json().catch(() => ({}));
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return {};
    return Object.fromEntries(form.entries());
  }
  // Try JSON, then fall back to raw text.
  const text = await req.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const payload = await readPayload(req);

  // Log the raw shape so we can see exactly what Vocal Bridge sends.
  console.log(
    "[voice/webhook] incoming",
    JSON.stringify({
      ct: req.headers.get("content-type"),
      query,
      payload,
    }).slice(0, 800),
  );

  // Look in the body AND the query string (some tool executors send params there).
  const raw = extractPick(payload) ?? extractPick(query);

  const state = getVoiceState();
  // Fall back to the canned options if the store hasn't been seeded (e.g. the
  // webhook is exercised directly during testing).
  const options = state.options.length ? state.options : rebookOptions;

  const chosen = raw ? resolvePick(raw, options) : null;

  if (!chosen) {
    return NextResponse.json(
      {
        ok: false,
        error: "Could not resolve a rebooking choice from the payload.",
        received: raw,
      },
      { status: 422 },
    );
  }

  setVoiceState({
    status: "picked",
    chosenOptionId: chosen.id,
    chosenOption: chosen,
    options,
  });

  // A spoken confirmation the agent can read back to the traveler.
  const spoken = `Got it — I've booked you on ${chosen.carrier} ${chosen.flightNumber}, arriving ${fmtTime(chosen.arrTime)}. You're all set.`;

  return NextResponse.json({
    ok: true,
    chosenOptionId: chosen.id,
    chosenOption: chosen,
    // Various keys so whichever field Vocal Bridge reads back is populated.
    message: spoken,
    speech: spoken,
    say: spoken,
  });
}

// Health check / GET probe.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "voice/webhook" });
}
