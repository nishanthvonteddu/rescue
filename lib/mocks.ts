import { DisruptionEvent, Traveler, RebookOption, ReceiptExtract, ReceiptClaim, PayoutResult } from "./contracts";

export const mockTraveler: Traveler = {
  name: "Alex Johnson",
  phone: "+14155550123",
  paypalId: process.env.PAYPAL_RECEIVER_EMAIL || "alex.traveler@example.com",
  homeAirport: "DFW"
};

export const mockDisruptionEvent: DisruptionEvent = {
  flight: {
    flightNumber: "AA123",
    carrier: "American Airlines",
    date: "2026-07-18",
    origin: "DFW",
    destination: "LGA",
    scheduledDep: "2026-07-18T18:30:00Z",
    scheduledArr: "2026-07-18T22:45:00Z"
  },
  traveler: mockTraveler,
  reason: "controllable_cancellation",
  strandedOvernight: true
};

export const mockRebookOptions: RebookOption[] = [
  {
    id: "opt_1",
    carrier: "American Airlines",
    flightNumber: "AA456",
    depTime: "2026-07-19T06:10:00Z",
    arrTime: "2026-07-19T10:30:00Z",
    fareDifference: 0
  },
  {
    id: "opt_2",
    carrier: "American Airlines",
    flightNumber: "AA512",
    depTime: "2026-07-19T08:45:00Z",
    arrTime: "2026-07-19T13:05:00Z",
    fareDifference: 0
  },
  {
    id: "opt_3",
    carrier: "American Airlines",
    flightNumber: "AA789",
    depTime: "2026-07-19T07:00:00Z",
    arrTime: "2026-07-19T12:40:00Z",
    fareDifference: 45
  }
];

export const mockSampleReceipts: ReceiptExtract[] = [
  {
    merchant: "Hilton DFW Airport",
    date: "2026-07-18",
    total: 189,
    category: "hotel"
  },
  {
    merchant: "Olive Garden",
    date: "2026-07-18",
    total: 58,
    category: "meal"
  }
];
