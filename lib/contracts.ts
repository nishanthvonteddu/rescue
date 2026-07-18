// /lib/contracts.ts — FROZEN
// Do not change a field without telling the other two people.
// Every endpoint speaks these exact shapes. This is what makes the three
// slices combine on the first try.

export interface Flight {
  flightNumber: string; // "AA123"
  carrier: string; // "American Airlines"
  date: string; // "2026-07-18"
  origin: string; // "DFW"
  destination: string; // "LGA"
  scheduledDep: string; // ISO 8601
  scheduledArr: string; // ISO 8601
}

export interface Traveler {
  name: string;
  phone: string; // E.164, e.g. "+14155550123"
  paypalId: string; // sandbox receiver email
  homeAirport: string; // "DFW"
}

export interface DisruptionEvent {
  flight: Flight;
  traveler: Traveler;
  reason: "controllable_cancellation" | "controllable_delay" | "diversion";
  strandedOvernight: boolean;
}

export interface RebookOption {
  id: string; // "opt_1"
  carrier: string;
  flightNumber: string;
  depTime: string; // ISO
  arrTime: string; // ISO
  fareDifference: number; // USD, 0 for a free controllable rebook
}

export interface Confirmation {
  newPNR: string;
  chosenOption: RebookOption;
  fareDifferenceSettled: boolean;
}

export interface ReceiptExtract {
  merchant: string;
  date: string; // "2026-07-18"
  total: number; // USD
  category: "hotel" | "meal" | "ground_transport" | "other";
}

export interface ReceiptClaim {
  items: ReceiptExtract[];
  owedTotal: number;
  commitmentsMet: string[]; // ["hotel","meal"]
}

export interface PayoutResult {
  status: "sent" | "failed";
  amount: number;
  paypalTxnId: string;
}
