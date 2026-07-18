"use client";

// Person 1 — the spine. Dashboard the judge watches plus the orchestrator that
// chains the team's real endpoints:
//   /api/rebook (Person 2) -> /api/voice/call + poll /api/voice/status (Person 2)
//   -> /api/rebook/confirm (Person 2) -> /api/receipts, /api/claim, /api/payout (Person 3)
// Voice runs in "mock" mode by default (scripted transcript + hardcoded opt_2);
// tick "live phone call" to place a real Vocal Bridge call (auto-falls back).

import { useRef, useState } from "react";
import type {
  Confirmation,
  DisruptionEvent,
  PayoutResult,
  RebookOption,
  ReceiptClaim,
  ReceiptExtract,
} from "@/lib/contracts";
import type { TranscriptLine } from "@/lib/store";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Dashboard() {
  const [phase, setPhase] = useState<"idle" | "active">("idle");
  const [steps, setSteps] = useState<Step[]>(initialSteps());
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [awaitingReceipts, setAwaitingReceipts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);

  const eventRef = useRef<DisruptionEvent | null>(null);
  const optionsRef = useRef<RebookOption[]>([]);
  const sampleReceiptsRef = useRef<ReceiptExtract[]>([]);

  function patch(key: string, next: Partial<Step>) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...next } : s)));
  }

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

  // Steps 1 to 3: trigger -> rebook search + voice call -> confirm.
  async function start() {
    setError(null);
    setPhase("active");
    setSteps(initialSteps());
    setTranscript([]);
    setAwaitingReceipts(false);
    setBusy(true);
    try {
      const { event, sampleReceipts } = await getJSON<{
        event: DisruptionEvent;
        sampleReceipts: ReceiptExtract[];
      }>("/api/demo/event");
      eventRef.current = event;
      sampleReceiptsRef.current = sampleReceipts;

      patch(KEYS.cancel, {
        status: "done",
        title: "Flight cancelled",
        detail: `${event.flight.flightNumber} ${event.flight.origin} to ${event.flight.destination}, controllable overnight strand`,
      });

      // Clear any voice state from a prior run.
      await fetch("/api/voice/status", jsonPost({ reset: true }));

      patch(KEYS.call, {
        status: "active",
        title: live ? "Calling traveler (live)" : "Calling traveler",
        detail: `Dialing ${event.traveler.name}...`,
      });

      const options = await getJSON<RebookOption[]>("/api/rebook", jsonPost(event));
      optionsRef.current = options;

      const call = await getJSON<{
        mode: string;
        status: string;
        transcript?: TranscriptLine[];
        fellBackFrom?: string;
      }>("/api/voice/call", jsonPost({ event, options, mode: live ? "real" : "mock" }));
      if (call.transcript?.length) setTranscript(call.transcript);

      // Let the "calling" moment breathe on screen before the pick lands.
      await sleep(1800);

      const { chosen, transcript: finalTranscript } = await waitForPick(call.status);
      if (finalTranscript?.length) setTranscript(finalTranscript);

      const idx = Math.max(0, options.findIndex((o) => o.id === chosen.id));
      const fellBack = call.fellBackFrom ? " (scripted fallback)" : "";
      patch(KEYS.call, {
        status: "done",
        title: `Traveler picked Option ${idx + 1}${fellBack}`,
        detail: `${chosen.flightNumber}, ${fmtTime(chosen.depTime)} to ${fmtTime(chosen.arrTime)}`,
      });

      patch(KEYS.rebook, { status: "active", title: "Rebooking", detail: "Confirming new itinerary..." });
      const confirmation = await getJSON<Confirmation>(
        "/api/rebook/confirm",
        jsonPost({ option: chosen, traveler: event.traveler }),
      );
      patch(KEYS.rebook, {
        status: "done",
        title: `Rebooked on ${chosen.flightNumber}`,
        detail: `New PNR ${confirmation.newPNR}, fare difference ${fmtMoney(chosen.fareDifference)} ${confirmation.fareDifferenceSettled ? "settled" : "pending"}`,
      });

      patch(KEYS.receipts, {
        status: "active",
        title: "Awaiting receipts",
        detail: "Upload a hotel folio and a meal receipt",
      });
      setAwaitingReceipts(true);
      setBusy(false);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  // Poll Person 2's voice status until the traveler's pick lands.
  async function waitForPick(
    firstStatus: string,
  ): Promise<{ chosen: RebookOption; transcript?: TranscriptLine[] }> {
    for (let i = 0; i < 30; i++) {
      try {
        const s = await getJSON<{
          status: string;
          chosenOption: RebookOption | null;
          transcript?: TranscriptLine[];
        }>("/api/voice/status");
        if (s.status === "picked" && s.chosenOption) {
          return { chosen: s.chosenOption, transcript: s.transcript };
        }
        if (s.status === "failed") throw new Error("voice call failed");
      } catch (e) {
        if (e instanceof Error && e.message === "voice call failed") throw e;
        // transient poll error; keep trying
      }
      await sleep(500);
    }
    // Fallback: option two, matching the scripted pick.
    const fallback = optionsRef.current[1] ?? optionsRef.current[0];
    if (!fallback) throw new Error(`no rebooking options (voice status: ${firstStatus})`);
    return { chosen: fallback };
  }

  // Steps 5 to 7: read receipts -> build claim -> pay out.
  async function submitReceipts(files: FileList | null) {
    if (busy) return;
    const event = eventRef.current;
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      patch(KEYS.receipts, { status: "done", title: "Receipts received" });
      patch(KEYS.read, { status: "active", title: "Reading receipts", detail: "Extracting line items..." });
      setAwaitingReceipts(false);

      let receipts: ReceiptExtract[];
      if (files && files.length > 0) {
        receipts = [];
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append("file", file);
          receipts.push(await getJSON<ReceiptExtract>("/api/receipts", { method: "POST", body: form }));
        }
      } else {
        receipts = sampleReceiptsRef.current;
      }

      patch(KEYS.read, {
        status: "done",
        title: "Receipts read",
        detail: receipts.map((r) => `${r.merchant} ${fmtMoney(r.total)} (${r.category})`).join(", "),
      });

      patch(KEYS.claim, { status: "active", title: "Building claim", detail: "Matching airline commitments..." });
      const claim = await getJSON<ReceiptClaim>("/api/claim", jsonPost({ receipts, event }));
      patch(KEYS.claim, {
        status: "done",
        title: `Claim built, owed ${fmtMoney(claim.owedTotal)}`,
        detail: claim.commitmentsMet.length
          ? `Against ${claim.commitmentsMet.join(" + ")} commitments`
          : "No matching commitments",
      });

      patch(KEYS.payout, { status: "active", title: "Reimbursing traveler", detail: "Sending PayPal payout..." });
      const payout = await getJSON<PayoutResult>("/api/payout", jsonPost({ claim, traveler: event.traveler }));
      patch(KEYS.payout, {
        status: payout.status === "sent" ? "done" : "active",
        title: `${fmtMoney(payout.amount)} sent to traveler's PayPal`,
        detail: `PayPal txn ${payout.paypalTxnId}`,
      });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("idle");
    setSteps(initialSteps());
    setTranscript([]);
    setError(null);
    setAwaitingReceipts(false);
    setBusy(false);
    eventRef.current = null;
    optionsRef.current = [];
    sampleReceiptsRef.current = [];
    fetch("/api/voice/status", jsonPost({ reset: true })).catch(() => {});
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brandDot} />
        <h1>Disruption Rescue</h1>
      </header>

      {error && <div className={styles.errorBar}>Something stalled: {error}</div>}

      {phase === "idle" ? (
        <section className={styles.card}>
          <div className={styles.trackRow}>
            <div>
              <div className={styles.trackLabel}>Tracking</div>
              <div className={styles.flightBig}>AA123 · DFW → LGA</div>
              <div className={styles.flightSub}>Fri Jul 18</div>
            </div>
            <span className={`${styles.pill} ${styles.onTime}`}>On Time</span>
          </div>
          <button className={styles.simulateBtn} onClick={start}>
            Simulate Cancellation
          </button>
          <label className={styles.liveToggle}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Use a live phone call (needs Vocal Bridge configured, falls back to scripted)
          </label>
        </section>
      ) : (
        <section className={styles.stepperWrap}>
          <ol className={styles.stepper}>
            {steps.map((s, i) => (
              <li key={s.key} className={`${styles.step} ${styles[s.status]} ${styles[s.tone]}`}>
                <div className={styles.marker}>{s.status === "done" ? "✓" : i + 1}</div>
                <div className={styles.stepBody}>
                  <div className={styles.stepTitle}>{s.title}</div>
                  {s.detail && <div className={styles.stepDetail}>{s.detail}</div>}
                </div>
              </li>
            ))}
          </ol>

          {transcript.length > 0 && (
            <div className={styles.transcript}>
              <div className={styles.transcriptLabel}>Call transcript</div>
              {transcript.map((t, i) => (
                <p key={i} className={`${styles.line} ${t.speaker === "agent" ? styles.agent : styles.traveler}`}>
                  <b>{t.speaker === "agent" ? "Agent" : "Traveler"}:</b> {t.text}
                </p>
              ))}
            </div>
          )}

          {awaitingReceipts && (
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
              <button className={styles.sampleBtn} onClick={() => submitReceipts(null)} disabled={busy}>
                Use sample receipts
              </button>
            </div>
          )}

          <button className={styles.resetBtn} onClick={reset} disabled={busy}>
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
