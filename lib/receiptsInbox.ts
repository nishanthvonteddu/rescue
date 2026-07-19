// /lib/receiptsInbox.ts — hand-off point between the traveler's receipt upload
// and the agent's read_receipts tool.
//
// In agent mode the UI extracts uploaded photos through /api/receipts (REAL
// LandingAI) and drops the results here; the agent's read_receipts tool blocks
// on this inbox instead of helping itself to the bundled sample photos.
// "useBundled" is the explicit on-stage shortcut (the "Use sample receipts"
// button): the agent then runs the bundled photos through LandingAI itself.

import type { ReceiptExtract } from "./contracts";

export interface ReceiptsInbox {
  receipts: ReceiptExtract[] | null; // extracts from the traveler's own upload
  useBundled: boolean; // traveler opted to use the bundled sample photos
  updatedAt: number;
}

function fresh(): ReceiptsInbox {
  return { receipts: null, useBundled: false, updatedAt: Date.now() };
}

const g = globalThis as unknown as { __receiptsInbox?: ReceiptsInbox };
if (!g.__receiptsInbox) g.__receiptsInbox = fresh();

export function getReceiptsInbox(): ReceiptsInbox {
  return g.__receiptsInbox!;
}

export function setReceiptsInbox(patch: Partial<ReceiptsInbox>): ReceiptsInbox {
  g.__receiptsInbox = { ...g.__receiptsInbox!, ...patch, updatedAt: Date.now() };
  return g.__receiptsInbox;
}

export function resetReceiptsInbox(): ReceiptsInbox {
  g.__receiptsInbox = fresh();
  return g.__receiptsInbox;
}
