import { callApi } from './api';
import type { Choice } from './types';
import { MAKER_PO_STATUS_LABELS } from './maker-po-data';
import type { MakerPoViewRow } from './maker-po-data';

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
  rowsByOrderId: ReadonlyMap<string, readonly MakerPoViewRow[]>
): MakerPoChoice[] {
  const choices: MakerPoChoice[] = [];
  for (const order of orders) {
    for (const row of rowsByOrderId.get(order.id) ?? []) {
      if (row.status === 'CANCELLED') continue;
      choices.push({
        value: row.id,
        filmSupplyOrderId: order.id,
        label: `${order.code} / ${row.id.slice(0, 8)}（${MAKER_PO_STATUS_LABELS[row.status] ?? row.status}）`
      });
    }
  }
  return choices;
}

/** Reads the maker POs per order through the same API the maker PO screen uses. */
export async function loadMakerPoChoices(
  orders: ReadonlyArray<{ id: string; code: string }>
): Promise<MakerPoChoice[]> {
  const results = await Promise.all(orders.map(async (order) => {
    const result = await callApi<{ makerPurchaseOrders: MakerPoViewRow[] }>(
      `/api/film-supply-orders/${encodeURIComponent(order.id)}/maker-purchase-orders`
    );
    return [order.id, result.ok && result.data ? result.data.makerPurchaseOrders : []] as const;
  }));
  return toMakerPoChoices(orders, new Map(results));
}
