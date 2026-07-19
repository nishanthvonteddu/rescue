// /lib/voiceScript.ts — the words the voice agent says, in one place.
//
// Two consumers:
//   1) the REAL Vocal Bridge call (buildAgentPrompt / buildFirstMessage) — the
//      instructions + opening line we hand to Vocal Bridge.
//   2) the FALLBACK scripted transcript (buildTranscript) — the exact same call
//      rendered as on-screen text with a hardcoded pick, for when the live call
//      flakes on stage.

import type { DisruptionEvent, RebookOption } from "./contracts";
import type { TranscriptLine } from "./store";

// "8:45 AM" from an ISO string, in the timezone baked into the offset.
export function fmtTime(iso: string): string {
  // Parse the wall-clock time directly from the ISO string so we render the
  // local airport time regardless of the server's timezone.
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

const ORDINALS = ["", "one", "two", "three", "four", "five"];

// A single spoken sentence describing one option.
export function describeOption(opt: RebookOption, index: number): string {
  let base = `Option ${ORDINALS[index + 1] || index + 1}: ${opt.carrier} flight ${opt.flightNumber}, departing ${fmtTime(opt.depTime)}, arriving ${fmtTime(opt.arrTime)}`;
  // Live-availability color: worth saying only when seats are actually scarce.
  if (typeof opt.seatsLeft === "number" && opt.seatsLeft <= 6) {
    base += ` — only ${opt.seatsLeft} seat${opt.seatsLeft === 1 ? "" : "s"} left`;
  }
  if (opt.fareDifference > 0) {
    return `${base}. There's a fare difference of $${opt.fareDifference}, which we'd cover.`;
  }
  return `${base}, at no extra cost to you.`;
}

// System-prompt / instructions for the Vocal Bridge agent. This tells the agent
// who it is, what happened, the options, and — critically — to call the
// `submit_choice` tool with the chosen option id when the traveler decides.
//
// Written as CONVERSATION RULES, not a linear script: the traveler can talk at
// any moment (interrupt, pick early, ask a question) and the agent responds to
// what was said instead of restarting its pitch.
export function buildAgentPrompt(
  event: DisruptionEvent,
  options: RebookOption[],
): string {
  const { traveler, flight } = event;
  const optionLines = options
    .map((o, i) => `  - ${describeOption(o, i)} (option id: ${o.id})`)
    .join("\n");

  return [
    `You're a rebooking agent calling ${traveler.name} on behalf of ${flight.carrier}'s disruption-rescue service. Talk like a real person: casual, warm, natural. There is NO script — improvise your wording every time, react to what they actually say, and keep every turn to one or two short sentences.`,
    ``,
    `THE FACTS (the only facts you may use):`,
    `- Their flight ${flight.flightNumber} from ${flight.origin} to ${flight.destination} today was cancelled by the airline. They may be stranded overnight.`,
    `- You can rebook them right now at no hassle. The available flights (any airline is fine — present them naturally):`,
    optionLines,
    ``,
    `YOUR ONLY JOB: make sure they understand the cancellation, help them pick one of these flights, record the pick, confirm, done. A natural opening is a quick hello, the bad news in one sentence, and asking if they want to hear their options — but say it your own way.`,
    ``,
    `CONVERSATION RULES — they can speak at ANY moment and what they say always wins:`,
    `- NEVER restart or re-pitch. Track the conversation and continue from where things are.`,
    `- The moment they pick — a number, "the second one", a flight number, a time ("the 8:45") — stop, record it, confirm casually, wrap up. Don't keep listing.`,
    `- Asked to repeat? Repeat just that bit. Asked a question about the flights (fastest, arrival, difference, seats)? Answer in one sentence from the facts above, then bring it back to the choice.`,
    `- Ambiguous answer → one quick check ("The ${options[1]?.flightNumber ?? "second"} one, yeah?").`,
    `- STRICT SCOPE: you do NOT discuss anything except this rebooking. No general questions, no other topics, no advice, no small talk beyond a friendly hello. If they ask about ANYTHING else — refunds, baggage, weather, other trips, anything — say only: "I can just help with the rebooking on this call — a specialist will text you about anything else." Then return to the choice. Never answer the off-topic question itself, never invent airline policy.`,
    `- If they decline all options or can't talk, say a specialist will follow up by text and end politely. Do not record a choice.`,
    ``,
    `RECORDING THE CHOICE (important): "submit_choice" runs in your BACKGROUND system — you cannot call it directly. The moment they pick, call submit_background_query with exactly: "Call submit_choice with optionId opt_N" — replacing opt_N with one of ${options.map((o) => o.id).join(", ")} to match their choice (map a spoken number/word/flight number/time to the right id). This runs silently; keep talking naturally and do NOT mention tools or systems. Right after, confirm warmly in your own words that they're rebooked and will get a confirmation, then end the call.`,
    ``,
    `Never invent flights, prices, seats, or policies beyond the facts above.`,
  ].join("\n");
}

// The first thing the agent says when the traveler answers.
export function buildFirstMessage(event: DisruptionEvent): string {
  const { traveler, flight } = event;
  return `Hi ${traveler.name}, this is the ${flight.carrier} rebooking assistant. Your flight ${flight.flightNumber} from ${flight.origin} to ${flight.destination} was just cancelled by the airline. I'm sorry about that — I can rebook you right now, for free. Can I read you a few options?`;
}

// The FALLBACK: the same call as on-screen text, ending in a hardcoded pick.
// `chosenId` defaults to opt_2 to match the golden path.
export function buildTranscript(
  event: DisruptionEvent,
  options: RebookOption[],
  chosenId: string,
): TranscriptLine[] {
  const { traveler, flight } = event;
  const chosen = options.find((o) => o.id === chosenId) || options[1] || options[0];
  const chosenIndex = options.findIndex((o) => o.id === chosen.id);
  const chosenWord = ORDINALS[chosenIndex + 1] || `${chosenIndex + 1}`;

  const lines: TranscriptLine[] = [
    { speaker: "agent", text: buildFirstMessage(event) },
    { speaker: "traveler", text: "Oh no. Yes, please — go ahead." },
    {
      speaker: "agent",
      text: `Great. I have three options to get you from ${flight.origin} to ${flight.destination} today.`,
    },
  ];

  options.forEach((o, i) => {
    lines.push({ speaker: "agent", text: describeOption(o, i) });
  });

  lines.push({
    speaker: "agent",
    text: "Which would you like — one, two, or three?",
  });
  lines.push({
    speaker: "traveler",
    text: `Let's do option ${chosenWord}.`,
  });
  lines.push({
    speaker: "agent",
    text: `Perfect — option ${chosenWord}, ${chosen.carrier} ${chosen.flightNumber} arriving ${fmtTime(chosen.arrTime)}. You're all set, ${traveler.name}. I've rebooked you and you'll get a confirmation shortly. Safe travels!`,
  });

  return lines;
}
