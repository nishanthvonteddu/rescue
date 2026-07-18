// vocalbridge/gen-config.mjs
// Generates the Vocal Bridge AGENT configuration from the frozen demo options:
//   - agent-prompt.txt        the system prompt (reads options, asks 1/2/3, calls submit_choice)
//   - outbound-greeting.txt   the first line the agent says when the traveler answers
//   - api-tools.template.json  the submit_choice HTTP tool ($PUBLIC_BASE_URL is filled in at setup)
//
// Mirrors the 3 options in /lib/mocks.ts and the phrasing in /lib/voiceScript.ts.
// Re-run after changing the options:  node vocalbridge/gen-config.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const flight = { number: "AA123", carrier: "American Airlines", origin: "DFW", destination: "LGA" };
const travelerName = "Alex Rivera";

const options = [
  { id: "opt_1", carrier: "American Airlines", flightNumber: "AA456", dep: "6:10 AM", arr: "10:30 AM", fareDifference: 0 },
  { id: "opt_2", carrier: "American Airlines", flightNumber: "AA512", dep: "8:45 AM", arr: "1:05 PM", fareDifference: 0 },
  { id: "opt_3", carrier: "American Airlines", flightNumber: "AA/US2140 via CLT", dep: "7:00 AM", arr: "12:40 PM", fareDifference: 45 },
];

const ORD = ["", "one", "two", "three"];
const describe = (o, i) => {
  const base = `Option ${ORD[i + 1]}: ${o.carrier} flight ${o.flightNumber}, departing ${o.dep}, arriving ${o.arr}`;
  return o.fareDifference > 0
    ? `${base}. There's a fare difference of $${o.fareDifference}, which we'd cover.`
    : `${base}, at no extra cost to you.`;
};

const prompt = `You are a calm, friendly airline rebooking assistant calling on behalf of ${flight.carrier}.
You are calling ${travelerName}.

SITUATION: Their flight ${flight.number} from ${flight.origin} to ${flight.destination} today was cancelled by the airline (a controllable cancellation). They may be stranded overnight. You can rebook them right now, for free, on the next available flights.

Read them these three options clearly, one at a time:
${options.map((o, i) => `  - ${describe(o, i)} (option id: ${o.id})`).join("\n")}

Then ask: "Which would you like — one, two, or three?"

IMPORTANT: As soon as the traveler picks an option, call the tool "submit_choice" with the matching option id (one of: ${options.map((o) => o.id).join(", ")}). If they say a number ("two") or a flight number, map it to the right option id. After the tool call, confirm warmly: "You're all set — I've rebooked you and you'll get a confirmation shortly." Then end the call.

Keep it short and natural. Do not invent flights or prices beyond the three options above.`;

const greeting = `Hi ${travelerName}, this is the ${flight.carrier} rebooking assistant. Your flight ${flight.number} from ${flight.origin} to ${flight.destination} was just cancelled by the airline. I'm sorry about that — I can rebook you right now, for free. Can I read you a few options?`;

// Custom HTTP API Tool. The agent invokes this mid-call; Vocal Bridge POSTs the
// arguments to `url`. $PUBLIC_BASE_URL is substituted by setup-agent.sh (your ngrok URL).
// NOTE: field names follow the documented shape (name/description/method/url/auth/parameters).
// After creating the agent, verify against `vb config get api-tools` and adjust if needed.
const apiTools = {
  tools: [
    {
      name: "submit_choice",
      description:
        "Record the rebooking option the traveler chose. Call this as soon as they pick one (by number, word, or flight number).",
      method: "POST",
      url: "$PUBLIC_BASE_URL/api/voice/webhook",
      auth: { type: "none" },
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
    },
  ],
};

writeFileSync(join(here, "agent-prompt.txt"), prompt + "\n");
writeFileSync(join(here, "outbound-greeting.txt"), greeting + "\n");
writeFileSync(join(here, "api-tools.template.json"), JSON.stringify(apiTools, null, 2) + "\n");
console.log("Wrote agent-prompt.txt, outbound-greeting.txt, api-tools.template.json");
