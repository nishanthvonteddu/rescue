// /lib/store.ts — tiny in-memory store for the voice-call state.
//
// The webhook writes the traveler's spoken pick here; Person 1's orchestrator
// polls GET /api/voice/status to learn "the traveler chose opt_2". A module-level
// singleton is enough for a single-process `next dev` demo — no DB needed.
//
// We stash it on globalThis so it survives Next.js dev hot-reloads / route-module
// re-evaluation (each route would otherwise get its own copy).

import type { RebookOption } from "./contracts";

export type VoiceStatus = "idle" | "calling" | "picked" | "failed";

export interface VoiceState {
  status: VoiceStatus;
  callId: string | null; // Vocal Bridge call id (real mode)
  mode: "real" | "mock" | null; // how the current/last call was placed
  options: RebookOption[]; // options presented on the current call
  chosenOptionId: string | null; // what the traveler said ("opt_2")
  chosenOption: RebookOption | null; // resolved option object
  transcript: TranscriptLine[]; // scripted or live transcript for the UI
  callStatus: string | null; // provider lifecycle: dialing | in_progress | completed | failed | abandoned
  startedAt: number | null; // epoch ms when the real call was placed
  failReason: string | null; // why status became "failed" (shown on the dashboard)
  updatedAt: number; // epoch ms of last change
}

export interface TranscriptLine {
  speaker: "agent" | "traveler";
  text: string;
}

function freshState(): VoiceState {
  return {
    status: "idle",
    callId: null,
    mode: null,
    options: [],
    chosenOptionId: null,
    chosenOption: null,
    transcript: [],
    callStatus: null,
    startedAt: null,
    failReason: null,
    updatedAt: Date.now(),
  };
}

const g = globalThis as unknown as {
  __voiceState?: VoiceState;
  __voiceInstanceId?: string;
};
if (!g.__voiceState) g.__voiceState = freshState();
// Per-process id. The real-call preflight fetches our own webhook THROUGH the
// public tunnel and compares this id, proving the tunnel terminates at this
// exact server (not a dead tunnel or someone else's laptop).
if (!g.__voiceInstanceId) {
  g.__voiceInstanceId = `srv_${Math.random().toString(36).slice(2, 10)}`;
}

export const INSTANCE_ID: string = g.__voiceInstanceId;

export function getVoiceState(): VoiceState {
  return g.__voiceState!;
}

export function setVoiceState(patch: Partial<VoiceState>): VoiceState {
  g.__voiceState = { ...g.__voiceState!, ...patch, updatedAt: Date.now() };
  return g.__voiceState;
}

export function resetVoiceState(): VoiceState {
  g.__voiceState = freshState();
  return g.__voiceState;
}

// Resolve a spoken pick to an option. Accepts an option id ("opt_2"),
// a bare number/word ("2", "two"), or a flight number, against the options
// presented on the current call.
export function resolvePick(
  raw: string,
  options: RebookOption[],
): RebookOption | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // direct id match
  const byId = options.find((o) => o.id.toLowerCase() === s);
  if (byId) return byId;

  // spoken number -> 1-based index
  const words: Record<string, number> = {
    "1": 1, one: 1, first: 1,
    "2": 2, two: 2, second: 2,
    "3": 3, three: 3, third: 3,
  };
  // pull the first number-ish token out of a phrase like "option two please"
  for (const token of s.split(/[^a-z0-9]+/)) {
    if (token in words) {
      const idx = words[token] - 1;
      if (idx >= 0 && idx < options.length) return options[idx];
    }
  }

  // flight-number match (e.g. "AA512")
  const byFlight = options.find(
    (o) => o.flightNumber.toLowerCase().replace(/\s+/g, "") === s.replace(/\s+/g, ""),
  );
  if (byFlight) return byFlight;

  return null;
}
