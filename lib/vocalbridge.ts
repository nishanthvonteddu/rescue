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
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DisruptionEvent, RebookOption } from "./contracts";
import type { TranscriptLine } from "./store";
import { buildAgentPrompt } from "./voiceScript";

// Small wrapper so the prompt-sync path reads clearly above.
async function writePromptFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
}

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
// The agent (greeting, submit_choice tool) must already be configured and
// deployed on phone — run vocalbridge/setup-agent.sh once to do that.
//
// The system prompt, however, is pushed FRESH before every call: rebooking
// options now come from live Sabre, so the voice agent must read the same
// options the dashboard shows, not whatever was baked in at setup time.
export async function placeCall(args: PlaceCallArgs): Promise<PlaceCallResult> {
  const c = cli();
  const phone = args.event.traveler.phone;
  if (!/^\+\d{7,15}$/.test(phone)) {
    throw new Error(`Traveler phone is not valid E.164: "${phone}"`);
  }

  // Sync the agent's prompt to THIS call's options (live Sabre data).
  if (args.options?.length) {
    try {
      const prompt = buildAgentPrompt(args.event, args.options);
      const file = path.join(os.tmpdir(), "rescue-live-prompt.txt");
      await writePromptFile(file, prompt);
      await run(c.bin, ["prompt", "set", "--file", file], {
        ...process.env,
        VOCAL_BRIDGE_API_KEY: c.apiKey,
        VOCAL_BRIDGE_API_URL: c.apiUrl,
      });
    } catch (err) {
      // Non-fatal: worst case the agent reads the previously-set options.
      console.warn("[vocalbridge] prompt sync failed (using previous):", err);
    }
  }

  // The agent is selected as the on-disk default (run `vb agent use <id>` once —
  // setup-agent.sh does this). `vb` has no top-level --agent flag, so we rely on
  // that stored default; `vb call <phone>` then dials via the right agent.
  const argv: string[] = ["call", phone, "--json"];

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

// ---------------------------------------------------------------------------
// Call-session tracking (`vb logs show <id> --json`) — lets the server watch a
// live call's lifecycle and pull the REAL transcript once it ends, so the
// dashboard can sync to what was actually said on the phone.
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "abandoned"
  | "unknown";

export interface CallSession {
  status: SessionStatus;
  durationSeconds: number | null;
  endedAt: string | null;
  errorMessage: string | null;
  transcript: TranscriptLine[]; // parsed from transcript_text; [] until available
}

function vbEnv(c: ReturnType<typeof cli>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VOCAL_BRIDGE_API_KEY: c.apiKey,
    VOCAL_BRIDGE_API_URL: c.apiUrl,
  };
}

// "AGENT: …\n\nUSER: …\n\nTOOL CALL: …" -> TranscriptLine[].
// Prefix-less paragraphs continue the previous speaker's turn; TOOL blocks are
// internal noise and are skipped.
export function parseTranscriptText(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const m = b.match(/^(AGENT|USER|TOOL CALL|TOOL OUTPUT)(?:\s*\([^)]*\))?:\s*([\s\S]*)$/);
    if (m) {
      const [, who, rest] = m;
      if (who === "AGENT") lines.push({ speaker: "agent", text: rest.trim() });
      else if (who === "USER") lines.push({ speaker: "traveler", text: rest.trim() });
      // TOOL blocks: skip
    } else if (lines.length) {
      // continuation paragraph of the previous turn
      lines[lines.length - 1].text += `\n${b}`;
    }
  }
  return lines;
}

export async function getSession(callId: string): Promise<CallSession> {
  const c = cli();
  const { stdout } = await run(c.bin, ["logs", "show", callId, "--json"], vbEnv(c));
  const j = JSON.parse(stdout) as Record<string, unknown>;
  const rawStatus = String(j.call_status ?? j.status ?? "unknown").toLowerCase();
  const status: SessionStatus = (
    ["in_progress", "completed", "failed", "abandoned"] as const
  ).includes(rawStatus as never)
    ? (rawStatus as SessionStatus)
    : "unknown";
  return {
    status,
    durationSeconds:
      typeof j.duration_seconds === "number" ? j.duration_seconds : null,
    endedAt: j.ended_at ? String(j.ended_at) : null,
    errorMessage: j.error_message ? String(j.error_message) : null,
    transcript:
      typeof j.transcript_text === "string" && j.transcript_text
        ? parseTranscriptText(j.transcript_text)
        : [],
  };
}

// ---------------------------------------------------------------------------
// Hosted-agent webhook sync. The submit_choice HTTP tool lives ON the hosted
// agent with a baked-in URL; tunnel URLs rotate per run, so before each real
// call we verify the hosted URL matches PUBLIC_BASE_URL and re-push it if not.
// ---------------------------------------------------------------------------

// The exact webhook URL the hosted agent should POST picks to.
export function expectedWebhookUrl(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  const token = process.env.VOICE_WEBHOOK_TOKEN;
  return `${base}/api/voice/webhook${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export async function getHostedWebhookUrl(): Promise<string | null> {
  const c = cli();
  const { stdout } = await run(c.bin, ["config", "get", "api-tools"], vbEnv(c));
  try {
    const tools = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const t = tools.find((x) => x.id === "submit_choice" || x.name === "submit_choice");
    return t?.url ? String(t.url) : null;
  } catch {
    return null;
  }
}

// Render vocalbridge/api-tools.json from the template with the given URL and
// push it onto the hosted agent. Idempotent; ~1-2s.
export async function syncHostedWebhook(webhookUrl: string): Promise<void> {
  const c = cli();
  const dir = path.join(process.cwd(), "vocalbridge");
  const template = await readFile(path.join(dir, "api-tools.template.json"), "utf8");
  // The template pins $PUBLIC_BASE_URL/api/voice/webhook — swap the whole URL.
  const rendered = template.replaceAll(
    "$PUBLIC_BASE_URL/api/voice/webhook",
    webhookUrl,
  );
  const file = path.join(dir, "api-tools.json");
  await writeFile(file, rendered, "utf8");
  if (c.agentId) {
    await run(c.bin, ["agent", "use", c.agentId], vbEnv(c)).catch(() => {
      /* account-scoped default may already be set */
    });
  }
  await run(c.bin, ["config", "set", "--api-tools-file", file], vbEnv(c));
}
