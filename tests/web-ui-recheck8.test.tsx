import { describe, expect, it, vi } from 'vitest';
import { japaneseStatusSurface } from '@kanei/core';

/**
 * Recheck 8 (demo-eml/server-rules-recheck8/RECHECK_REPORT.md) — web unit rules:
 * Medium-B (an acknowledgement event is not a proven send; its kind comes from
 * the audit row or, failing that, from the API's own proven-send rule; decision
 * (a) is offered only for an internally cancelled paper with a send record),
 * Low-9 (the cleanup copy names only the records the API takes).
 * The real-API parity of the same rules is tests/web-ui-recheck8-parity.test.tsx.
 */
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: async () => ({ ok: false, status: 500, data: null, error: 'unused' }),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project',
  loadSessionUser: async () => null
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const {
  acknowledgementKindsFromAuditEvents,
  cancellationAcknowledgementKind,
  cancellationAcknowledgementLabel,
  liveMakerPapers,
  makerPaperCleanupSummary,
  makerPoSendProof,
  offersPostDeliveryConfirmation
} = await import('../apps/web/src/lib/maker-po-data.js');
const { makerCleanupActionText, nextActionForOrder, uncancellableLivePapers } = await import('../apps/web/src/lib/project-data.js');

type EventRow = Parameters<typeof makerPoSendProof>[0][number];
type AuditRow = Parameters<typeof acknowledgementKindsFromAuditEvents>[0][number];

const send = (id: string, verificationStatus: string): EventRow =>
  ({ id, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus });
const cancelEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_PO_CANCELLED', verificationStatus: 'UNVERIFIED' });
const ackEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_CANCELLATION_ACKNOWLEDGED', verificationStatus: 'UNVERIFIED' });
const ackAudit = (entityId: string, kind: unknown): AuditRow => ({
  id: `a-${entityId}`, action: 'MAKER_CANCELLATION_ACKNOWLEDGED', entityType: 'maker_po_event', entityId,
  beforeState: { status: 'CANCELLED' },
  afterState: { status: 'CANCELLED', acknowledgementKind: kind },
  occurredAt: '2026-11-18T13:00:00.000Z', requestMetadata: null, actor: null
});

describe('Medium-B: an acknowledgement record is not a proven send', () => {
  it('a post-delivery confirmation on an internally cancelled paper leaves the paper unproven', () => {
    // W1: never sent, cancelled internally, then the record-only confirmation.
    expect(makerPoSendProof([cancelEvent('c1'), ackEvent('k1')], [])).toBe('unproven');
    // W2: a pending send cancelled internally, then the confirmation.
    expect(makerPoSendProof([send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1'), ackEvent('k1')], [])).toBe('unproven');
    // A proven send stays proven with or without the 取り消し承認.
    expect(makerPoSendProof([send('e1', 'VERIFIED'), cancelEvent('c1'), ackEvent('k1')], [])).toBe('proven');
  });

  it('the kind: the audit row first, else the proof the API itself applies; unknown when neither is readable', () => {
    const kinds = acknowledgementKindsFromAuditEvents([
      ackAudit('k1', 'POST_DELIVERY_CONFIRMATION'),
      ackAudit('k2', 'CANCELLATION_ACKNOWLEDGEMENT'),
      ackAudit('k3', 'SOMETHING_ELSE'),
      { ...ackAudit('k4', 'POST_DELIVERY_CONFIRMATION'), entityType: 'maker_purchase_order' }
    ]);
    expect([...kinds.entries()]).toEqual([['k1', 'POST_DELIVERY_CONFIRMATION'], ['k2', 'CANCELLATION_ACKNOWLEDGEMENT']]);

    const internal = [cancelEvent('c1'), ackEvent('k1')];
    expect(cancellationAcknowledgementKind(internal, 'unproven', kinds)).toBe('POST_DELIVERY_CONFIRMATION');
    // The audit row wins over a proof the screen could not settle.
    expect(cancellationAcknowledgementKind(internal, 'unknown', kinds)).toBe('POST_DELIVERY_CONFIRMATION');
    // No audit row (capped window, trimmed role view): the API's rule.
    expect(cancellationAcknowledgementKind([cancelEvent('c9'), ackEvent('k9')], 'unproven')).toBe('POST_DELIVERY_CONFIRMATION');
    expect(cancellationAcknowledgementKind([cancelEvent('c9'), ackEvent('k9')], 'proven')).toBe('CANCELLATION_ACKNOWLEDGEMENT');
    expect(cancellationAcknowledgementKind([cancelEvent('c9'), ackEvent('k9')], 'unknown')).toBe('unknown');
    expect(cancellationAcknowledgementKind([cancelEvent('c9')], 'proven')).toBeNull();
  });

  it('labels: only the 取り消し承認 is called one', () => {
    expect(cancellationAcknowledgementLabel('CANCELLATION_ACKNOWLEDGEMENT')).toBe('取り消し承認（メーカー取消確認）');
    expect(cancellationAcknowledgementLabel('POST_DELIVERY_CONFIRMATION')).toBe('メーカー到達の事後確認（記録のみ）');
    expect(cancellationAcknowledgementLabel('unknown')).not.toBe('取り消し承認（メーカー取消確認）');
  });

  it('decision (a) is offered for a cancelled, unproven paper with a send record and no acknowledgement yet', () => {
    const pendingCancelled = [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')];
    expect(offersPostDeliveryConfirmation('CANCELLED', 'unproven', pendingCancelled)).toBe(true);
    // Never sent (Low-4): nothing says the paper ever left.
    expect(offersPostDeliveryConfirmation('CANCELLED', 'unproven', [cancelEvent('c1')])).toBe(false);
    // Proven or unknown: the 取り消し承認 form is the one offered.
    expect(offersPostDeliveryConfirmation('CANCELLED', 'proven', pendingCancelled)).toBe(false);
    expect(offersPostDeliveryConfirmation('CANCELLED', 'unknown', pendingCancelled)).toBe(false);
    // Already recorded (the API answers 422 …_ALREADY_RECORDED), or live paper.
    expect(offersPostDeliveryConfirmation('CANCELLED', 'unproven', [...pendingCancelled, ackEvent('k1')])).toBe(false);
    expect(offersPostDeliveryConfirmation('APPROVED_FOR_MANUAL_SEND', 'unproven', [send('e1', 'PENDING_MANUAL_VERIFICATION')])).toBe(false);
  });
});

describe('Low-5: live maker paper blocks an artwork revision', () => {
  it('every status but CANCELLED is live — accepted paper included', () => {
    const rows = ['DRAFT', 'APPROVED_FOR_MANUAL_SEND', 'SEND_UNVERIFIED', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'SNAPSHOT_VOIDED', 'CANCELLED']
      .map((status) => ({ id: status, status }));
    expect(liveMakerPapers(rows).map((row) => row.status)).toEqual(
      ['DRAFT', 'APPROVED_FOR_MANUAL_SEND', 'SEND_UNVERIFIED', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'SNAPSHOT_VOIDED']);
  });
});

describe('Low-9: the cleanup copy names only what the API takes', () => {
  const stuck = { status: 'SEND_UNVERIFIED', sendProof: 'unproven', acknowledgementRecorded: false } as const;
  const accepted = { status: 'MAKER_PO_ACCEPTED', sendProof: 'proven', acknowledgementRecorded: false } as const;
  const cancellable = { status: 'APPROVED_FOR_MANUAL_SEND', sendProof: 'unproven', acknowledgementRecorded: false } as const;
  const owed = { status: 'CANCELLED', sendProof: 'proven', acknowledgementRecorded: false } as const;

  it('only uncancellable paper: no 「取り消し…を記録」, the maker contact is the representative\'s call', () => {
    const summary = makerPaperCleanupSummary([stuck, accepted]);
    expect(summary.state).toBe('cleanup');
    expect(uncancellableLivePapers(summary)).toBe(2);
    const text = makerCleanupActionText(summary);
    expect(text).not.toContain('記録する');
    expect(text).toContain('取り消せない発注書（送信未確認・受入済み）は、メーカーへの連絡と対応を代表者が判断する。');
  });

  it('mixed: the records the API takes, then the rest', () => {
    expect(makerCleanupActionText(makerPaperCleanupSummary([cancellable, owed])))
      .toBe('メーカー発注画面で発注書の取り消し・取り消し承認を記録する。');
    expect(makerCleanupActionText(makerPaperCleanupSummary([owed, stuck])))
      .toBe('メーカー発注画面で取り消し承認を記録する。取り消せない発注書（送信未確認・受入済み）は、メーカーへの連絡と対応を代表者が判断する。');
  });

  it('次にやること of a CANCELLED order with only uncancellable paper', () => {
    const order = { id: 'o1', code: 'FSO-C', status: 'CANCELLED', sevenPurchaseOrderId: null, lineCount: 1, lines: [],
      detailsHidden: false, statusHidden: false, lastNormalStatus: null, createdAt: '', updatedAt: '' };
    const next = nextActionForOrder(order, {
      labels: japaneseStatusSurface(), sevenPurchaseOrders: [], revisions: [],
      makerPaperCleanup: { o1: makerPaperCleanupSummary([stuck]) }
    }, 'admin');
    expect(next.text).toContain('（取り消されていない発注書 1件（うち取り消せない発注書 1件））');
    expect(next.text).not.toContain('取り消し・取り消し承認を記録する');
    expect(next.text).toContain('メーカーへの連絡と対応を代表者が判断する');
  });
});
