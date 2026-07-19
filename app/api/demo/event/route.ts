import { makeEvent, mockSampleReceipts } from "@/lib/mocks";

export const dynamic = "force-dynamic";

// GET /api/demo/event?origin=SFO&destination=JFK
// Builds the DisruptionEvent for the requested route (defaults DFW→LGA),
// dated today, plus the two sample receipts for the no-photo rehearsal path.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = (url.searchParams.get("origin") || "DFW").toUpperCase();
  const destination = (url.searchParams.get("destination") || "LGA").toUpperCase();
  return Response.json({
    event: makeEvent(origin, destination),
    sampleReceipts: mockSampleReceipts,
  });
}
