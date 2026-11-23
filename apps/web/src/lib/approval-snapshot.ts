import { callApi } from './api';

/**
 * P1 integration: the 代表承認 always carries the snapshot hash of the paper the
 * representative saw (expectedSnapshotSha256, required by the API). A form that
 * did not carry one (the maker PO list's approve form) reads it from the approval
 * card the API serves for that paper. Null when the card cannot be read — the
 * approval is then held on the web (never sent without the hash).
 */
export async function approvalSnapshotFor(poId: string): Promise<string | null> {
  return (await approvalCardFacts(poId)).hash;
}

/** The hash and whether the frozen paper has no amount (P4 H4①: the approval then needs the amount typed). */
export async function approvalCardFacts(poId: string): Promise<{ hash: string | null; amountMissing: boolean }> {
  const card = await callApi<{ makerPurchaseOrder?: { approvalSnapshotSha256?: unknown }; snapshot?: { amounts?: unknown } }>(
    `/api/maker-purchase-orders/${encodeURIComponent(poId)}/approval-card`
  );
  const hash = card.ok ? card.data?.makerPurchaseOrder?.approvalSnapshotSha256 : null;
  return {
    hash: typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
    amountMissing: card.ok && (card.data?.snapshot?.amounts === null || card.data?.snapshot?.amounts === undefined)
  };
}

export const SNAPSHOT_UNREADABLE_MESSAGE = '承認カードを読み込めなかったため、承認を止めました。画面を再読み込みしてから承認してください。';
