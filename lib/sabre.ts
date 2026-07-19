// /lib/sabre.ts — REAL Sabre flight search (Bargain Finder Max).
//
// Flow: OAuth2 client_credentials against /v2/auth/token (Sabre's quirk: the
// Basic credential is base64(base64(id):base64(secret))), then POST
// /v4/offers/shop with an OTA_AirLowFareSearchRQ. The grouped-itinerary
// response (GIR) is normalized into the frozen RebookOption contract:
// cheapest fare = fareDifference 0, others carry the real price delta.
//
// Env:
//   SABRE_ACCESS_TOKEN                     — pre-issued hackathon bearer token
//                                            (used directly; no OAuth round trip)
//   SABRE_CLIENT_ID / SABRE_CLIENT_SECRET  — alternative: OAuth client creds
//   SABRE_PCC                              — pseudo city code (hackathon: S5OM)
//   SABRE_BASE_URL                         — default https://api.cert.platform.sabre.com
//
// Every parse step is defensive: any surprise shape throws, and the caller
// (/api/rebook) falls back to the canned options so the demo never dies.

import type { DisruptionEvent, RebookOption } from "./contracts";

export function isConfiguredSabre(): boolean {
  return Boolean(
    process.env.SABRE_ACCESS_TOKEN ||
      (process.env.SABRE_CLIENT_ID && process.env.SABRE_CLIENT_SECRET),
  );
}

function pcc(): string {
  return process.env.SABRE_PCC || "S5OM";
}

function baseUrl(): string {
  return (process.env.SABRE_BASE_URL || "https://api.cert.platform.sabre.com").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Token (cached until shortly before expiry).
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __sabreToken?: { token: string; expiresAt: number };
};

async function getToken(): Promise<string> {
  // Pre-issued token (hackathon) wins — no OAuth round trip.
  const staticToken = process.env.SABRE_ACCESS_TOKEN?.trim();
  if (staticToken) return staticToken;

  const cached = g.__sabreToken;
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const id = process.env.SABRE_CLIENT_ID!;
  const secret = process.env.SABRE_CLIENT_SECRET!;
  // Sabre v2 auth: Basic base64( base64(id) : base64(secret) )
  const credentials = Buffer.from(
    `${Buffer.from(id).toString("base64")}:${Buffer.from(secret).toString("base64")}`,
  ).toString("base64");

  const res = await fetch(`${baseUrl()}/v2/auth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Sabre auth failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const j = JSON.parse(body) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Sabre auth: no access_token in response");
  g.__sabreToken = {
    token: j.access_token,
    expiresAt: Date.now() + ((j.expires_in ?? 1800) - 60) * 1000,
  };
  return j.access_token;
}

// ---------------------------------------------------------------------------
// Bargain Finder Max search → RebookOption[3]
// ---------------------------------------------------------------------------

const CARRIER_NAMES: Record<string, string> = {
  AA: "American Airlines",
  DL: "Delta Air Lines",
  UA: "United Airlines",
  B6: "JetBlue",
  WN: "Southwest",
  AS: "Alaska Airlines",
  NK: "Spirit",
  F9: "Frontier",
};

interface GIRSchedule {
  id: number;
  carrier?: { marketing?: string; marketingFlightNumber?: number };
  departure?: { airport?: string; time?: string };
  arrival?: { airport?: string; time?: string; dateAdjustment?: number };
}
interface GIRLeg {
  id: number;
  schedules?: Array<{ ref: number }>;
}
interface GIRResponse {
  groupedItineraryResponse?: {
    scheduleDescs?: GIRSchedule[];
    legDescs?: GIRLeg[];
    itineraryGroups?: Array<{
      groupDescription?: { legDescriptions?: Array<{ departureDate?: string }> };
      itineraries?: Array<{
        legs?: Array<{ ref: number }>;
        pricingInformation?: Array<{
          fare?: { totalFare?: { totalPrice?: number } };
        }>;
      }>;
    }>;
  };
}

// "2026-07-19" + "06:10" (+ dayAdjust) -> "2026-07-19T06:10:00"
function isoLocal(date: string, time: string | undefined, dayAdjust = 0): string {
  const t = (time || "00:00").slice(0, 5);
  if (!dayAdjust) return `${date}T${t}:00`;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayAdjust);
  return `${d.toISOString().slice(0, 10)}T${t}:00`;
}

async function shop(
  origin: string,
  destination: string,
  date: string,
  token: string,
): Promise<RebookOption[]> {
  const rq = {
    OTA_AirLowFareSearchRQ: {
      Version: "4",
      POS: {
        Source: [
          {
            PseudoCityCode: pcc(),
            RequestorID: {
              Type: "1",
              ID: "1",
              CompanyName: { Code: "TN" },
            },
          },
        ],
      },
      OriginDestinationInformation: [
        {
          RPH: "1",
          DepartureDateTime: `${date}T00:00:00`,
          OriginLocation: { LocationCode: origin },
          DestinationLocation: { LocationCode: destination },
        },
      ],
      TravelerInfoSummary: {
        AirTravelerAvail: [
          { PassengerTypeQuantity: [{ Code: "ADT", Quantity: 1 }] },
        ],
      },
      TPA_Extensions: {
        IntelliSellTransaction: { RequestType: { Name: "50ITINS" } },
      },
    },
  };

  const res = await fetch(`${baseUrl()}/v4/offers/shop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(rq),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Sabre BFM HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const j = JSON.parse(body) as GIRResponse;
  const gir = j.groupedItineraryResponse;
  if (!gir) throw new Error("Sabre BFM: no groupedItineraryResponse");

  const schedules = new Map<number, GIRSchedule>(
    (gir.scheduleDescs ?? []).map((s) => [s.id, s]),
  );
  const legs = new Map<number, GIRLeg>((gir.legDescs ?? []).map((l) => [l.id, l]));

  const bagDescs = new Map<number, { pieceCount?: number; weight?: number; unit?: string }>(
    ((gir as GIRResponse["groupedItineraryResponse"] & {
      baggageAllowanceDescs?: Array<{ id: number; pieceCount?: number; weight?: number; unit?: string }>;
    })!.baggageAllowanceDescs ?? []).map((b) => [b.id, b]),
  );

  interface Cand {
    carrierCode: string;
    flightNumber: string;
    via: string | null;
    stops: number;
    depTime: string;
    arrTime: string;
    price: number;
    seatsLeft?: number;
    cabin?: string;
    bookingCode?: string;
    checkedBags?: number;
  }
  const candidates: Cand[] = [];

  for (const group of gir.itineraryGroups ?? []) {
    const depDate =
      group.groupDescription?.legDescriptions?.[0]?.departureDate || date;
    for (const itin of group.itineraries ?? []) {
      const legRef = itin.legs?.[0]?.ref;
      const leg = legRef !== undefined ? legs.get(legRef) : undefined;
      const schedRefs = leg?.schedules?.map((s) => s.ref) ?? [];
      if (!schedRefs.length) continue;
      const segs = schedRefs
        .map((r) => schedules.get(r))
        .filter((s): s is GIRSchedule => Boolean(s));
      if (!segs.length) continue;

      const first = segs[0];
      const last = segs[segs.length - 1];
      const fare = itin.pricingInformation?.[0]?.fare as
        | {
            totalFare?: { totalPrice?: number };
            passengerInfoList?: Array<{
              passengerInfo?: {
                fareComponents?: Array<{
                  segments?: Array<{
                    segment?: {
                      bookingCode?: string;
                      cabinCode?: string;
                      seatsAvailable?: number;
                    };
                  }>;
                }>;
                baggageInformation?: Array<{ allowance?: { ref?: number } }>;
              };
            }>;
          }
        | undefined;
      const price = fare?.totalFare?.totalPrice;
      if (typeof price !== "number") continue;

      // Seats remaining at this fare = min across the leg's segments; cabin +
      // booking class from the first segment. Baggage: allowance ref -> descs.
      const pinfo = fare?.passengerInfoList?.[0]?.passengerInfo;
      const segMetas =
        pinfo?.fareComponents?.flatMap((fc) =>
          (fc.segments ?? []).map((s) => s.segment).filter(Boolean),
        ) ?? [];
      const seatCounts = segMetas
        .map((s) => s?.seatsAvailable)
        .filter((n): n is number => typeof n === "number");
      const bagRef = pinfo?.baggageInformation?.[0]?.allowance?.ref;
      const bag = bagRef !== undefined ? bagDescs.get(bagRef) : undefined;

      const code = first.carrier?.marketing || "??";
      candidates.push({
        carrierCode: code,
        flightNumber: `${code}${first.carrier?.marketingFlightNumber ?? ""}`,
        via: segs.length > 1 ? (first.arrival?.airport ?? null) : null,
        stops: segs.length - 1,
        depTime: isoLocal(depDate, first.departure?.time),
        arrTime: isoLocal(depDate, last.arrival?.time, last.arrival?.dateAdjustment ?? 0),
        price,
        seatsLeft: seatCounts.length ? Math.min(...seatCounts) : undefined,
        cabin: segMetas[0]?.cabinCode,
        bookingCode: segMetas[0]?.bookingCode,
        checkedBags: bag?.pieceCount,
      });
    }
  }

  if (!candidates.length) throw new Error("Sabre BFM: zero itineraries parsed");

  // Prefer nonstops, then cheapest; dedupe by flight number.
  candidates.sort((a, b) => a.stops - b.stops || a.price - b.price);
  const seen = new Set<string>();
  const top: Cand[] = [];
  for (const c of candidates) {
    if (seen.has(c.flightNumber)) continue;
    seen.add(c.flightNumber);
    top.push(c);
    if (top.length === 3) break;
  }

  const minPrice = Math.min(...top.map((c) => c.price));
  return top.map((c, i) => ({
    id: `opt_${i + 1}`,
    carrier: CARRIER_NAMES[c.carrierCode] ?? c.carrierCode,
    flightNumber: c.via ? `${c.flightNumber} via ${c.via}` : c.flightNumber,
    depTime: c.depTime,
    arrTime: c.arrTime,
    fareDifference: Math.round(c.price - minPrice),
    seatsLeft: c.seatsLeft,
    cabin: c.cabin,
    bookingCode: c.bookingCode,
    checkedBags: c.checkedBags,
    priceTotal: Math.round(c.price * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Seat map (EnhancedSeatMap). NOTE: needs the "Seat Map" product on your Sabre
// credentials — hackathon tokens return 403 NOT_AUTHORIZED, which we surface
// as { available: false } so the loop degrades to fare-level availability.
// ---------------------------------------------------------------------------

export interface SeatMapSummary {
  available: boolean;
  reason?: string;
  flight?: string;
  cabin?: string;
  totalSeats?: number;
  openSeats?: number;
  openWindow?: number;
  openAisle?: number;
  sampleOpenSeats?: string[]; // e.g. ["12A", "14C", ...] first few
}

export async function getSeatMap(
  option: RebookOption,
  date: string,
  origin: string,
  destination: string,
): Promise<SeatMapSummary> {
  const m = option.flightNumber.match(/^([A-Z0-9]{2})\s?(\d+)/);
  if (!m) return { available: false, reason: "unparseable flight number" };
  const [, carrier, num] = m;

  const token = await getToken();
  const res = await fetch(`${baseUrl()}/v4/book/flights/seatmaps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      EnhancedSeatMapRQ: {
        SeatMapQueryEnhanced: {
          RequestType: "Payload",
          Flight: {
            origin,
            destination,
            DepartureDate: { content: date },
            Marketing: [{ carrier, content: num }],
          },
          CabinDefinition: { RBD: option.bookingCode || "Y" },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (res.status === 403) {
    return {
      available: false,
      reason: "Seat Map API not enabled on these Sabre credentials",
      flight: option.flightNumber,
    };
  }
  if (!res.ok) {
    return { available: false, reason: `HTTP ${res.status}`, flight: option.flightNumber };
  }

  // Normalize the cabin grid into open-seat counts. Shapes vary by airline;
  // walk defensively for Row/Seat entries with occupiedInd / Occupied flags.
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const rows: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o.RowNumber !== undefined || o.rowNumber !== undefined) rows.push(o);
        Object.values(o).forEach(walk);
      }
    };
    walk(j);

    let total = 0,
      open = 0,
      window = 0,
      aisle = 0;
    const samples: string[] = [];
    for (const row of rows) {
      const rowNum = String(row.RowNumber ?? row.rowNumber ?? "");
      const seats = (row.Seat ?? row.seats ?? []) as Array<Record<string, unknown>>;
      for (const seat of Array.isArray(seats) ? seats : []) {
        total++;
        const occupied = Boolean(
          seat.occupiedInd ?? seat.OccupiedInd ?? seat.occupied ?? false,
        );
        if (!occupied) {
          open++;
          const col = String(seat.Number ?? seat.number ?? seat.column ?? "");
          const loc = JSON.stringify(seat.Location ?? seat.location ?? "");
          if (/window/i.test(loc)) window++;
          if (/aisle/i.test(loc)) aisle++;
          if (samples.length < 8 && rowNum && col) samples.push(`${rowNum}${col}`);
        }
      }
    }
    if (!total) return { available: false, reason: "no seat rows in response", flight: option.flightNumber };
    return {
      available: true,
      flight: option.flightNumber,
      cabin: option.cabin,
      totalSeats: total,
      openSeats: open,
      openWindow: window,
      openAisle: aisle,
      sampleOpenSeats: samples,
    };
  } catch {
    return { available: false, reason: "unparseable seat map response", flight: option.flightNumber };
  }
}

// Live search with a next-day retry (same-day shopping can come up empty).
export async function searchRebookOptions(
  event: Partial<DisruptionEvent>,
): Promise<RebookOption[]> {
  const origin = event.flight?.origin || "DFW";
  const destination = event.flight?.destination || "LGA";
  const today = new Date().toISOString().slice(0, 10);
  const eventDate = event.flight?.date && event.flight.date >= today ? event.flight.date : today;

  const token = await getToken();
  try {
    return await shop(origin, destination, eventDate, token);
  } catch (first) {
    // Same-day inventory can be empty in CERT — try tomorrow before giving up.
    const d = new Date(`${eventDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);
    try {
      return await shop(origin, destination, nextDay, token);
    } catch {
      throw first instanceof Error ? first : new Error(String(first));
    }
  }
}
