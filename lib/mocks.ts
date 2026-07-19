// /lib/mocks.ts — shared deterministic demo data (Person 2 + Person 3, merged).
// Keep this deterministic so the demo runs the same every time.
//
// Two naming sets coexist:
//   - Person 3 uses  mock*  (mockTraveler, mockDisruptionEvent, mockRebookOptions, mockSampleReceipts)
//   - Person 2 uses  sample*/rebookOptions  (sampleFlight, sampleTraveler, sampleEvent, rebookOptions)
// They point at the same story; both are kept so neither slice's imports break.

import {
  DisruptionEvent,
  Flight,
  RebookOption,
  ReceiptExtract,
  Traveler,
} from "./contracts";

// ─── Person 3's mocks ─────────────────────────────────────────────────────────
export const mockTraveler: Traveler = {
  name: "Alex Johnson",
  phone: "+14155550123",
  paypalId: process.env.PAYPAL_RECEIVER_EMAIL || "alex.traveler@example.com",
  homeAirport: "DFW",
};

export const mockDisruptionEvent: DisruptionEvent = {
  flight: {
    flightNumber: "AA123",
    carrier: "American Airlines",
    date: "2026-07-18",
    origin: "DFW",
    destination: "LGA",
    scheduledDep: "2026-07-18T18:30:00Z",
    scheduledArr: "2026-07-18T22:45:00Z",
  },
  traveler: mockTraveler,
  reason: "controllable_cancellation",
  strandedOvernight: true,
};

export const mockRebookOptions: RebookOption[] = [
  {
    id: "opt_1",
    carrier: "American Airlines",
    flightNumber: "AA456",
    depTime: "2026-07-19T06:10:00Z",
    arrTime: "2026-07-19T10:30:00Z",
    fareDifference: 0,
  },
  {
    id: "opt_2",
    carrier: "American Airlines",
    flightNumber: "AA512",
    depTime: "2026-07-19T08:45:00Z",
    arrTime: "2026-07-19T13:05:00Z",
    fareDifference: 0,
  },
  {
    id: "opt_3",
    carrier: "American Airlines",
    flightNumber: "AA789",
    depTime: "2026-07-19T07:00:00Z",
    arrTime: "2026-07-19T12:40:00Z",
    fareDifference: 45,
  },
];

export const mockSampleReceipts: ReceiptExtract[] = [
  { merchant: "Hilton DFW Airport", date: "2026-07-18", total: 189, category: "hotel" },
  { merchant: "Olive Garden", date: "2026-07-18", total: 58, category: "meal" },
];

// ─── Person 2's mocks (rebook + voice) ────────────────────────────────────────
// The flight that gets cancelled in the golden path.
export const sampleFlight: Flight = {
  flightNumber: "AA123",
  carrier: "American Airlines",
  date: "2026-07-18",
  origin: "DFW",
  destination: "LGA",
  scheduledDep: "2026-07-18T17:30:00-05:00", // 5:30pm CDT out of DFW
  scheduledArr: "2026-07-18T21:55:00-04:00", // 9:55pm EDT into LGA
};

// The traveler we call. Set DEMO_TRAVELER_PHONE to your own number to test the call.
export const sampleTraveler: Traveler = {
  name: "Alex Rivera",
  phone: process.env.DEMO_TRAVELER_PHONE || "+14155550123",
  paypalId:
    process.env.DEMO_TRAVELER_PAYPAL ||
    process.env.PAYPAL_RECEIVER_EMAIL ||
    "sb-buyer@example.com",
  homeAirport: "DFW",
};

// The disruption that kicks off the flow (the "Simulate Cancellation" button builds one).
export const sampleEvent: DisruptionEvent = {
  flight: sampleFlight,
  traveler: sampleTraveler,
  reason: "controllable_cancellation",
  strandedOvernight: true,
};

// ─── Route selection (product mode) ──────────────────────────────────────────
// Airports the dashboard offers for the simulation. code -> display name.
export const AIRPORTS: Record<string, string> = {
  DFW: "Dallas–Fort Worth",
  LGA: "New York LaGuardia",
  JFK: "New York JFK",
  SFO: "San Francisco",
  LAX: "Los Angeles",
  ORD: "Chicago O'Hare",
  ATL: "Atlanta",
  MIA: "Miami",
  SEA: "Seattle",
  BOS: "Boston",
  DEN: "Denver",
  AUS: "Austin",
};

// Build a DisruptionEvent for any route, dated today — the cancelled-flight
// premise stays AA123, but everything downstream (Sabre search, voice, claim)
// keys off the chosen airports.
export function makeEvent(origin: string, destination: string): DisruptionEvent {
  const o = AIRPORTS[origin] ? origin : "DFW";
  const d = AIRPORTS[destination] && destination !== o ? destination : o === "LGA" ? "DFW" : "LGA";
  const today = new Date().toISOString().slice(0, 10);
  return {
    flight: {
      ...sampleFlight,
      origin: o,
      destination: d,
      date: today,
      scheduledDep: `${today}T17:30:00`,
      scheduledArr: `${today}T21:55:00`,
    },
    traveler: sampleTraveler,
    reason: "controllable_cancellation",
    strandedOvernight: true,
  };
}

// Person 2's mocked "Sabre" search results — 3 believable AA options, DFW -> LGA.
// Controllable cancellation => same-airline rebooking is free (fareDifference 0),
// which matches the DOT-commitment story. opt_3 is a partner routing with a delta.
export const rebookOptions: RebookOption[] = [
  {
    id: "opt_1",
    carrier: "American Airlines",
    flightNumber: "AA456",
    depTime: "2026-07-18T06:10:00-05:00", // 6:10am CDT DFW
    arrTime: "2026-07-18T10:30:00-04:00", // 10:30am EDT LGA
    fareDifference: 0,
  },
  {
    id: "opt_2",
    carrier: "American Airlines",
    flightNumber: "AA512",
    depTime: "2026-07-18T08:45:00-05:00", // 8:45am CDT DFW
    arrTime: "2026-07-18T13:05:00-04:00", // 1:05pm EDT LGA
    fareDifference: 0,
  },
  {
    id: "opt_3",
    carrier: "American Airlines", // partner routing via CLT
    flightNumber: "AA/US2140 via CLT",
    depTime: "2026-07-18T07:00:00-05:00", // 7:00am CDT DFW
    arrTime: "2026-07-18T12:40:00-04:00", // 12:40pm EDT LGA
    fareDifference: 45,
  },
];

// The option the scripted fallback (and most demos) picks.
export const DEFAULT_PICK_ID = "opt_2";
