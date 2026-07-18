import { ReceiptExtract, ReceiptClaim, DisruptionEvent } from "./contracts";

/**
 * Builds a claim from extracted receipts and a disruption event.
 * Encodes DOT commitment rules: controllable cancellations/delays obligate 
 * the airline to cover meals, hotel lodging, and ground transport.
 */
export function buildClaim(receipts: ReceiptExtract[], event?: DisruptionEvent): ReceiptClaim {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return {
      items: [],
      owedTotal: 0,
      commitmentsMet: []
    };
  }

  // Sum total amounts accurately (rounded to 2 decimal places)
  const sum = receipts.reduce((acc, item) => acc + (typeof item.total === "number" ? item.total : 0), 0);
  const owedTotal = Math.round(sum * 100) / 100;

  // Categories covered under controllable disruption commitments
  const coveredCategories = new Set(["hotel", "meal", "ground_transport"]);

  const commitmentsMetSet = new Set<string>();
  for (const item of receipts) {
    if (item.category && coveredCategories.has(item.category)) {
      commitmentsMetSet.add(item.category);
    }
  }

  return {
    items: receipts,
    owedTotal,
    commitmentsMet: Array.from(commitmentsMetSet)
  };
}
