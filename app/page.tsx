// app/page.tsx — PLACEHOLDER owned by Person 1 (dashboard + orchestration).
// Person 1: replace this whole file. It's parked here so the dev server has a root
// and so Person 2 can exercise the rebook+voice slice end-to-end in a browser.
"use client";

import { useState } from "react";
import type { Confirmation, RebookOption } from "@/lib/contracts";
import type { TranscriptLine } from "@/lib/store";

const card: React.CSSProperties = {
  background: "#141a26",
  border: "1px solid #263248",
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: 8,
  padding: "10px 16px",
  fontSize: 15,
  cursor: "pointer",
  marginRight: 8,
};

export default function Page() {
  const [log, setLog] = useState<string[]>([]);
  const [options, setOptions] = useState<RebookOption[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [pick, setPick] = useState<RebookOption | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const say = (m: string) => setLog((l) => [...l, m]);

  async function runFlow(mode: "mock" | "real") {
    setLog([]); setOptions([]); setTranscript([]); setPick(null); setConfirmation(null);

    say("POST /api/rebook …");
    const opts: RebookOption[] = await (await fetch("/api/rebook", { method: "POST" })).json();
    setOptions(opts);
    say(`  → ${opts.length} options`);

    say(`POST /api/voice/call (mode=${mode}) …`);
    const call = await (
      await fetch("/api/voice/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ options: opts, mode }),
      })
    ).json();
    setTranscript(call.transcript || []);
    say(`  → mode=${call.mode}${call.fellBackFrom ? " (fell back from real)" : ""}, status=${call.status}`);

    // Poll for the pick.
    let chosen: RebookOption | null = null;
    for (let i = 0; i < 20 && !chosen; i++) {
      const s = await (await fetch("/api/voice/status")).json();
      if (s.status === "picked") chosen = s.chosenOption;
      else await new Promise((r) => setTimeout(r, 300));
    }
    if (!chosen) { say("  → no pick (real call — waiting on webhook)"); return; }
    setPick(chosen);
    say(`  → traveler picked ${chosen.id} (${chosen.flightNumber})`);

    say("POST /api/rebook/confirm …");
    const conf: Confirmation = await (
      await fetch("/api/rebook/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option: chosen }),
      })
    ).json();
    setConfirmation(conf);
    say(`  → PNR ${conf.newPNR}, fare settled: ${conf.fareDifferenceSettled}`);
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px" }}>
      <p style={{ color: "#f59e0b", fontSize: 13, marginTop: 0 }}>
        ⚠ Placeholder — Person 1 replaces this file. This is Person 2&apos;s slice test harness.
      </p>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Disruption Rescue — Rebook + Voice</h1>
      <p style={{ color: "#8b98ad", marginTop: 0 }}>
        Tracking <b>AA123 · DFW → LGA</b> · Fri Jul 18
      </p>

      <div style={{ marginBottom: 20 }}>
        <button style={btn} onClick={() => runFlow("mock")}>Simulate Cancellation (mock call)</button>
        <button style={{ ...btn, background: "#8b5cf6" }} onClick={() => runFlow("real")}>Try real call</button>
      </div>

      {options.length > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Rebooking options</h3>
          {options.map((o) => (
            <div key={o.id} style={{ padding: "6px 0", borderBottom: "1px solid #263248" }}>
              <b>{o.id}</b> — {o.carrier} {o.flightNumber} · dep {o.depTime.slice(11, 16)} · arr {o.arrTime.slice(11, 16)} · {o.fareDifference === 0 ? "no extra cost" : `+$${o.fareDifference}`}
            </div>
          ))}
        </div>
      )}

      {transcript.length > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Call transcript</h3>
          {transcript.map((t, i) => (
            <p key={i} style={{ margin: "6px 0", color: t.speaker === "agent" ? "#e8edf5" : "#7dd3fc" }}>
              <b>{t.speaker === "agent" ? "Agent" : "Traveler"}:</b> {t.text}
            </p>
          ))}
        </div>
      )}

      {pick && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Pick</h3>
          Traveler chose <b>{pick.id}</b> — {pick.carrier} {pick.flightNumber}
        </div>
      )}

      {confirmation && (
        <div style={{ ...card, borderColor: "#22c55e" }}>
          <h3 style={{ marginTop: 0, color: "#22c55e" }}>✓ Rebooked</h3>
          New PNR <b>{confirmation.newPNR}</b> · fare difference {confirmation.fareDifferenceSettled ? "settled" : "NOT settled"}
        </div>
      )}

      {log.length > 0 && (
        <pre style={{ ...card, fontSize: 12, color: "#8b98ad", whiteSpace: "pre-wrap" }}>
          {log.join("\n")}
        </pre>
      )}
    </main>
  );
}
