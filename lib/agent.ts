// /lib/agent.ts — LLM as the orchestrator ("agent mode"), powered by Gemini.
//
// Instead of the dashboard hardcoding the recovery sequence, the model decides:
// it reads the disruption, searches rebooking options (Sabre mock), places the
// Vocal Bridge call, waits for the traveler's spoken pick, confirms, reads
// receipts (REAL LandingAI on the bundled sample photos), builds the claim,
// and sends the PayPal payout — a function-calling loop where each tool maps
// 1:1 to the team's existing API endpoints. The model's narration between
// tool calls becomes the live "agent console" feed on the dashboard.
//
// FREE-TIER AWARE: reads 3-4 keys from GEMINI_API_KEYS (comma-separated),
// round-robins them, puts a key on cooldown when it 429s, retries with
// backoff, and sleeps GEMINI_TURN_DELAY_MS between model turns to stay under
// the free-tier RPM caps. Plain REST via fetch — no SDK dependency.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  Confirmation,
  DisruptionEvent,
  PayoutResult,
  RebookOption,
  ReceiptClaim,
  ReceiptExtract,
} from "./contracts";
import { getReceiptsInbox, resetReceiptsInbox } from "./receiptsInbox";
import { getVoiceState } from "./store";

// ---------------------------------------------------------------------------
// Run state — in-memory singleton (same pattern as the voice store).
// ---------------------------------------------------------------------------

export interface AgentLogLine {
  kind: "narration" | "tool" | "tool_result" | "error" | "summary";
  text: string;
  tool?: string; // set on tool/tool_result lines
  args?: string; // JSON of the call args (tool lines, when non-empty)
  durationMs?: number; // wall time of the tool execution (tool_result/error lines)
  at: number;
}

export type AgentStatus = "idle" | "running" | "done" | "failed";

export type OrchestratorMode = "llm" | "direct";

export interface AgentRun {
  status: AgentStatus;
  live: boolean; // real phone call vs scripted
  mode: OrchestratorMode; // llm = Gemini decides; direct = fixed pipeline, no LLM
  origin: string; // route chosen on the dashboard
  destination: string;
  log: AgentLogLine[];
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  model: string;
  // Context the tools accumulate (also lets the UI render results):
  event: DisruptionEvent | null;
  options: RebookOption[];
  calledTraveler: boolean; // call_traveler was actually executed
  confirmation: Confirmation | null;
  receipts: ReceiptExtract[];
  claim: ReceiptClaim | null;
  payout: PayoutResult | null;
}

function freshRun(): AgentRun {
  return {
    status: "idle",
    live: false,
    mode: "llm",
    origin: "DFW",
    destination: "LGA",
    log: [],
    startedAt: null,
    endedAt: null,
    error: null,
    model: geminiModel(),
    event: null,
    options: [],
    calledTraveler: false,
    confirmation: null,
    receipts: [],
    claim: null,
    payout: null,
  };
}

const g = globalThis as unknown as {
  __agentRun?: AgentRun;
  __geminiKeyIdx?: number;
  __geminiCooldowns?: Record<string, number>; // key -> epoch ms until usable
};
if (!g.__agentRun) g.__agentRun = freshRun();
if (g.__geminiKeyIdx === undefined) g.__geminiKeyIdx = 0;
if (!g.__geminiCooldowns) g.__geminiCooldowns = {};

export function getAgentRun(): AgentRun {
  return g.__agentRun!;
}
export function resetAgentRun(): AgentRun {
  g.__agentRun = freshRun();
  return g.__agentRun;
}
function logLine(line: Omit<AgentLogLine, "at">) {
  g.__agentRun!.log.push({ ...line, at: Date.now() });
}

// ---------------------------------------------------------------------------
// Gemini free-tier plumbing: keys, rotation, cooldowns, backoff.
// ---------------------------------------------------------------------------

export function geminiKeys(): string[] {
  const multi = (process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.GEMINI_API_KEY || "").trim();
  return single ? [single] : [];
}

export function geminiModel(): string {
  // gemini-flash-latest: the alias every project (old or new) can use on the
  // free tier — older fixed ids 404 ("no longer available to new users") or
  // 429-with-zero-quota depending on the key's project age.
  return process.env.GEMINI_MODEL || "gemini-flash-latest";
}

export function isConfiguredAgent(): boolean {
  return geminiKeys().length > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function turnDelayMs(): number {
  const n = parseInt(process.env.GEMINI_TURN_DELAY_MS || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 2500; // free tier: stay well under RPM
}

// Pick the next key, skipping ones cooling down after a 429. If every key is
// cooling, wait for the soonest one.
async function nextKey(): Promise<string> {
  const keys = geminiKeys();
  if (!keys.length) throw new Error("No Gemini keys — set GEMINI_API_KEYS in .env");
  const cd = g.__geminiCooldowns!;
  for (let i = 0; i < keys.length; i++) {
    const idx = (g.__geminiKeyIdx! + i) % keys.length;
    const key = keys[idx];
    if ((cd[key] ?? 0) <= Date.now()) {
      g.__geminiKeyIdx = (idx + 1) % keys.length; // advance round-robin
      return key;
    }
  }
  const soonest = Math.min(...keys.map((k) => cd[k] ?? 0));
  const waitMs = Math.max(soonest - Date.now(), 1000);
  logLine({
    kind: "narration",
    text: `(all API keys rate-limited — pausing ${Math.ceil(waitMs / 1000)}s)`,
  });
  await sleep(waitMs);
  return nextKey();
}

function putOnCooldown(key: string, seconds: number) {
  g.__geminiCooldowns![key] = Date.now() + seconds * 1000;
}

// Try to read Google's suggested retry delay ("retryDelay": "37s") from a 429.
// Sub-second delays ("0.8s") parse to 0 — clamp to a real cooldown so we don't
// hammer the key in a tight rotate loop.
function parseRetryDelay(body: string): number | null {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/);
  return m ? Math.max(parseInt(m[1], 10), 5) : null;
}

// ---------------------------------------------------------------------------
// Gemini wire types (minimal subset of v1beta generateContent).
// ---------------------------------------------------------------------------

interface GPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GContent {
  role: "user" | "model";
  parts: GPart[];
}

interface GResponse {
  candidates?: Array<{
    content?: { role: string; parts?: GPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
}

// One model turn with key rotation + backoff. Throws only when every key is
// exhausted for the attempt budget.
async function geminiTurn(
  contents: GContent[],
  tools: unknown,
  system: string,
): Promise<GPart[]> {
  const keys = geminiKeys();
  const maxAttempts = Math.max(keys.length * 2, 4);
  let lastErr = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = await nextKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${key}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          tools,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
            // Latest flash models think by default — costs seconds + tokens per
            // turn. Our steps are simple; keep the demo snappy.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });
    } catch (e) {
      lastErr = `network: ${e instanceof Error ? e.message : e}`;
      await sleep(1500 * (attempt + 1));
      continue;
    }

    const text = await res.text();
    if (res.status === 429) {
      // Per-minute limits pass quickly; a violated PER-DAY quota means this
      // key's project is done until the midnight-Pacific reset — park it.
      const daily = text.includes("PerDay");
      const delay = daily ? 3600 : (parseRetryDelay(text) ?? 30);
      putOnCooldown(key, delay);
      logLine({
        kind: "narration",
        text: daily
          ? `(key ${keys.indexOf(key) + 1}/${keys.length} exhausted its DAILY free quota — parked)`
          : `(key ${keys.indexOf(key) + 1}/${keys.length} hit its per-minute limit — rotating, cooldown ${delay}s)`,
      });
      lastErr = daily ? "daily free-tier quota exhausted" : "429 rate-limited";
      // If every key is now parked for the day, fail fast with a clear message.
      if (daily && keys.every((k) => (g.__geminiCooldowns![k] ?? 0) > Date.now() + 600_000)) {
        throw new Error(
          "All Gemini keys have exhausted their DAILY free-tier quota (resets midnight Pacific). Add another key to GEMINI_API_KEYS, or enable billing on one project.",
        );
      }
      continue; // next key immediately
    }
    if (res.status >= 500 || res.status === 503) {
      lastErr = `HTTP ${res.status}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    let j: GResponse;
    try {
      j = JSON.parse(text) as GResponse;
    } catch {
      throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (j.error) throw new Error(`Gemini error: ${j.error.message}`);
    if (j.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the prompt: ${j.promptFeedback.blockReason}`);
    }
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    return parts;
  }
  throw new Error(`Gemini unavailable after ${maxAttempts} attempts (${lastErr})`);
}

// ---------------------------------------------------------------------------
// Tools — each maps to one of the team's endpoints (the frozen contract).
// OpenAPI-schema style, per Gemini function_declarations. No-arg tools omit
// `parameters` entirely (empty schemas can 400 on v1beta).
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
  {
    name: "get_disruption_event",
    description:
      "Fetch the current flight disruption: the cancelled flight and the affected traveler. Call this first.",
  },
  {
    name: "search_rebooking_options",
    description:
      "Search rebooking options for the disrupted traveler via Sabre flight search. Returns 3 options with fare differences, plus a `source` field telling you whether the data came from the live Sabre API or the canned fallback — mention which in your narration.",
  },
  {
    name: "call_traveler",
    description:
      "Place the phone call to the traveler via Vocal Bridge: the voice agent explains the cancellation, reads the 3 options, and captures their spoken choice. Returns immediately; use wait_for_traveler_choice for the outcome.",
  },
  {
    name: "wait_for_traveler_choice",
    description:
      "Wait for the traveler's spoken rebooking choice from the ongoing call. Blocks up to max_wait_seconds (default 60, max 90). Call again if still in progress. If the call failed or ended without a choice, returns that so you can fall back to option opt_2 (the recommended default).",
    parameters: {
      type: "object",
      properties: {
        max_wait_seconds: {
          type: "integer",
          description: "How long to wait before returning (default 60, max 90)",
        },
      },
    },
  },
  {
    name: "confirm_rebooking",
    description:
      "Confirm the rebooking on the chosen option. Issues the new PNR and automatically settles any fare difference with the payments system.",
    parameters: {
      type: "object",
      properties: {
        option_id: { type: "string", description: "The chosen option id, e.g. opt_2" },
      },
      required: ["option_id"],
    },
  },
  {
    name: "get_seat_map",
    description:
      "Look up seat availability for the confirmed flight via Sabre. Returns a cabin seat-map summary (open seats, window/aisle counts) when available; otherwise fare-level availability (seatsLeftAtThisFare). Call once, right after confirm_rebooking.",
  },
  {
    name: "read_receipts",
    description:
      "Wait for the traveler to upload their receipt photos (hotel folio + dinner receipt), then return the LandingAI document extraction for each: merchant, date, total, category. Blocks up to max_wait_seconds (default 75, max 90) while the traveler uploads; call it again if they still haven't. The result's `source` says whether the extracts came from the traveler's own upload or the bundled sample photos.",
    parameters: {
      type: "object",
      properties: {
        max_wait_seconds: {
          type: "integer",
          description: "How long to wait for the upload before returning (default 75, max 90)",
        },
      },
    },
  },
  {
    name: "build_claim",
    description:
      "Build the reimbursement claim from the extracted receipts against the airline's stranded-overnight commitments (hotel + meals). Returns the owed total.",
  },
  {
    name: "send_payout",
    description:
      "Send the claim's owed total to the traveler's PayPal. The final step — after this the traveler is made whole.",
  },
];

const GEMINI_TOOLS = [{ function_declarations: FUNCTION_DECLARATIONS }];

const SYSTEM_PROMPT = `You are Rescue Agent, the autonomous orchestrator for an airline disruption-rescue operation. A traveler's flight was just cancelled (a controllable cancellation with an overnight strand). Your job: make them whole, end to end, with no forms and no hold music.

The recovery you run, in order:
1. get_disruption_event
2. search_rebooking_options (Sabre flight search)
3. call_traveler (Vocal Bridge), then wait_for_traveler_choice for their spoken pick. If the call fails or no choice is captured after waiting twice, proceed with option opt_2 (the recommended default) and say you did so.
4. confirm_rebooking (fare differences settle automatically via the payments system)
5. get_seat_map — check seat availability on the confirmed flight; mention it in one narration sentence (e.g. open seats, or seats left at the fare if the full map isn't available).
6. read_receipts — WAIT for the traveler's uploaded photos (LandingAI extracts them). If it returns still_waiting, call it again; only proceed on extracted receipts.
7. build_claim, then send_payout (PayPal).

Rules:
- You MUST complete ALL steps above, in order, by calling their functions. Never skip a step, never substitute your own answer for a function's result, never conclude early. The system also enforces this: out-of-order calls return errors.
- EVERY fact you state must come from a function result in this conversation. Never invent, assume, or remember flight numbers, prices, totals, transaction ids, or times — fetch them.
- Before EVERY function call, write exactly one short present-tense sentence of narration for the live ops feed (e.g. "Pulling the disruption details."). No preamble, no lists, no markdown.
- When a result carries a source field, reflect it honestly in your narration (e.g. live Sabre data vs fallback options; the traveler's own receipts vs sample photos).
- Call ONE function at a time and use its result to decide the next step. Don't skip steps.
- After send_payout succeeds, end with a 2-3 sentence wrap-up: the new flight + PNR, what was reimbursed and the amount, and that the traveler is all set. Plain, warm, factual.
- If a function errors, try it once more; if it fails again, explain briefly and continue with the best available path.`;

// ---------------------------------------------------------------------------
// Tool execution — thin fetches against our own API (the team's seams).
// ---------------------------------------------------------------------------

async function fetchJSON<T>(base: string, route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${route}`, init);
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// The bundled sample photos, run through /api/receipts (REAL LandingAI), with
// per-file fallback to the canned extracts so the demo never dead-ends.
async function ocrBundledSamples(base: string): Promise<ReceiptExtract[]> {
  const samples = [
    { file: "sample-hotel.jpg", fallbackIdx: 0 },
    { file: "sample-meal.jpg", fallbackIdx: 1 },
  ];
  const demo = await fetchJSON<{ sampleReceipts: ReceiptExtract[] }>(base, "/api/demo/event");
  const receipts: ReceiptExtract[] = [];
  for (const s of samples) {
    try {
      const buf = await readFile(path.join(process.cwd(), s.file));
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(buf)], { type: "image/jpeg" }),
        s.file,
      );
      const res = await fetch(`${base}/api/receipts`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      receipts.push((await res.json()) as ReceiptExtract);
    } catch {
      const fb = demo.sampleReceipts[s.fallbackIdx];
      if (fb) receipts.push(fb);
    }
  }
  return receipts;
}

async function executeTool(
  base: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const run = getAgentRun();

  switch (name) {
    case "get_disruption_event": {
      const d = await fetchJSON<{
        event: DisruptionEvent;
        sampleReceipts: ReceiptExtract[];
      }>(base, `/api/demo/event?origin=${run.origin}&destination=${run.destination}`);
      run.event = d.event;
      return d.event;
    }

    case "search_rebooking_options": {
      if (!run.event) throw new Error("no disruption event yet — call get_disruption_event first");
      const res = await fetch(`${base}/api/rebook`, jsonPost(run.event));
      if (!res.ok) throw new Error(`/api/rebook -> HTTP ${res.status}`);
      const options = (await res.json()) as RebookOption[];
      run.options = options;
      const source = res.headers.get("x-rebook-source") ?? "unknown";
      return { source, options };
    }

    case "call_traveler": {
      if (!run.event) throw new Error("no disruption event yet");
      if (!run.options.length)
        throw new Error("no rebooking options yet — call search_rebooking_options first");
      const r = await fetchJSON<Record<string, unknown>>(
        base,
        "/api/voice/call",
        jsonPost({
          event: run.event,
          options: run.options,
          mode: run.live ? "real" : "mock",
        }),
      );
      run.calledTraveler = true;
      return {
        mode: r.mode,
        status: r.status,
        fellBackFrom: r.fellBackFrom ?? null,
        reason: r.reason ?? null,
      };
    }

    case "wait_for_traveler_choice": {
      const maxWait = Math.min(Math.max(Number(input.max_wait_seconds) || 60, 5), 90);
      const begun = Date.now();
      while (Date.now() - begun < maxWait * 1000) {
        const s = await fetchJSON<{
          status: string;
          chosenOption: RebookOption | null;
          callStatus: string | null;
          failReason: string | null;
        }>(base, "/api/voice/status");
        if (s.status === "picked" && s.chosenOption) {
          return { status: "picked", chosenOption: s.chosenOption };
        }
        if (s.status === "failed") {
          return {
            status: "failed",
            reason: s.failReason ?? "call failed",
            fallbackAdvice: "proceed with opt_2",
          };
        }
        await sleep(1000);
      }
      return {
        status: "still_waiting",
        advice: "call wait_for_traveler_choice again, or fall back to opt_2",
      };
    }

    case "confirm_rebooking": {
      if (!run.event) throw new Error("no disruption event yet");
      if (!run.calledTraveler)
        throw new Error(
          "the traveler has not been called yet — call_traveler and wait_for_traveler_choice must run before confirming",
        );
      const optionId = String(input.option_id || "");
      const option =
        run.options.find((o) => o.id === optionId) ?? run.options[1] ?? run.options[0];
      if (!option) throw new Error(`unknown option "${optionId}" and no fallback available`);
      const confirmation = await fetchJSON<Confirmation>(
        base,
        "/api/rebook/confirm",
        jsonPost({ option, traveler: run.event.traveler }),
      );
      run.confirmation = confirmation;
      return confirmation;
    }

    case "get_seat_map": {
      if (!run.confirmation)
        throw new Error("nothing confirmed yet — confirm_rebooking must run first");
      const opt = run.confirmation.chosenOption;
      const seatmap = await fetchJSON<Record<string, unknown>>(
        base,
        "/api/seatmap",
        jsonPost({
          option: opt,
          origin: run.event?.flight.origin,
          destination: run.event?.flight.destination,
        }),
      );
      return seatmap;
    }

    case "read_receipts": {
      // Block on the receipts inbox: the traveler uploads photos in the UI
      // (which runs them through /api/receipts = real LandingAI) or explicitly
      // opts for the bundled sample photos. The agent never helps itself to
      // data the traveler didn't provide.
      const maxWait = Math.min(Math.max(Number(input.max_wait_seconds) || 75, 5), 90);
      const begun = Date.now();
      while (Date.now() - begun < maxWait * 1000) {
        const inbox = getReceiptsInbox();
        if (inbox.receipts?.length) {
          run.receipts = inbox.receipts;
          return { source: "traveler_upload", receipts: inbox.receipts };
        }
        if (inbox.useBundled) {
          const receipts = await ocrBundledSamples(base);
          run.receipts = receipts;
          return { source: "bundled_sample_photos", receipts };
        }
        await sleep(1500);
      }
      return {
        status: "still_waiting",
        advice:
          "The traveler hasn't uploaded receipts yet. Call read_receipts again to keep waiting.",
      };
    }

    case "build_claim": {
      if (!run.event) throw new Error("no disruption event yet");
      if (!run.receipts.length) throw new Error("no receipts read yet — call read_receipts first");
      const claim = await fetchJSON<ReceiptClaim>(
        base,
        "/api/claim",
        jsonPost({ receipts: run.receipts, event: run.event }),
      );
      run.claim = claim;
      return claim;
    }

    case "send_payout": {
      if (!run.event || !run.claim) throw new Error("no claim built yet — call build_claim first");
      const payout = await fetchJSON<PayoutResult>(
        base,
        "/api/payout",
        jsonPost({ claim: run.claim, traveler: run.event.traveler }),
      );
      run.payout = payout;
      return payout;
    }

    default:
      throw new Error(`unknown function: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// The agent loop — Gemini function-calling with free-tier pacing.
// ---------------------------------------------------------------------------

const MAX_TURNS = 28; // hard stop well above the ~9 calls a clean run needs

export interface RunOpts {
  live: boolean;
  origin?: string;
  destination?: string;
}

function beginRun(opts: RunOpts, mode: OrchestratorMode): AgentRun {
  const run = resetAgentRun();
  resetReceiptsInbox(); // a fresh run waits for a fresh upload
  run.status = "running";
  run.live = opts.live;
  run.mode = mode;
  run.origin = (opts.origin || "DFW").toUpperCase();
  run.destination = (opts.destination || "LGA").toUpperCase();
  run.startedAt = Date.now();
  return run;
}

export async function runAgent(base: string, opts: RunOpts): Promise<void> {
  const run = beginRun(opts, "llm");
  const live = run.live;

  const contents: GContent[] = [
    {
      role: "user",
      parts: [
        {
          text:
            `A flight cancellation just landed on the ops board. Run the full recovery now. ` +
            `Voice mode: ${live ? "LIVE phone call — the traveler will actually answer, so waits can take 1-2 minutes" : "scripted call (resolves in seconds)"}.`,
        },
      ],
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const parts = await geminiTurn(contents, GEMINI_TOOLS, SYSTEM_PROMPT);
      const calls = parts.filter((p) => p.functionCall);

      // Narration first (text parts of this model turn).
      for (const p of parts) {
        const t = p.text?.trim();
        if (t) logLine({ kind: calls.length ? "narration" : "summary", text: t });
      }

      if (!calls.length) break; // finished (final wrap-up already logged)

      contents.push({ role: "model", parts });

      // Execute every requested call; reply with all responses in ONE user turn.
      const responses: GPart[] = [];
      for (const p of calls) {
        const fc = p.functionCall!;
        const argsJson =
          fc.args && Object.keys(fc.args).length ? JSON.stringify(fc.args) : undefined;
        logLine({ kind: "tool", tool: fc.name, text: fc.name, args: argsJson });
        const t0 = Date.now();
        try {
          const out = await executeTool(base, fc.name, fc.args ?? {});
          const summary = JSON.stringify(out);
          logLine({
            kind: "tool_result",
            tool: fc.name,
            text: summary.length > 1200 ? `${summary.slice(0, 1200)}…` : summary,
            durationMs: Date.now() - t0,
          });
          responses.push({
            functionResponse: { name: fc.name, response: { result: out } },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logLine({ kind: "error", tool: fc.name, text: msg, durationMs: Date.now() - t0 });
          responses.push({
            functionResponse: { name: fc.name, response: { error: msg } },
          });
        }
      }
      contents.push({ role: "user", parts: responses });

      // Free-tier pacing between model turns.
      await sleep(turnDelayMs());
    }

    run.status = "done";
    run.endedAt = Date.now();
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    run.endedAt = Date.now();
    logLine({ kind: "error", text: run.error });
  }
}

// ---------------------------------------------------------------------------
// DIRECT MODE — the same pipeline with no LLM: fixed order, fixed narration,
// same tools, same store, same trace. Runs when the operator picks "direct"
// (or when Gemini quota is gone). Waiting tools are re-called until resolved.
// ---------------------------------------------------------------------------

interface DirectStep {
  narration: string;
  tool: string;
  args?: () => Record<string, unknown>;
  // Re-call while the result says we're still waiting (choice/receipts).
  waitWhile?: (out: unknown) => boolean;
  maxWaitCalls?: number;
}

export async function runDirect(base: string, opts: RunOpts): Promise<void> {
  const run = beginRun(opts, "direct");
  run.model = "direct (no LLM)";

  const stillWaiting = (out: unknown) =>
    Boolean(out && typeof out === "object" && (out as { status?: string }).status === "still_waiting");

  const steps: DirectStep[] = [
    { narration: "Pulling the disruption details.", tool: "get_disruption_event" },
    { narration: "Searching Sabre for rebooking options.", tool: "search_rebooking_options" },
    { narration: "Calling the traveler to present the options.", tool: "call_traveler" },
    {
      narration: "Waiting for the traveler's choice.",
      tool: "wait_for_traveler_choice",
      waitWhile: stillWaiting,
      maxWaitCalls: 4, // up to ~6 min on a live call
    },
    {
      narration: "Confirming the rebooking.",
      tool: "confirm_rebooking",
      args: () => {
        // The voice store holds the spoken pick; fall back to opt_2 like the LLM would.
        return { option_id: getVoiceState().chosenOptionId ?? "opt_2" };
      },
    },
    { narration: "Checking seat availability on the confirmed flight.", tool: "get_seat_map" },
    {
      narration: "Waiting for the traveler's receipt photos.",
      tool: "read_receipts",
      waitWhile: stillWaiting,
      maxWaitCalls: 8, // up to ~12 min for the upload
    },
    { narration: "Building the reimbursement claim.", tool: "build_claim" },
    { narration: "Sending the payout to the traveler's PayPal.", tool: "send_payout" },
  ];

  try {
    for (const step of steps) {
      logLine({ kind: "narration", text: step.narration });
      let out: unknown;
      let calls = 0;
      const max = step.maxWaitCalls ?? 1;
      // Retry-once on hard errors; re-call while the tool reports waiting.
      for (;;) {
        const args = step.args?.() ?? {};
        const argsJson = Object.keys(args).length ? JSON.stringify(args) : undefined;
        logLine({ kind: "tool", tool: step.tool, text: step.tool, args: argsJson });
        const t0 = Date.now();
        try {
          out = await executeTool(base, step.tool, args);
          const summary = JSON.stringify(out);
          logLine({
            kind: "tool_result",
            tool: step.tool,
            text: summary.length > 1200 ? `${summary.slice(0, 1200)}…` : summary,
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logLine({ kind: "error", tool: step.tool, text: msg, durationMs: Date.now() - t0 });
          if (calls === 0 && !step.waitWhile) {
            calls++;
            logLine({ kind: "narration", text: "Retrying once." });
            continue;
          }
          throw new Error(`${step.tool}: ${msg}`);
        }
        calls++;
        if (step.waitWhile?.(out) && calls < max) continue;
        break;
      }
      // A waiting step that never resolved: proceed like the LLM would (opt_2 /
      // bundled receipts are handled inside the tools' own fallbacks).
    }

    const s = getAgentRun();
    const c = s.confirmation;
    const summary = [
      c
        ? `${s.event?.traveler.name ?? "The traveler"} is rebooked on ${c.chosenOption.carrier} ${c.chosenOption.flightNumber} (PNR ${c.newPNR}).`
        : null,
      s.claim ? `Reimbursement claim of $${s.claim.owedTotal} built from ${s.receipts.length} receipts.` : null,
      s.payout ? `$${s.payout.amount} sent to PayPal (txn ${s.payout.paypalTxnId}). All set.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    logLine({ kind: "summary", text: summary || "Run finished." });

    run.status = "done";
    run.endedAt = Date.now();
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    run.endedAt = Date.now();
    logLine({ kind: "error", text: run.error });
  }
}
