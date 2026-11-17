import { describe, expect, it } from 'vitest';
import {
  pendingManualVerificationEvents,
  rejectedSendManualVerifications,
  sendManualVerificationsFromAuditEvents
} from '../apps/web/src/lib/maker-po-data.js';
import type { MakerPoEventRow } from '../apps/web/src/lib/maker-po-data.js';
import type { AuditEventView } from '../apps/web/src/lib/project-data.js';

function sendEvent(id: string): MakerPoEventRow {
  return { id, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION' };
}

function verificationAudit(
  id: string,
  eventId: string,
  result: string,
  overrides: Partial<AuditEventView> = {}
): AuditEventView {
  return {
    id,
    action: 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED',
    entityType: 'maker_po_event',
    entityId: eventId,
    beforeState: null,
    afterState: {
      makerPoEventId: eventId,
      result,
      verifierName: '代表者',
      verifiedAt: '2026-11-17T10:00:00.000Z',
      reasonNote: '原本の宛先と添付を確認した'
    },
    occurredAt: '2026-11-17T10:01:00.000Z',
    requestMetadata: null,
    actor: { id: 'actor', displayName: '代表者', role: 'admin' },
    ...overrides
  };
}

describe('maker PO pending manual-verification list', () => {
  it('reads rejected and confirmed decisions from maker-PO audit rows', () => {
    const verifications = sendManualVerificationsFromAuditEvents([
      verificationAudit('audit-rejected', 'event-rejected', 'rejected'),
      verificationAudit('audit-confirmed', 'event-confirmed', 'confirmed'),
      verificationAudit('audit-other-action', 'event-other', 'rejected', {
        action: 'MAKER_PO_SEND_PENDING_MANUAL_VERIFICATION'
      }),
      verificationAudit('audit-other-entity', 'event-other', 'rejected', { entityType: 'maker_purchase_order' }),
      verificationAudit('audit-mismatch', 'different-event', 'rejected'),
      verificationAudit('audit-invalid-result', 'event-invalid', 'maybe')
    ]);

    expect(verifications.map((verification) => verification.makerPoEventId)).toEqual([
      'event-rejected',
      'event-confirmed',
      'different-event'
    ]);
    expect(rejectedSendManualVerifications(verifications).map((verification) => verification.makerPoEventId))
      .toEqual(['event-rejected', 'different-event']);
  });

  it('excludes a pending send once either decision exists, without mutating the event status', () => {
    const events = [
      sendEvent('event-rejected'),
      sendEvent('event-confirmed'),
      sendEvent('event-still-pending'),
      { id: 'not-send', eventType: 'CEO_APPROVED', verificationStatus: 'PENDING_MANUAL_VERIFICATION' }
    ];
    const verifications = [
      ...sendManualVerificationsFromAuditEvents([verificationAudit('a', 'event-rejected', 'rejected')]),
      ...sendManualVerificationsFromAuditEvents([verificationAudit('b', 'event-confirmed', 'confirmed')])
    ];

    expect(events[0]!.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect(pendingManualVerificationEvents(events, verifications).map((event) => event.id))
      .toEqual(['event-still-pending']);
  });

  it('keeps the actionable list unchanged when no audit decisions are available', () => {
    const events = [sendEvent('event-pending')];
    expect(pendingManualVerificationEvents(events).map((event) => event.id)).toEqual(['event-pending']);
  });
});
