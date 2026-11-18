// Pure helpers only: imported by a client component, so no server-only imports (api.ts, maker-po-data.ts values).
import type { Choice } from './types';
import type { MakerPoViewRow } from './maker-po-data';
import { shortId } from './short-id';

/** Document types that are about one maker purchase order (API intake: makerPurchaseOrderId). */
export const MAKER_PO_BOUND_DOCUMENT_TYPES: readonly string[] = ['acceptance_evidence', 'send_evidence'];

export function isMakerPoBoundDocumentType(documentType: string): boolean {
  return MAKER_PO_BOUND_DOCUMENT_TYPES.includes(documentType);
}

/** A selectable maker PO, tagged with the film supply order the API requires it to be bound with. */
export interface MakerPoChoice extends Choice {
  filmSupplyOrderId: string;
}

/** Cancelled papers are history only; every other status can still be the target of evidence. */
export function toMakerPoChoices(
  orders: ReadonlyArray<{ id: string; code: string }>,
  rowsByOrderId: ReadonlyMap<string, readonly MakerPoViewRow[]>,
  statusLabels: Readonly<Record<string, string>>
): MakerPoChoice[] {
  const choices: MakerPoChoice[] = [];
  for (const order of orders) {
    for (const row of rowsByOrderId.get(order.id) ?? []) {
      if (row.status === 'CANCELLED') continue;
      choices.push({
        value: row.id,
        filmSupplyOrderId: order.id,
        label: `${order.code} / ${shortId(row.id)}（${statusLabels[row.status] ?? row.status}）`
      });
    }
  }
  return choices;
}
