import { callApi } from './api';

/**
 * p4/web3 (e, p4-server2 REPORT §10): what a film order's completion rests on, decided by the server.
 * GET …/delivery-status answers
 * - `receiptClosure` while the order waits for its completion (FILM_DELIVERED): the basis the completion
 *   would be recorded on now, and whether it needs the 「証跡なし」 acknowledgment;
 * - `receiptAssumption.closureBasis` once completed (closures before P4 were all evidence-free).
 * The web only shows it and shapes the request; the server judges again under its lock.
 */
export type ClosureBasis = 'delivery_confirmations' | 'evidence_free_acknowledgment';

export interface ReceiptClosureView {
  /** Null unless the order is FILM_DELIVERED. */
  pending: { basis: ClosureBasis; acknowledgeNoEvidenceRequired: boolean } | null;
  /** Null until the completion is recorded. */
  recorded: { basis: ClosureBasis; at: string | null; by: string | null } | null;
}

const BASES: readonly string[] = ['delivery_confirmations', 'evidence_free_acknowledgment'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function basisOf(value: unknown): ClosureBasis | null {
  return typeof value === 'string' && BASES.includes(value) ? (value as ClosureBasis) : null;
}

/** Pure: the two fields of the delivery-status answer; null when the answer carries neither (older API). */
export function receiptClosureFrom(data: unknown): ReceiptClosureView | null {
  const body = record(data);
  if (!body || (!('receiptClosure' in body) && !('receiptAssumption' in body))) return null;
  const pendingRow = record(body.receiptClosure);
  const pendingBasis = pendingRow ? basisOf(pendingRow.basis) : null;
  const recordedRow = record(body.receiptAssumption);
  const recordedBasis = recordedRow ? basisOf(recordedRow.closureBasis) ?? 'evidence_free_acknowledgment' : null;
  const by = recordedRow ? record(recordedRow.assumedBy) : null;
  return {
    pending: pendingRow && pendingBasis
      ? { basis: pendingBasis, acknowledgeNoEvidenceRequired: pendingRow.acknowledgeNoEvidenceRequired !== false }
      : null,
    recorded: recordedRow && recordedBasis
      ? {
          basis: recordedBasis,
          at: typeof recordedRow.assumedAt === 'string' ? recordedRow.assumedAt : null,
          by: by && typeof by.displayName === 'string' ? by.displayName : null
        }
      : null
  };
}

export async function loadReceiptClosure(orderId: string): Promise<ReceiptClosureView | null> {
  const result = await callApi<unknown>(`/api/film-supply-orders/${encodeURIComponent(orderId)}/delivery-status`);
  return result.ok ? receiptClosureFrom(result.data) : null;
}

/** The words of a basis (the step's completion line and the success line). */
export const CLOSURE_BASIS_LABELS: Readonly<Record<ClosureBasis, string>> = {
  delivery_confirmations: '確認済みの納品（受領証跡で数量を確認）',
  evidence_free_acknowledgment: '証跡なしで問題なしとして完了（同意あり）'
};
