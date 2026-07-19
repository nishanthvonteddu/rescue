// POST /api/voice/call  (Person 2)  — the wow moment.
// In:  { event: DisruptionEvent, options: RebookOption[], mode?: "real" | "mock",
//        preflightOnly?: boolean }
// Out: { mode, status, callId?, transcript, chosenOptionId?, webhookUrl }
//       (preflightOnly: { ready, checks } — verifies live-call plumbing, no dial)
//
// Two modes, one interface:
//   • "real" — places a live Vocal Bridge outbound call to traveler.phone. Before
//     dialing we PREFLIGHT the plumbing (hosted agent's submit_choice URL is
//     auto-synced to PUBLIC_BASE_URL; the tunnel is proven to loop back to THIS
//     server). After dialing, a server-side WATCHER polls the Vocal Bridge session
//     so the dashboard tracks the live call: status, duration, and — once the
//     call ends — the real transcript. If the call ends with no recorded pick,
//     state flips to "failed" so the UI can fall back honestly.
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
import {
  getVoiceState,
  resetVoiceState,
  setVoiceState,
  resolvePick,
  INSTANCE_ID,
} from "@/lib/store";
import { buildTranscript } from "@/lib/voiceScript";
import {
  placeCall,
  isConfigured,
  getSession,
  getHostedWebhookUrl,
  syncHostedWebhook,
  expectedWebhookUrl,
} from "@/lib/vocalbridge";

// Real mode shells out to the `vb` CLI, so this route must run on Node, not Edge.
export const runtime = "nodejs";

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

// ---------------------------------------------------------------------------
// PREFLIGHT — prove the live-call plumbing before dialing:
//   1. hosted agent's submit_choice URL === expected (auto-heal by re-pushing)
//   2. PUBLIC_BASE_URL loops back to THIS server process (instance-id echo)
// Cached briefly so repeat calls don't pay the ~2s CLI cost.
// ---------------------------------------------------------------------------

interface PreflightResult {
  ready: boolean;
  checks: {
    hostedWebhook: { ok: boolean; detail: string };
    tunnel: { ok: boolean; detail: string };
  };
}

const gp = globalThis as unknown as {
  __vbPreflight?: { at: number; expected: string; result: PreflightResult };
};

async function preflight(base: string, force = false): Promise<PreflightResult> {
  const expected = expectedWebhookUrl(base);
  const cached = gp.__vbPreflight;
  if (
    !force &&
    cached &&
    cached.expected === expected &&
    Date.now() - cached.at < 120_000 &&
    cached.result.ready
  ) {
    return cached.result;
  }

  // 1. hosted webhook URL — read, and re-push if it drifted (tunnel rotation).
  let hostedWebhook: PreflightResult["checks"]["hostedWebhook"];
  try {
    const current = await getHostedWebhookUrl();
    if (current === expected) {
      hostedWebhook = { ok: true, detail: "hosted agent webhook in sync" };
    } else {
      await syncHostedWebhook(expected);
      const after = await getHostedWebhookUrl();
      hostedWebhook =
        after === expected
          ? { ok: true, detail: `hosted agent webhook re-synced (was ${current ?? "unset"})` }
          : { ok: false, detail: `hosted webhook still ${after ?? "unset"} after sync` };
    }
  } catch (e) {
    hostedWebhook = {
      ok: false,
      detail: `could not read/sync hosted agent config: ${e instanceof Error ? e.message : e}`,
    };
  }

  // 2. tunnel loopback — our own webhook, reached via the public URL, must echo
  //    this process's instance id.
  let tunnel: PreflightResult["checks"]["tunnel"];
  try {
    const res = await fetch(`${base}/api/voice/webhook`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const j = (await res.json()) as { instanceId?: string };
    tunnel =
      res.ok && j.instanceId === INSTANCE_ID
        ? { ok: true, detail: "tunnel loops back to this server" }
        : {
            ok: false,
            detail: j.instanceId
              ? `tunnel reaches a DIFFERENT server (their id ${j.instanceId}, ours ${INSTANCE_ID}) — is another dev server behind the tunnel?`
              : `tunnel responded ${res.status} without an instance id`,
          };
  } catch (e) {
    tunnel = {
      ok: false,
      detail: `tunnel unreachable at ${base}: ${e instanceof Error ? e.message : e} — restart it (npm run voice:tunnel)`,
    };
  }

  const result: PreflightResult = {
    ready: hostedWebhook.ok && tunnel.ok,
    checks: { hostedWebhook, tunnel },
  };
  gp.__vbPreflight = { at: Date.now(), expected, result };
  return result;
}

// ---------------------------------------------------------------------------
// WATCHER — after dialing, poll the Vocal Bridge session so the store (and the
// polling dashboard) tracks the live call. On call end: pull the real
// transcript; if no pick was recorded, give the background tool a short grace
// window, then mark the call failed so the UI can fall back honestly.
// ---------------------------------------------------------------------------

const POLL_MS = 3_000;
const WATCH_MAX_MS = 5 * 60_000; // hard stop
const PICK_GRACE_MS = 15_000; // call ended, pick may still be in flight

function watchCall(callId: string) {
  const startedAt = Date.now();
  let endedWithoutPickAt: number | null = null;

  const tick = async () => {
    const state = getVoiceState();
    // A reset or a newer call supersedes this watcher.
    if (state.callId !== callId) return;
    if (Date.now() - startedAt > WATCH_MAX_MS) {
      if (state.status === "calling") {
        setVoiceState({
          status: "failed",
          callStatus: "timeout",
          failReason: "call watcher timed out after 5 minutes",
        });
      }
      return;
    }

    try {
      const s = await getSession(callId);
      const current = getVoiceState();
      if (current.callId !== callId) return;

      if (s.status === "in_progress" || s.status === "unknown") {
        if (current.callStatus !== s.status) setVoiceState({ callStatus: s.status });
      } else {
        // Call ended (completed | failed | abandoned).
        if (current.callStatus !== s.status) setVoiceState({ callStatus: s.status });
        // Sync the REAL transcript onto the dashboard as soon as we have it.
        if (s.transcript.length) setVoiceState({ transcript: s.transcript });

        if (current.status === "picked") return; // pick landed — done watching

        if (s.status === "failed" || s.status === "abandoned") {
          setVoiceState({
            status: "failed",
            failReason: s.errorMessage || `call ${s.status}`,
          });
          return;
        }

        // Completed but no pick yet — the background submit_choice can lag the
        // hangup by a few seconds. Grace-poll before declaring failure.
        endedWithoutPickAt ??= Date.now();
        if (Date.now() - endedWithoutPickAt > PICK_GRACE_MS) {
          setVoiceState({
            status: "failed",
            failReason: "call ended without a recorded choice",
          });
          return;
        }
      }
    } catch (e) {
      // Session lookup hiccup — keep watching; the webhook path is independent.
      console.warn(`[voice/call] watcher poll failed for ${callId}:`, e);
    }
    setTimeout(tick, POLL_MS);
  };

  setTimeout(tick, POLL_MS);
}

export async function POST(req: Request) {
  const url = new URL(req.url);

  let body: {
    event?: DisruptionEvent;
    options?: RebookOption[];
    mode?: Mode;
    pickId?: string;
    preflightOnly?: boolean;
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
  const base = publicBaseUrl(req);
  const webhookUrl = `${base}/api/voice/webhook`;

  // ---- PREFLIGHT ONLY (dashboard readiness check — never dials) ----
  if (body.preflightOnly) {
    if (!isConfigured()) {
      return NextResponse.json({
        ready: false,
        checks: {
          hostedWebhook: { ok: false, detail: "VOCAL_BRIDGE_API_KEY not set" },
          tunnel: { ok: false, detail: "VOCAL_BRIDGE_API_KEY not set" },
        },
      });
    }
    return NextResponse.json(await preflight(base, true));
  }

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
    // Prove the plumbing before ringing a phone; auto-heals a rotated tunnel URL.
    const pf = await preflight(base);
    if (!pf.ready) {
      const bad = Object.values(pf.checks).filter((c) => !c.ok);
      throw new Error(`live-call preflight failed: ${bad.map((c) => c.detail).join("; ")}`);
    }

    resetVoiceState();
    setVoiceState({
      mode: "real",
      options,
      status: "calling",
      callStatus: "dialing",
      startedAt: Date.now(),
    });
    const { callId } = await placeCall({ event, options, webhookUrl });
    setVoiceState({ callId });
    watchCall(callId); // fire-and-forget lifecycle tracking
    return NextResponse.json({
      mode: "real",
      status: "calling",
      callId,
      webhookUrl,
      preflight: pf,
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
    setVoiceState({ status: "failed", failReason: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
