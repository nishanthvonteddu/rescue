// /lib/vocalbridge.ts — adapter around Vocal Bridge's REAL outbound-call model.
//
// Discovered from the live `vb` CLI + `vb docs` (v0.23.0):
//   • API host is https://vocalbridgeai.com; auth is the vb_ API key.
//   • Vocal Bridge is AGENT-CENTRIC. You don't pass the script/tools per call —
//     you configure ONE agent ahead of time with a system prompt, an outbound
//     greeting, and a "Custom HTTP API Tool" (submit_choice) that POSTs the
//     chosen option id to our /api/voice/webhook. See vocalbridge/setup-agent.sh.
//   • Placing the call is then just:  vb call <E.164-phone> --json
//   • Creating an agent + deploying on a phone number needs a PAID plan, and
//     outbound requires accepting the outbound ToU (--accept-outbound-tos).
//
// So at request time this module just shells out to `vb call`. Everything the
// agent says/does was baked onto the agent by the setup script. That keeps the
// hard parts (SIP, numbers, TCPA) inside Vocal Bridge where they belong.
//
// Env it reads:
//   VOCAL_BRIDGE_API_KEY   required — the vb_ key (agent- or account-scoped)
//   VOCAL_BRIDGE_CLI       path to the `vb` binary (default "vb" on PATH)
//   VOCAL_BRIDGE_AGENT_ID  optional — passed to `vb` for account-scoped keys
//                          (agent-scoped keys don't need it; or run `vb agent use` once)

import { execFile } from "node:child_process";
import type { DisruptionEvent, RebookOption } from "./contracts";

export interface PlaceCallArgs {
  event: DisruptionEvent;
  options?: RebookOption[]; // unused at call time (baked onto the agent) — kept for signature stability
  webhookUrl?: string; // ditto — configured on the agent, not per call
}

export interface PlaceCallResult {
  callId: string;
  raw: unknown; // full `vb call --json` payload, for debugging
}

export class VocalBridgeConfigError extends Error {}

export function isConfigured(): boolean {
  return Boolean(process.env.VOCAL_BRIDGE_API_KEY);
}

function cli() {
  const apiKey = process.env.VOCAL_BRIDGE_API_KEY;
  if (!apiKey) {
    throw new VocalBridgeConfigError(
      "VOCAL_BRIDGE_API_KEY is not set — cannot place a real call. Set it in .env, or use mock mode.",
    );
  }
  return {
    apiKey,
    bin: process.env.VOCAL_BRIDGE_CLI || "vb",
    agentId: process.env.VOCAL_BRIDGE_AGENT_ID || "",
    apiUrl: process.env.VOCAL_BRIDGE_BASE_URL || "https://vocalbridgeai.com",
  };
}

function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, timeout: 30_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `\`${bin} ${args.join(" ")}\` failed: ${err.message}\n${stderr || stdout}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseCallId(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const candidate =
    r.session_id ??
    r.sessionId ??
    r.call_id ??
    r.callId ??
    r.id ??
    (r.call as Record<string, unknown> | undefined)?.id ??
    (r.data as Record<string, unknown> | undefined)?.session_id;
  return candidate ? String(candidate) : `vb_call_${Date.now()}`;
}

// Place the real outbound call by shelling out to `vb call <phone> --json`.
// The agent (prompt, greeting, submit_choice tool) must already be configured
// and deployed on phone — run vocalbridge/setup-agent.sh once to do that.
export async function placeCall(args: PlaceCallArgs): Promise<PlaceCallResult> {
  const c = cli();
  const phone = args.event.traveler.phone;
  if (!/^\+\d{7,15}$/.test(phone)) {
    throw new Error(`Traveler phone is not valid E.164: "${phone}"`);
  }

  // Global --agent must precede the subcommand for account-scoped keys.
  const argv: string[] = [];
  if (c.agentId) argv.push("--agent", c.agentId);
  argv.push("call", phone, "--json");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VOCAL_BRIDGE_API_KEY: c.apiKey,
    VOCAL_BRIDGE_API_URL: c.apiUrl,
  };

  const { stdout } = await run(c.bin, argv, env);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = { text: stdout.trim() };
  }
  return { callId: parseCallId(raw), raw };
}
