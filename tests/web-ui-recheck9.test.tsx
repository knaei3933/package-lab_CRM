import { describe, expect, it, vi } from 'vitest';

/**
 * Recheck 9 (demo-eml/server-rules-recheck9/RECHECK_REPORT.md) Medium-3 — web
 * unit rules. The staff audit view narrows afterState to status-like keys, so a
 * staff screen sees that a send has a manual decision (the audit row exists)
 * but not its result, and sees no acknowledgementKind. Such a send is neither
 * "never confirmed" nor 「手動確認待ち」: its proof is unknown, and so is the
 * kind of the acknowledgement that follows — never the inverted kind.
 * The real-API parity of the same rules is tests/web-ui-recheck9-parity.test.tsx.
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
  acknowledgementOwed,
  cancellationAcknowledgementKind,
  cancellationAcknowledgementLabel,
  makerPoSendProof,
  offersPostDeliveryConfirmation,
  sendManualVerificationsFromAuditEvents,
  undisclosedSendDecisionEventIds,
  unsettledSendsOfCancelledPaper
} = await import('../apps/web/src/lib/maker-po-data.js');

type EventRow = Parameters<typeof makerPoSendProof>[0][number];
type AuditRow = Parameters<typeof acknowledgementKindsFromAuditEvents>[0][number];

const send = (id: string, verificationStatus: string): EventRow =>
  ({ id, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus });
const cancelEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_PO_CANCELLED', verificationStatus: 'UNVERIFIED' });
const ackEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_CANCELLATION_ACKNOWLEDGED', verificationStatus: 'UNVERIFIED' });

const audit = (action: string, entityId: string, afterState: Record<string, unknown> | null): AuditRow => ({
  id: `a-${action}-${entityId}`, action, entityType: 'maker_po_event', entityId,
  beforeState: null, afterState, occurredAt: '2026-11-18T13:00:00.000Z', requestMetadata: null, actor: null
});
/** A decision row as the admin audit view returns it (the whole afterState). */
const adminDecision = (eventId: string, result: 'confirmed' | 'rejected') =>
  audit('MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', eventId, {
    makerPoEventId: eventId, result, verifierName: '合成代表者', verifiedAt: '2026-11-18T12:00:00.000Z', reasonNote: '原本で確認'
  });
/** The same row as the staff audit view returns it (audit-view STAFF_STATE_KEYS: no result, no event id). */
const staffDecision = (eventId: string) => audit('MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', eventId, {});

describe('Medium-3: a decision the role cannot read', () => {
  it('names the sends whose decision row has no readable result, and only those', () => {
    const rows = [staffDecision('e1'), adminDecision('e2', 'confirmed'), adminDecision('e3', 'rejected'),
      audit('MAKER_PO_CANCELLED', 'c1', { status: 'CANCELLED' })];
    expect([...undisclosedSendDecisionEventIds(rows)]).toEqual(['e1']);
    expect(sendManualVerificationsFromAuditEvents(rows).map((row) => row.makerPoEventId)).toEqual(['e2', 'e3']);
    // A null afterState (viewer view) is no more readable than an empty one.
    expect([...undisclosedSendDecisionEventIds([audit('MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', 'e4', null)])]).toEqual(['e4']);
    expect(undisclosedSendDecisionEventIds([]).size).toBe(0);
  });

  it('a send with an unreadable decision leaves the proof unknown — never unproven', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')];
    const undisclosed = undisclosedSendDecisionEventIds([staffDecision('e1')]);
    expect(makerPoSendProof(events, [], undisclosed)).toBe('unknown');
    // Without a decision row at all the pending send is truly undecided: unproven.
    expect(makerPoSendProof(events, [], undisclosedSendDecisionEventIds([]))).toBe('unproven');
    // A VERIFIED send is proven whatever else is unreadable.
    expect(makerPoSendProof([send('e0', 'VERIFIED'), ...events], [], undisclosed)).toBe('proven');
  });

  it('the acknowledgement kind on that paper is unknown unless the audit row says it', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1'), ackEvent('k1')];
    const proof = makerPoSendProof(events, [], undisclosedSendDecisionEventIds([staffDecision('e1')]));
    expect(cancellationAcknowledgementKind(events, proof)).toBe('unknown');
    expect(cancellationAcknowledgementLabel('unknown')).toBe('取り消し承認またはメーカー到達の事後確認');
    // When the server discloses the kind to the role, the screen takes it as is.
    const disclosed = acknowledgementKindsFromAuditEvents([
      audit('MAKER_CANCELLATION_ACKNOWLEDGED', 'k1', { status: 'CANCELLED', acknowledgementKind: 'CANCELLATION_ACKNOWLEDGEMENT' })
    ]);
    expect(cancellationAcknowledgementKind(events, proof, disclosed)).toBe('CANCELLATION_ACKNOWLEDGEMENT');
    // The admin view (decision readable) applies the API's own rule.
    const adminProof = makerPoSendProof(events, sendManualVerificationsFromAuditEvents([adminDecision('e1', 'confirmed')]));
    expect(adminProof).toBe('proven');
    expect(cancellationAcknowledgementKind(events, adminProof)).toBe('CANCELLATION_ACKNOWLEDGEMENT');
    const rejectedProof = makerPoSendProof(events, sendManualVerificationsFromAuditEvents([adminDecision('e1', 'rejected')]));
    expect(cancellationAcknowledgementKind(events, rejectedProof)).toBe('POST_DELIVERY_CONFIRMATION');
  });

  it('such a send is not listed as 「手動確認待ちのまま」, and decision (a) is not offered on it', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION'), send('e2', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')];
    const undisclosed = undisclosedSendDecisionEventIds([staffDecision('e1')]);
    expect(unsettledSendsOfCancelledPaper(events, [], 'CANCELLED', undisclosed).map((event) => event.id)).toEqual(['e2']);
    // Unchanged without the set (the admin reads every decision itself).
    expect(unsettledSendsOfCancelledPaper(events, [], 'CANCELLED').map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(offersPostDeliveryConfirmation('CANCELLED', makerPoSendProof(events, [], undisclosed), events)).toBe(false);
  });

  it('an unacknowledged cancelled paper with an unreadable decision may owe a 取り消し承認 (never "nothing left")', () => {
    const proof = makerPoSendProof([send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')], [],
      undisclosedSendDecisionEventIds([staffDecision('e1')]));
    expect(acknowledgementOwed({ status: 'CANCELLED', sendProof: proof, acknowledgementRecorded: false })).toBe('maybe');
    expect(acknowledgementOwed({ status: 'CANCELLED', sendProof: proof, acknowledgementRecorded: true })).toBeNull();
  });
});
