// /lib/mocks.ts — shared deterministic demo data.
// Person 1 builds the UI against these. Person 2 (rebook) reads `rebookOptions`.
// Keep this deterministic so the demo runs the same every time.

import type {
  DisruptionEvent,
  Flight,
  RebookOption,
  Traveler,
} from "./contracts";

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

// The traveler we call. Set `phone` to your own number to test the real call.
// (Person 1 can override phone/paypalId from the shared .env for the live demo.)
export const sampleTraveler: Traveler = {
  name: "Alex Rivera",
  phone: process.env.DEMO_TRAVELER_PHONE || "+14155550123",
  paypalId: process.env.DEMO_TRAVELER_PAYPAL || "sb-buyer@example.com",
  homeAirport: "DFW",
};

// The disruption that kicks off the whole flow (the "Simulate Cancellation" button
// builds one of these).
export const sampleEvent: DisruptionEvent = {
  flight: sampleFlight,
  traveler: sampleTraveler,
  reason: "controllable_cancellation",
  strandedOvernight: true,
};

// ---------------------------------------------------------------------------
// Person 2's mocked "Sabre" search results.
// 3 believable American Airlines rebooking options, DFW -> LGA, same day.
// Controllable cancellation => same-airline rebooking is free (fareDifference 0),
// which matches the DOT-commitment story. opt_3 is a partner routing with a delta.
// ---------------------------------------------------------------------------
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
