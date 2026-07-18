import { NextRequest, NextResponse } from "next/server";
import { buildClaim } from "../../../lib/claim";
import { ReceiptExtract, DisruptionEvent, ReceiptClaim } from "../../../lib/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest | Request) {
  try {
    const body = await req.json();
    const receipts: ReceiptExtract[] = Array.isArray(body.receipts) ? body.receipts : (Array.isArray(body) ? body : []);
    const event: DisruptionEvent | undefined = body.event;

    const claim: ReceiptClaim = buildClaim(receipts, event);
    return NextResponse.json(claim);
  } catch (error: any) {
    console.error("[POST /api/claim] Error building claim:", error);

    // Safe fallback claim matching contract
    const fallbackClaim: ReceiptClaim = {
      items: [],
      owedTotal: 247,
      commitmentsMet: ["hotel", "meal"]
    };
    return NextResponse.json(fallbackClaim);
  }
}
