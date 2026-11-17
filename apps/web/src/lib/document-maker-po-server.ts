import { callApi } from './api';
import { toMakerPoChoices } from './document-maker-po';
import type { MakerPoChoice } from './document-maker-po';
import { MAKER_PO_STATUS_LABELS } from './maker-po-data';
import type { MakerPoViewRow } from './maker-po-data';

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
  return toMakerPoChoices(orders, new Map(results), MAKER_PO_STATUS_LABELS);
}
