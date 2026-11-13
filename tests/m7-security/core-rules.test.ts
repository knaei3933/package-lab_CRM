import { describe, expect, it } from 'vitest';
import {
  evaluateSevenPoPrecedenceGate,
  isFilmOrderMakerChainState,
  makerChainTransitionRefusal
} from '@kanei/core';
import { buildAuditViewForRole, type AuditHistoryRow } from '../../apps/api/src/audit-view.js';

/** One audit row shaped like the rows the audit-history endpoint selects. */
function auditRow(overrides: Partial<AuditHistoryRow> = {}): AuditHistoryRow {
  return {
    id: 'event-1',
    action: 'MAKER_PO_SEND_EVIDENCE_REGISTERED',
    entityType: 'maker_po_event',
    entityId: 'po-event-1',
    beforeState: { status: 'APPROVED_FOR_MANUAL_SEND' },
    afterState: {
      status: 'MAKER_PO_SENT_MANUALLY',
      event: {
        senderAddress: 'staff@kanei.example',
        recipients: ['maker-po@example.com'],
        attachmentHashes: ['a'.repeat(64)]
      }
    },
    occurredAt: new Date('2026-11-13T00:00:00.000Z'),
    requestMetadata: { operation: 'maker_po:send_evidence', makerPurchaseOrderId: 'po-1' },
    actor: { id: 'user-1', displayName: '合成担当者', role: 'staff' },
    ...overrides
  };
}

describe('M7 maker-chain refusal vocabulary (S1)', () => {
  it('names exactly the three maker-chain states the generic endpoint must never reach', () => {
    expect(isFilmOrderMakerChainState('APPROVED_FOR_MANUAL_SEND')).toBe(true);
    expect(isFilmOrderMakerChainState('MAKER_PO_SENT_MANUALLY')).toBe(true);
    expect(isFilmOrderMakerChainState('MAKER_PO_ACCEPTED')).toBe(true);
  });

  it('leaves every other state alone, including MAKER_PO_READY and exception states', () => {
    for (const state of [
      'DRAFT',
      'SEVEN_PO_VERIFIED',
      'MAKER_PO_READY',
      'FILM_IN_PRODUCTION',
      'FILM_RECEIPT_ASSUMED_NO_ISSUE',
      'ON_HOLD',
      'CHANGE_REVIEW',
      'CANCELLATION_REVIEW'
    ]) {
      expect(isFilmOrderMakerChainState(state)).toBe(false);
    }
  });

  it('refuses with the shared code and a Japanese message naming the dedicated endpoints', () => {
    const refusal = makerChainTransitionRefusal('MAKER_PO_SENT_MANUALLY');
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.code).toBe('MAKER_CHAIN_TRANSITION_FORBIDDEN');
      expect(refusal.message).toContain('メーカー発注書');
    }
  });
});

describe('M7 seven PO precedence gate composition (S4)', () => {
  it('keeps the date axis first: a checklist verdict never substitutes for official_registered_at', () => {
    const gate = evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: null,
      verificationStatus: 'verified',
      reviewPending: false
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('OFFICIAL_REGISTRATION_REQUIRED');
  });

  it('closes on an unverified checklist even when the date axis is satisfied', () => {
    const gate = evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: '2026-11-01T09:00:00.000Z',
      verificationStatus: 'unverified',
      reviewPending: false
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('SEVEN_PO_NOT_VERIFIED');
  });

  it('closes while the quote-vs-PO review is pending', () => {
    const gate = evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: '2026-11-01T09:00:00.000Z',
      verificationStatus: 'verified',
      reviewPending: true
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('PO_REVIEW_PENDING');
  });
});

describe('M7 audit view role allowlist (S3)', () => {
  it('gives admin the full row: before/after and requestMetadata verbatim', () => {
    const row = auditRow();
    const view = buildAuditViewForRole('admin', [row])[0]!;
    expect(view.beforeState).toEqual(row.beforeState);
    expect(view.afterState).toEqual(row.afterState);
    expect(view.requestMetadata).toEqual(row.requestMetadata);
    expect(view.actor).toEqual(row.actor);
  });

  it('gives assigned staff only the status-like keys and the operation key', () => {
    const view = buildAuditViewForRole('staff', [auditRow()])[0]!;
    expect(view.beforeState).toEqual({ status: 'APPROVED_FOR_MANUAL_SEND' });
    expect(view.afterState).toEqual({ status: 'MAKER_PO_SENT_MANUALLY' });
    expect(view.requestMetadata).toEqual({ operation: 'maker_po:send_evidence' });
    expect(view.actor).toEqual({ id: 'user-1', displayName: '合成担当者', role: 'staff' });
    expect(JSON.stringify(view)).not.toContain('staff@kanei.example');
    expect(JSON.stringify(view)).not.toContain('maker-po@example.com');
    expect(JSON.stringify(view)).not.toContain('po-1');
  });

  it('keeps the status-like keys staff is allowed to see, and drops the rest', () => {
    const view = buildAuditViewForRole('staff', [auditRow({
      action: 'FILM_DELIVERY_CONFIRMED',
      afterState: {
        id: 'confirmation-1',
        status: 'CONFIRMED',
        deliveryKind: 'film',
        confirmationState: 'CONFIRMED',
        verificationStatus: 'verified',
        totalAmount: '480000',
        snapshotSha256: 'b'.repeat(64),
        note: '合成メモ'
      }
    })])[0]!;
    expect(view.afterState).toEqual({
      id: 'confirmation-1',
      status: 'CONFIRMED',
      deliveryKind: 'film',
      confirmationState: 'CONFIRMED',
      verificationStatus: 'verified'
    });
  });

  it('gives viewer the summary only: no before/after and no requestMetadata', () => {
    const row = auditRow();
    const view = buildAuditViewForRole('viewer', [row])[0]!;
    expect(view).toEqual({
      id: 'event-1',
      action: 'MAKER_PO_SEND_EVIDENCE_REGISTERED',
      entityType: 'maker_po_event',
      entityId: 'po-event-1',
      occurredAt: row.occurredAt,
      actor: { id: 'user-1', displayName: '合成担当者', role: 'staff' }
    });
    expect('beforeState' in view).toBe(false);
    expect('afterState' in view).toBe(false);
    expect('requestMetadata' in view).toBe(false);
  });

  it('never hides a missing actor and keeps the row count stable', () => {
    const rows = [auditRow({ actor: null }), auditRow({ id: 'event-2' })];
    const views = buildAuditViewForRole('viewer', rows);
    expect(views).toHaveLength(2);
    expect(views[0]?.actor).toBeNull();
    expect(views[1]?.id).toBe('event-2');
  });
});
