// /lib/vocalbridge.ts — thin adapter around the Vocal Bridge outbound-call API.
//
// This is the ONE place that knows Vocal Bridge's wire format. Everything else
// (the route, the script, the store) is provider-agnostic. When you have the
// Vocal Bridge docs from the hackathon dashboard, you only touch this file:
// fix `buildCallRequest()` (the request body) and `parseCallId()` (the response
// field), and the rest of the slice keeps working.
//
// Env it reads (all from the shared .env):
//   VOCAL_BRIDGE_API_KEY      required — bearer/API key
//   VOCAL_BRIDGE_BASE_URL     e.g. https://api.vocalbridge.ai
//   VOCAL_BRIDGE_CALL_PATH    endpoint path for creating a call (default /v1/calls)
//   VOCAL_BRIDGE_FROM         caller id / from-number or phone-number id
//   VOCAL_BRIDGE_AGENT_ID     optional pre-built agent id, if you use one
//   VOCAL_BRIDGE_AUTH_HEADER  "Authorization" (default) or "x-api-key"
//   VOCAL_BRIDGE_AUTH_SCHEME  "Bearer" (default) or "" for a raw key

import type { DisruptionEvent, RebookOption } from "./contracts";
import { buildAgentPrompt, buildFirstMessage } from "./voiceScript";

export interface PlaceCallArgs {
  event: DisruptionEvent;
  options: RebookOption[];
  webhookUrl: string; // public https URL Vocal Bridge tool-calls back into
}

export interface PlaceCallResult {
  callId: string;
  raw: unknown; // full provider response, for debugging
}

export class VocalBridgeConfigError extends Error {}

export function isConfigured(): boolean {
  return Boolean(process.env.VOCAL_BRIDGE_API_KEY);
}

function cfg() {
  const apiKey = process.env.VOCAL_BRIDGE_API_KEY;
  if (!apiKey) {
    throw new VocalBridgeConfigError(
      "VOCAL_BRIDGE_API_KEY is not set — cannot place a real call. Set it in .env, or use mock mode.",
    );
  }
  return {
    apiKey,
    baseUrl: (process.env.VOCAL_BRIDGE_BASE_URL || "https://api.vocalbridge.ai").replace(/\/$/, ""),
    callPath: process.env.VOCAL_BRIDGE_CALL_PATH || "/v1/calls",
    from: process.env.VOCAL_BRIDGE_FROM || "",
    agentId: process.env.VOCAL_BRIDGE_AGENT_ID || "",
    authHeader: process.env.VOCAL_BRIDGE_AUTH_HEADER || "Authorization",
    authScheme: process.env.VOCAL_BRIDGE_AUTH_SCHEME ?? "Bearer",
  };
}

// The tool we expose to the voice agent: it calls this with the chosen option id,
// which Vocal Bridge delivers to our webhook. Shape follows the common
// JSON-Schema "function tool" convention; adjust to Vocal Bridge's exact spec.
export function buildSubmitChoiceTool(options: RebookOption[], webhookUrl: string) {
  return {
    type: "function",
    name: "submit_choice",
    description:
      "Record the rebooking option the traveler chose. Call this as soon as they pick one.",
    // Where Vocal Bridge should POST the tool call. Vocal Bridge tool/webhook
    // configs vary in field name (`url` / `server.url` / `webhook`); we set
    // several so the right one is picked up.
    url: webhookUrl,
    webhook: webhookUrl,
    server: { url: webhookUrl },
    parameters: {
      type: "object",
      properties: {
        optionId: {
          type: "string",
          enum: options.map((o) => o.id),
          description: "The chosen option id, e.g. opt_2",
        },
      },
      required: ["optionId"],
    },
  };
}

// Build the create-call request body. THIS is the field most likely to need a
// tweak against the real docs — keep the reshaping here.
export function buildCallRequest(args: PlaceCallArgs) {
  const c = cfg();
  const { event, options, webhookUrl } = args;
  const tool = buildSubmitChoiceTool(options, webhookUrl);

  const body: Record<string, unknown> = {
    to: event.traveler.phone,
    from: c.from || undefined,
    // Send the whole call config inline (no pre-built agent required):
    agent: {
      firstMessage: buildFirstMessage(event),
      prompt: buildAgentPrompt(event, options),
      voice: process.env.VOCAL_BRIDGE_VOICE || "default",
      tools: [tool],
    },
    // Also surface a few fields at top level, since some APIs expect them there:
    firstMessage: buildFirstMessage(event),
    prompt: buildAgentPrompt(event, options),
    tools: [tool],
    // Global fallback webhook for call events, in case tool-level url isn't used:
    webhookUrl,
    metadata: {
      flightNumber: event.flight.flightNumber,
      travelerName: event.traveler.name,
    },
  };
  if (c.agentId) body.agentId = c.agentId;

  return body;
}

export function parseCallId(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const candidate =
    r.id ??
    r.callId ??
    r.call_id ??
    (r.call as Record<string, unknown> | undefined)?.id ??
    (r.data as Record<string, unknown> | undefined)?.id;
  return candidate ? String(candidate) : `vb_${Date.now()}`;
}

export async function placeCall(args: PlaceCallArgs): Promise<PlaceCallResult> {
  const c = cfg();
  const url = `${c.baseUrl}${c.callPath}`;
  const body = buildCallRequest(args);

  const headers: Record<string, string> = { "content-type": "application/json" };
  headers[c.authHeader] = c.authScheme ? `${c.authScheme} ${c.apiKey}` : c.apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }

  if (!res.ok) {
    throw new Error(
      `Vocal Bridge call failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  return { callId: parseCallId(raw), raw };
}
