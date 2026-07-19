"use client";

// Disruption Rescue — the ops console.
//
// ONE flow: clicking "Simulate Cancellation" hands the incident to the LLM
// orchestrator (Gemini, server-side /api/agent/run). The model drives every
// service through function calls — Sabre flight search, the Vocal Bridge
// phone call, LandingAI receipt extraction, the claim, the PayPal payout —
// and the server enforces the order (out-of-sequence tool calls error), so
// no step can be skipped. This page just watches: it polls the run, mirrors
// progress onto the pipeline, renders every tool call as a trace entry
// (endpoint, args, latency, expandable result), and collects the traveler's
// receipt upload when the agent asks for it.
//
// The only choice on the idle screen is HOW the call happens: a real Vocal
// Bridge phone call, or the scripted transcript (stage-safe fallback).

import { useEffect, useRef, useState } from "react";
import type {
  Confirmation,
  DisruptionEvent,
  PayoutResult,
  RebookOption,
  ReceiptClaim,
  ReceiptExtract,
} from "@/lib/contracts";
import type { TranscriptLine } from "@/lib/store";
import { AIRPORTS } from "@/lib/mocks";
import styles from "./dashboard.module.css";

type StepStatus = "pending" | "active" | "done";
type StepTone = "normal" | "alert" | "success";

interface Step {
  key: string;
  title: string;
  detail?: string;
  status: StepStatus;
  tone: StepTone;
}

// Shape of GET /api/voice/status (the live-call store; polled for the transcript).
interface VoiceStatusPayload {
  status: string;
  mode: string | null;
  callStatus: string | null;
  startedAt: number | null;
  failReason: string | null;
  chosenOption: RebookOption | null;
  transcript?: TranscriptLine[];
}

// A ✓/✗ readiness line (used for both the live-call preflight and the LLM check).
interface ReadyCheck {
  state: "checking" | "ready" | "bad";
  detail: string;
}

// The LLM orchestrator's run state (GET /api/agent/status).
interface AgentLogLine {
  kind: "narration" | "tool" | "tool_result" | "error" | "summary";
  text: string;
  tool?: string;
  args?: string;
  durationMs?: number;
  at: number;
}
interface AgentStatusPayload {
  configured: boolean;
  keyCount: number;
  model: string;
  status: "idle" | "running" | "done" | "failed";
  live: boolean;
  log: AgentLogLine[];
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  event: DisruptionEvent | null;
  options: RebookOption[];
  confirmation: Confirmation | null;
  receipts: ReceiptExtract[];
  claim: ReceiptClaim | null;
  payout: PayoutResult | null;
}

const KEYS = {
  cancel: "cancel",
  call: "call",
  rebook: "rebook",
  receipts: "receipts",
  read: "read",
  claim: "claim",
  payout: "payout",
} as const;

function initialSteps(): Step[] {
  return [
    { key: KEYS.cancel, title: "Flight cancelled", status: "pending", tone: "alert" },
    { key: KEYS.call, title: "Calling traveler", status: "pending", tone: "normal" },
    { key: KEYS.rebook, title: "Rebooking", status: "pending", tone: "normal" },
    { key: KEYS.receipts, title: "Awaiting receipts", status: "pending", tone: "normal" },
    { key: KEYS.read, title: "Reading receipts", status: "pending", tone: "normal" },
    { key: KEYS.claim, title: "Building claim", status: "pending", tone: "normal" },
    { key: KEYS.payout, title: "Reimbursing traveler", status: "pending", tone: "success" },
  ];
}

// What each agent tool actually hits — shown on the pipeline chips and in the
// trace console so a developer can see exactly where every step executes.
const TOOL_META: Record<string, { endpoint: string; service: string }> = {
  get_disruption_event: { endpoint: "GET /api/demo/event", service: "Demo store" },
  search_rebooking_options: { endpoint: "POST /api/rebook", service: "Sabre" },
  call_traveler: { endpoint: "POST /api/voice/call", service: "Vocal Bridge" },
  wait_for_traveler_choice: { endpoint: "GET /api/voice/status", service: "Voice store" },
  confirm_rebooking: { endpoint: "POST /api/rebook/confirm", service: "Sabre" },
  get_seat_map: { endpoint: "POST /api/seatmap", service: "Sabre" },
  read_receipts: { endpoint: "POST /api/receipts", service: "LandingAI" },
  build_claim: { endpoint: "POST /api/claim", service: "Claims engine" },
  send_payout: { endpoint: "POST /api/payout", service: "PayPal" },
};

// Which tools power each pipeline step (the receipts step is the traveler's
// upload — a human step, rendered with its own chip).
const STEP_TOOLS: Record<string, string[]> = {
  [KEYS.cancel]: ["get_disruption_event"],
  [KEYS.call]: ["call_traveler", "wait_for_traveler_choice"],
  [KEYS.rebook]: ["search_rebooking_options", "confirm_rebooking", "get_seat_map"],
  [KEYS.receipts]: [],
  [KEYS.read]: ["read_receipts"],
  [KEYS.claim]: ["build_claim"],
  [KEYS.payout]: ["send_payout"],
};

// The idle-card pipeline strip: the services the orchestrator drives, in order.
const PIPELINE = [
  { service: "Sabre", role: "flight search + rebook", endpoint: "/api/rebook" },
  { service: "Vocal Bridge", role: "voice call", endpoint: "/api/voice/call" },
  { service: "LandingAI", role: "receipt OCR", endpoint: "/api/receipts" },
  { service: "Claims", role: "reimbursement calc", endpoint: "/api/claim" },
  { service: "PayPal", role: "payout", endpoint: "/api/payout" },
];

type ToolState = "running" | "done" | "error";

// Fold the log into per-tool state: a tool line marks it running, its
// result/error line settles it (later calls overwrite — e.g. wait_for_… polls).
function toolStates(log: AgentLogLine[]): Record<string, ToolState> {
  const m: Record<string, ToolState> = {};
  for (const l of log) {
    if (!l.tool) continue;
    if (l.kind === "tool") m[l.tool] = "running";
    else if (l.kind === "tool_result") m[l.tool] = "done";
    else if (l.kind === "error") m[l.tool] = "error";
  }
  return m;
}

// Trace entries for the console: tool calls pair up with the result/error line
// that follows them; everything else stays a text line.
type TraceEntry =
  | { type: "text"; kind: "narration" | "summary" | "error"; text: string; at: number }
  | {
      type: "call";
      tool: string;
      args?: string;
      at: number;
      result?: string;
      error?: string;
      durationMs?: number;
    };

function buildTrace(log: AgentLogLine[]): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (let i = 0; i < log.length; i++) {
    const l = log[i];
    if (l.kind === "tool" && l.tool) {
      const entry: TraceEntry = { type: "call", tool: l.tool, args: l.args, at: l.at };
      const next = log[i + 1];
      if (next && next.tool === l.tool && (next.kind === "tool_result" || next.kind === "error")) {
        if (next.kind === "tool_result") entry.result = next.text;
        else entry.error = next.text;
        entry.durationMs = next.durationMs;
        i++;
      }
      out.push(entry);
    } else if (l.kind === "narration" || l.kind === "summary" || l.kind === "error") {
      out.push({ type: "text", kind: l.kind, text: l.text, at: l.at });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Dashboard() {
  const [phase, setPhase] = useState<"idle" | "active">("idle");
  const [steps, setSteps] = useState<Step[]>(initialSteps());
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [liveCheck, setLiveCheck] = useState<ReadyCheck | null>(null);
  const [mode, setMode] = useState<"llm" | "direct">("llm");
  const [origin, setOrigin] = useState("DFW");
  const [destination, setDestination] = useState("LGA");
  const [agentReady, setAgentReady] = useState<ReadyCheck | null>(null);
  const [agentRun, setAgentRun] = useState<AgentStatusPayload | null>(null);

  const runIdRef = useRef(0); // bumped on start/reset to cancel stale pollers
  const feedRef = useRef<HTMLDivElement | null>(null);

  // Keep the trace console pinned to the newest entry.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [agentRun?.log.length]);

  // Check the orchestrator's keys once on load — the ✓/✗ line on the idle card.
  useEffect(() => {
    void (async () => {
      try {
        const s = await getJSON<AgentStatusPayload>("/api/agent/status");
        setAgentReady(
          s.configured
            ? {
                state: "ready",
                detail: `Orchestrator ready — ${s.model}, ${s.keyCount} key${s.keyCount === 1 ? "" : "s"} in rotation`,
              }
            : {
                state: "bad",
                detail: "No Gemini keys — add GEMINI_API_KEYS=key1,key2,key3 to .env",
              },
        );
      } catch (e) {
        setAgentReady({ state: "bad", detail: errMsg(e) });
      }
    })();
  }, []);

  async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return (await res.json()) as T;
  }

  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Ticking "live phone call" verifies the plumbing (hosted agent webhook +
  // tunnel loopback) WITHOUT dialing, so you know before you're on stage.
  async function onToggleLive(checked: boolean) {
    setLive(checked);
    if (!checked) {
      setLiveCheck(null);
      return;
    }
    setLiveCheck({ state: "checking", detail: "verifying live-call plumbing…" });
    try {
      const pf = await getJSON<{
        ready: boolean;
        checks: Record<string, { ok: boolean; detail: string }>;
      }>("/api/voice/call", jsonPost({ preflightOnly: true }));
      setLiveCheck(
        pf.ready
          ? { state: "ready", detail: "Live call ready — agent webhook in sync, tunnel healthy" }
          : {
              state: "bad",
              detail: Object.values(pf.checks)
                .filter((c) => !c.ok)
                .map((c) => c.detail)
                .join("; "),
            },
      );
    } catch (e) {
      setLiveCheck({ state: "bad", detail: errMsg(e) });
    }
  }

  // Derive the pipeline from the run's accumulated results.
  function agentSteps(s: AgentStatusPayload): Step[] {
    const st = initialSteps();
    const set = (key: string, patch: Partial<Step>) => {
      const i = st.findIndex((x) => x.key === key);
      if (i >= 0) st[i] = { ...st[i], ...patch };
    };
    if (s.event) {
      set(KEYS.cancel, {
        status: "done",
        detail: `${s.event.flight.flightNumber} ${s.event.flight.origin} to ${s.event.flight.destination}, controllable overnight strand`,
      });
    }
    if (s.options.length) {
      set(KEYS.call, {
        status: "active",
        title: s.live ? "Calling traveler (live)" : "Calling traveler",
        detail: "Reading the options, capturing the pick...",
      });
    }
    if (s.confirmation) {
      const idx = s.options.findIndex((o) => o.id === s.confirmation!.chosenOption.id);
      const c = s.confirmation.chosenOption;
      const extras = [
        typeof c.seatsLeft === "number" ? `${c.seatsLeft} seats left at fare` : null,
        typeof c.checkedBags === "number"
          ? `${c.checkedBags} checked bag${c.checkedBags === 1 ? "" : "s"} incl.`
          : null,
        c.cabin ? `cabin ${c.cabin}${c.bookingCode ? `/${c.bookingCode}` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      set(KEYS.call, {
        status: "done",
        title: `Traveler picked Option ${idx >= 0 ? idx + 1 : "?"}${s.live ? " (live)" : ""}`,
        detail: `${c.flightNumber}, ${fmtTime(c.depTime)} to ${fmtTime(c.arrTime)}${extras ? ` · ${extras}` : ""}`,
      });
      set(KEYS.rebook, {
        status: "done",
        title: `Rebooked on ${c.flightNumber}`,
        detail: `New PNR ${s.confirmation.newPNR}, fare difference ${fmtMoney(c.fareDifference)} ${s.confirmation.fareDifferenceSettled ? "settled" : "pending"}`,
      });
      set(KEYS.receipts, {
        status: "active",
        title: "Awaiting receipts",
        detail: "Agent is waiting — upload the hotel folio and meal receipt",
      });
    }
    if (s.receipts.length) {
      set(KEYS.receipts, { status: "done", title: "Receipts received" });
      set(KEYS.read, {
        status: "done",
        title: "Receipts read",
        detail: s.receipts.map((r) => `${r.merchant} ${fmtMoney(r.total)} (${r.category})`).join(", "),
      });
      set(KEYS.claim, { status: "active", title: "Building claim" });
    }
    if (s.claim) {
      set(KEYS.claim, {
        status: "done",
        title: `Claim built, owed ${fmtMoney(s.claim.owedTotal)}`,
        detail: s.claim.commitmentsMet.length
          ? `Against ${s.claim.commitmentsMet.join(" + ")} commitments`
          : "No matching commitments",
      });
      set(KEYS.payout, { status: "active", title: "Reimbursing traveler" });
    }
    if (s.payout) {
      set(KEYS.payout, {
        status: s.payout.status === "sent" ? "done" : "active",
        title: `${fmtMoney(s.payout.amount)} sent to traveler's PayPal`,
        detail: `PayPal txn ${s.payout.paypalTxnId}`,
      });
    }
    return st;
  }

  // The traveler's receipt upload: extract via /api/receipts (real LandingAI),
  // then drop the results in the agent's inbox — its read_receipts tool is
  // blocking on it. Null files = "use the sample photos".
  async function submitReceipts(files: FileList | null) {
    setError(null);
    try {
      if (files && files.length > 0) {
        const receipts: ReceiptExtract[] = [];
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append("file", file);
          receipts.push(
            await getJSON<ReceiptExtract>("/api/receipts", { method: "POST", body: form }),
          );
        }
        await fetch("/api/agent/receipts", jsonPost({ receipts }));
      } else {
        await fetch("/api/agent/receipts", jsonPost({ useBundled: true }));
      }
    } catch (e) {
      setError(errMsg(e));
    }
  }

  // Kick off the LLM run and mirror it: poll the feed, rebuild the pipeline,
  // and pull the call transcript from the voice store as it grows.
  async function start() {
    setError(null);
    setPhase("active");
    setSteps(initialSteps());
    setTranscript([]);
    setBusy(true);
    setAgentRun(null);
    const runId = ++runIdRef.current;

    try {
      await fetch("/api/voice/status", jsonPost({ reset: true }));
      await fetch("/api/agent/status", jsonPost({ reset: true }));

      const res = await fetch(
        "/api/agent/run",
        jsonPost({ live, mode, origin, destination }),
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `agent run -> ${res.status}`);
      }

      let transcriptLen = 0;
      while (runIdRef.current === runId) {
        const s = await getJSON<AgentStatusPayload>("/api/agent/status");
        setAgentRun(s);
        setSteps(agentSteps(s));
        try {
          const v = await getJSON<VoiceStatusPayload>("/api/voice/status");
          if (v.transcript && v.transcript.length !== transcriptLen) {
            transcriptLen = v.transcript.length;
            if (transcriptLen > 0) setTranscript(v.transcript);
          }
        } catch {
          /* transcript is best-effort */
        }
        if (s.status === "done" || s.status === "failed") {
          if (s.status === "failed" && s.error) setError(s.error);
          break;
        }
        await sleep(1000);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    runIdRef.current++; // cancel any pollers still running
    setPhase("idle");
    setSteps(initialSteps());
    setTranscript([]);
    setError(null);
    setBusy(false);
    setAgentRun(null);
    fetch("/api/voice/status", jsonPost({ reset: true })).catch(() => {});
    fetch("/api/agent/status", jsonPost({ reset: true })).catch(() => {});
  }

  const awaitingUpload =
    agentRun?.status === "running" &&
    Boolean(agentRun.confirmation) &&
    agentRun.receipts.length === 0;

  const tStates = toolStates(agentRun?.log ?? []);
  const trace = buildTrace(agentRun?.log ?? []);
  const toolsDone = Object.values(tStates).filter((v) => v === "done").length;
  const toolsTotal = Object.keys(TOOL_META).length;

  function chipClass(state: ToolState | undefined): string {
    if (state === "running") return `${styles.toolChip} ${styles.toolChipRun}`;
    if (state === "done") return `${styles.toolChip} ${styles.toolChipDone}`;
    if (state === "error") return `${styles.toolChip} ${styles.toolChipErr}`;
    return styles.toolChip;
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brandDot} />
        <h1>Disruption Rescue</h1>
        <span className={styles.headerTag}>Live Ops</span>
      </header>

      {error && <div className={styles.errorBar}>Something stalled: {error}</div>}

      {phase === "idle" ? (
        <section className={styles.card}>
          <div className={styles.trackTop}>
            <div className={styles.trackLabel}>Tracking · Fri Jul 18</div>
            <span className={`${styles.pill} ${styles.onTime}`}>
              <span className={styles.pillDot} />
              On Time
            </span>
          </div>
          <div className={styles.routeBoard}>
            <div className={styles.airport}>
              <select
                className={styles.airportSelect}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                aria-label="Origin airport"
              >
                {Object.keys(AIRPORTS).map((code) => (
                  <option key={code} value={code} disabled={code === destination}>
                    {code}
                  </option>
                ))}
              </select>
              <div className={styles.airportName}>{AIRPORTS[origin]}</div>
            </div>
            <div className={styles.routePath}>
              <span className={styles.routeDot} />
              <span className={styles.routeLine} />
              <span className={styles.plane}>✈</span>
              <span className={styles.routeLine} />
              <span className={styles.routeDot} />
            </div>
            <div className={styles.airport}>
              <select
                className={styles.airportSelect}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                aria-label="Destination airport"
              >
                {Object.keys(AIRPORTS).map((code) => (
                  <option key={code} value={code} disabled={code === origin}>
                    {code}
                  </option>
                ))}
              </select>
              <div className={styles.airportName}>{AIRPORTS[destination]}</div>
            </div>
          </div>
          <div className={styles.flightMetaRow}>
            <span className={styles.flightNo}>
              AA123 <small>· American Airlines · dep 5:30 PM · rebooking searches ALL airlines</small>
            </span>
          </div>

          <div className={styles.modeRow}>
            <button
              className={`${styles.modeBtn} ${mode === "llm" ? styles.modeBtnActive : ""}`}
              onClick={() => setMode("llm")}
            >
              🤖 LLM orchestrator
              <small>Gemini decides &amp; narrates each step</small>
            </button>
            <button
              className={`${styles.modeBtn} ${mode === "direct" ? styles.modeBtnActive : ""}`}
              onClick={() => setMode("direct")}
            >
              ⚙️ Direct pipeline
              <small>same steps, no LLM — zero quota</small>
            </button>
          </div>

          <div className={styles.pipelineStrip}>
            <div className={styles.pipelineLabel}>
              Recovery pipeline — a Gemini orchestrator drives every service below via
              function calls; the server enforces the order
            </div>
            <div className={styles.pipelineFlow}>
              {PIPELINE.map((p, i) => (
                <div key={p.service} className={styles.pipelineNodeWrap}>
                  {i > 0 && <span className={styles.pipelineArrow}>→</span>}
                  <div className={styles.pipelineNode}>
                    <div className={styles.pipelineService}>{p.service}</div>
                    <div className={styles.pipelineRole}>{p.role}</div>
                    <code className={styles.pipelineEndpoint}>{p.endpoint}</code>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button className={styles.simulateBtn} onClick={start}>
            Simulate Cancellation
          </button>
          <label className={styles.liveToggle}>
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => onToggleLive(e.target.checked)}
            />
            Live phone call (real Vocal Bridge dial; unticked = scripted call)
          </label>
          {liveCheck && (
            <div
              className={`${styles.liveCheck} ${
                liveCheck.state === "ready"
                  ? styles.liveCheckOk
                  : liveCheck.state === "bad"
                    ? styles.liveCheckBad
                    : ""
              }`}
            >
              {liveCheck.state === "checking" && "⏳ "}
              {liveCheck.state === "ready" && "✓ "}
              {liveCheck.state === "bad" && "✗ "}
              {liveCheck.detail}
            </div>
          )}
          {agentReady && (
            <div
              className={`${styles.liveCheck} ${
                agentReady.state === "ready" ? styles.liveCheckOk : styles.liveCheckBad
              }`}
            >
              {agentReady.state === "ready" ? "✓ " : "✗ "}
              {agentReady.detail}
            </div>
          )}
        </section>
      ) : (
        <section className={styles.stepperWrap}>
          <div className={styles.runBar}>
            <span
              className={`${styles.runState} ${
                agentRun?.status === "running"
                  ? styles.runStateLive
                  : agentRun?.status === "done"
                    ? styles.runStateDone
                    : agentRun?.status === "failed"
                      ? styles.runStateFail
                      : ""
              }`}
            >
              {agentRun?.status ?? "starting"}
            </span>
            <span className={styles.runMeta}>
              <em>model</em> {agentRun?.model ?? "—"}
            </span>
            <span className={styles.runMeta}>
              <em>voice</em> {agentRun?.live ? "live Vocal Bridge call" : "scripted call"}
            </span>
            <span className={styles.runMeta}>
              <em>tools</em> {toolsDone}/{toolsTotal} completed
            </span>
            <span className={styles.runElapsed}>
              {agentRun?.startedAt
                ? fmtRunElapsed(agentRun.startedAt, agentRun.endedAt)
                : "00:00"}
            </span>
          </div>

          <div className={styles.splitRow}>
            <div className={styles.mainCol}>
              <ol className={styles.stepper}>
                {steps.map((s, i) => (
                  <li
                    key={s.key}
                    className={`${styles.step} ${styles[s.status]} ${styles[s.tone]}`}
                  >
                    <div className={styles.marker}>{s.status === "done" ? "✓" : i + 1}</div>
                    <div className={styles.stepBody}>
                      <div className={styles.stepTitle}>{s.title}</div>
                      {s.detail && <div className={styles.stepDetail}>{s.detail}</div>}
                      <div className={styles.stepTools}>
                        {STEP_TOOLS[s.key].map((t) => (
                          <span key={t} className={chipClass(tStates[t])}>
                            <span className={styles.toolChipDot} />
                            <code>{t}</code>
                            <em>{TOOL_META[t].service}</em>
                          </span>
                        ))}
                        {s.key === KEYS.receipts && (
                          <span
                            className={chipClass(
                              agentRun?.receipts.length
                                ? "done"
                                : awaitingUpload
                                  ? "running"
                                  : undefined,
                            )}
                          >
                            <span className={styles.toolChipDot} />
                            <code>traveler_upload</code>
                            <em>Browser → /api/receipts</em>
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>

              {steps.find((s) => s.key === KEYS.payout)?.status === "done" && (
                <div className={styles.doneBanner}>
                  <span className={styles.doneCheck}>✓</span>
                  <div>
                    <div className={styles.doneTitle}>Traveler made whole</div>
                    <div className={styles.doneSub}>
                      Rebooked + reimbursed — one call, zero forms
                    </div>
                  </div>
                </div>
              )}

              {transcript.length > 0 && (
                <div className={styles.transcript}>
                  <div className={styles.transcriptLabel}>
                    {live && steps.find((s) => s.key === KEYS.call)?.status === "active" ? (
                      <>
                        <span className={styles.liveDot} /> Live call · Vocal Bridge
                      </>
                    ) : (
                      "Call transcript · Vocal Bridge"
                    )}
                  </div>
                  <div className={styles.bubbles}>
                    {transcript.map((t, i) => (
                      <div
                        key={i}
                        className={`${styles.bubbleRow} ${t.speaker === "traveler" ? styles.bubbleRight : ""}`}
                      >
                        <span className={styles.avatar} aria-hidden>
                          {t.speaker === "agent" ? "A" : "T"}
                        </span>
                        <div
                          className={`${styles.bubble} ${t.speaker === "agent" ? styles.bubbleAgent : styles.bubbleTraveler}`}
                        >
                          {t.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {awaitingUpload && (
                <div className={styles.uploader}>
                  <label className={styles.uploadBtn}>
                    Upload receipt photos
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => submitReceipts(e.target.files)}
                    />
                  </label>
                  <button className={styles.sampleBtn} onClick={() => submitReceipts(null)}>
                    Use sample receipts
                  </button>
                </div>
              )}
            </div>

            <aside className={styles.agentPanel}>
              <div className={styles.agentHeader}>
                <span
                  className={`${styles.agentDot} ${agentRun?.status === "running" ? styles.agentDotLive : ""}`}
                />
                <div className={styles.agentHeadText}>
                  <div className={styles.agentTitle}>Agent trace</div>
                  <div className={styles.agentSub}>
                    {agentRun
                      ? `${agentRun.model} · ${agentRun.keyCount} key${agentRun.keyCount === 1 ? "" : "s"} in rotation`
                      : "starting…"}
                  </div>
                </div>
                {agentRun?.status === "running" && (
                  <span className={styles.agentBadgeRun}>running</span>
                )}
                {agentRun?.status === "done" && (
                  <span className={styles.agentBadgeDone}>done</span>
                )}
                {agentRun?.status === "failed" && (
                  <span className={styles.agentBadgeFail}>failed</span>
                )}
              </div>
              <div className={styles.agentFeed} ref={feedRef}>
                {trace.map((e, i) =>
                  e.type === "call" ? (
                    <div key={i} className={styles.traceCall}>
                      <div className={styles.traceHead}>
                        <span className={styles.traceArrow}>→</span>
                        <code className={styles.traceTool}>{e.tool}</code>
                        {TOOL_META[e.tool] && (
                          <span className={styles.traceService}>
                            {TOOL_META[e.tool].service}
                          </span>
                        )}
                        <span className={styles.traceTime}>
                          {fmtOffset(e.at, agentRun?.startedAt)}
                          {e.durationMs != null && ` · ${fmtDuration(e.durationMs)}`}
                        </span>
                      </div>
                      <div className={styles.traceEndpoint}>
                        {TOOL_META[e.tool]?.endpoint ?? "internal"}
                        {e.args && <span className={styles.traceArgs}> {e.args}</span>}
                      </div>
                      {e.error ? (
                        <div className={styles.traceError}>✗ {e.error}</div>
                      ) : e.result ? (
                        <details className={styles.traceResult}>
                          <summary>result</summary>
                          <pre>{prettyJSON(e.result)}</pre>
                        </details>
                      ) : (
                        <div className={styles.traceRunning}>executing…</div>
                      )}
                    </div>
                  ) : e.kind === "error" ? (
                    <div key={i} className={styles.feedError}>
                      ✗ {e.text}
                    </div>
                  ) : e.kind === "summary" ? (
                    <div key={i} className={styles.feedSummary}>
                      {e.text}
                    </div>
                  ) : (
                    <div key={i} className={styles.feedNarration}>
                      <span className={styles.feedNarrTime}>
                        {fmtOffset(e.at, agentRun?.startedAt)}
                      </span>
                      {e.text}
                    </div>
                  ),
                )}
                {agentRun?.status === "running" && (
                  <div className={styles.feedThinking}>· · ·</div>
                )}
              </div>
            </aside>
          </div>

          <button
            className={styles.resetBtn}
            onClick={reset}
            disabled={busy && agentRun?.status === "running"}
          >
            Reset demo
          </button>
        </section>
      )}
    </main>
  );
}

function fmtMoney(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

// Show the flight-local clock time as authored, without timezone conversion.
function fmtTime(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

// "+12.3s" — when a trace entry happened, relative to run start.
function fmtOffset(at: number, startedAt: number | null | undefined): string {
  if (!startedAt) return "";
  return `+${((at - startedAt) / 1000).toFixed(1)}s`;
}

// "840ms" / "2.4s" — how long a tool execution took.
function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// "01:23" — total run wall clock (frozen at endedAt once the run settles).
function fmtRunElapsed(startedAt: number, endedAt: number | null): string {
  const s = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// Tool results are logged as JSON (possibly truncated with a trailing "…") —
// pretty-print when parseable, otherwise show the raw text.
function prettyJSON(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
