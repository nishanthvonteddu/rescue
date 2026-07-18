import { sampleEvent, mockSampleReceipts } from "@/lib/mocks";

export const dynamic = "force-dynamic";

// GET /api/demo/event  (Person 1 orchestration helper)
// Serves the canned DisruptionEvent plus the two sample receipts server-side, so
// the dashboard has the traveler (with the env-resolved paypalId) to pass into
// confirm/payout, and a no-photo "use sample receipts" path for rehearsal.
export async function GET() {
  return Response.json({ event: sampleEvent, sampleReceipts: mockSampleReceipts });
}
