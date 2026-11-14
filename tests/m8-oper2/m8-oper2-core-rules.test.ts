import { describe, expect, it } from 'vitest';
import {
  deriveOrderApprovalGate,
  deriveDesignApprovalGate,
  FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES,
  isFilmOrderPastMakerAcceptance,
  validateEvidenceVerificationResult,
  type ApprovalEventView,
  type ArtworkRevisionView,
  type EvidenceVerificationView
} from '@kanei/core';

/**
 * M8-OPER2 pure rules:
 *
 * FIX 2 — the dual-approval gate reads the append-only manual verifications: a
 * pending_manual_verification APPROVE counts only while the latest verification
 * naming that exact approval event, revision and hash is 'confirmed'. A
 * 'rejected' verification, or no verification at all, keeps the gate closed.
 * FIX 3 — the production/shipping/delivery states past MAKER_PO_ACCEPTED are
 * recognised as completed maker paper.
 */

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `22222222-2222-7222-8222-${String(sequence).padStart(12, '0')}`;
}

function revision(overrides: Partial<ArtworkRevisionView> = {}): ArtworkRevisionView {
  return {
    id: nextId(),
    filmSupplyOrderId: '33333333-3333-7333-8333-333333333333',
    designKey: 'label-front',
    revisionNo: 1,
    fileSha256: SHA_A,
    lotMarking: null,
    ...overrides
  };
}

function approvalEvent(
  revisionId: string,
  overrides: Partial<ApprovalEventView> = {}
): ApprovalEventView {
  return {
    id: nextId(),
    artworkRevisionId: revisionId,
    organization: 'customer',
    decision: 'APPROVE',
    approvedFileSha256: SHA_A,
    recordedAt: `2026-11-14T09:00:00.000Z`,
    eventTime: `2026-11-14T08:00:00.000Z`,
    supersedesEventId: null,
    evidenceIdentifier: 'MSG-OPER2-0001',
    ...overrides
  };
}

function pendingApproval(revisionId: string, organization: 'customer' | 'seven'): ApprovalEventView {
  return approvalEvent(revisionId, {
    organization,
    evidenceIdentifierStatus: 'pending_manual_verification'
  });
}

function verification(
  approvalEventId: string,
  revisionId: string,
  result: 'confirmed' | 'rejected',
  overrides: Partial<EvidenceVerificationView> = {}
): EvidenceVerificationView {
  return {
    id: nextId(),
    approvalEventId,
    artworkRevisionId: revisionId,
    approvedFileSha256: SHA_A,
    result,
    verifierName: '合成代表者',
    verifiedAt: '2026-11-14T10:00:00.000Z',
    recordedAt: '2026-11-14T10:05:00.000Z',
    ...overrides
  };
}

describe('M8-OPER2 FIX 2: the gate reads manual verifications', () => {
  it('keeps a pending approval out of the gate while no verification exists', () => {
    const current = revision();
    const gate = deriveOrderApprovalGate([current], [
      pendingApproval(current.id, 'customer'),
      approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' })
    ]);
    expect(gate.designs[0]!.customer.pendingEvidenceIdentifier).toBe(true);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.customer.manualVerification).toBeNull();
    expect(gate.dualApproved).toBe(false);
  });

  it('lets a confirmed verification count the pending approval', () => {
    const current = revision();
    const customer = pendingApproval(current.id, 'customer');
    const seven = approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' });
    const gate = deriveOrderApprovalGate([current], [customer, seven], [
      verification(customer.id, current.id, 'confirmed')
    ]);
    expect(gate.designs[0]!.customer.valid).toBe(true);
    expect(gate.designs[0]!.customer.pendingEvidenceIdentifier).toBe(false);
    expect(gate.designs[0]!.customer.manualVerification).toMatchObject({ result: 'confirmed' });
    expect(gate.dualApproved).toBe(true);
  });

  it('keeps the gate closed on a rejected verification', () => {
    const current = revision();
    const customer = pendingApproval(current.id, 'customer');
    const seven = approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' });
    const gate = deriveOrderApprovalGate([current], [customer, seven], [
      verification(customer.id, current.id, 'rejected')
    ]);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.pendingEvidenceIdentifier).toBe(true);
    expect(gate.designs[0]!.customer.manualVerification).toMatchObject({ result: 'rejected' });
    expect(gate.dualApproved).toBe(false);
  });

  it('ignores a verification that names another approval event, revision or hash', () => {
    const current = revision();
    const otherRevision = revision({ revisionNo: 2, fileSha256: SHA_B });
    const customer = pendingApproval(current.id, 'customer');
    const seven = approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' });
    const gate = deriveOrderApprovalGate([current], [customer, seven], [
      // Another approval event on the same revision.
      verification(nextId(), current.id, 'confirmed'),
      // This approval event, but another revision / another hash.
      verification(customer.id, otherRevision.id, 'confirmed'),
      verification(customer.id, current.id, 'confirmed', { approvedFileSha256: SHA_B })
    ]);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.dualApproved).toBe(false);
  });

  it('lets the latest verification win in replay order', () => {
    const current = revision();
    const customer = pendingApproval(current.id, 'customer');
    const seven = approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' });

    const rejectedLast = deriveOrderApprovalGate([current], [customer, seven], [
      verification(customer.id, current.id, 'confirmed', { recordedAt: '2026-11-14T10:00:00.000Z' }),
      verification(customer.id, current.id, 'rejected', { recordedAt: '2026-11-14T11:00:00.000Z' })
    ]);
    expect(rejectedLast.dualApproved).toBe(false);
    expect(rejectedLast.designs[0]!.customer.manualVerification).toMatchObject({ result: 'rejected' });

    const confirmedLast = deriveOrderApprovalGate([current], [customer, seven], [
      verification(customer.id, current.id, 'rejected', { recordedAt: '2026-11-14T10:00:00.000Z' }),
      verification(customer.id, current.id, 'confirmed', { recordedAt: '2026-11-14T11:00:00.000Z' })
    ]);
    expect(confirmedLast.dualApproved).toBe(true);

    // Same instant: the id is the tiebreaker, so the derivation stays stable.
    const tied = deriveOrderApprovalGate([current], [customer, seven], [
      verification(customer.id, current.id, 'confirmed', { id: '44444444-4444-7444-8444-000000000001' }),
      verification(customer.id, current.id, 'rejected', { id: '44444444-4444-7444-8444-000000000002' })
    ]);
    expect(tied.dualApproved).toBe(false);
  });

  it('never lets a verification substitute for a counted approval', () => {
    const current = revision();
    // The customer approval is missing entirely; a verification of nothing
    // cannot create one.
    const gate = deriveOrderApprovalGate([current], [
      approvalEvent(current.id, { organization: 'seven', evidenceIdentifierStatus: 'verified_in_document' })
    ], [
      verification(nextId(), current.id, 'confirmed')
    ]);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.missingApprovals).toEqual([{ designKey: 'label-front', organization: 'customer' }]);
  });

  it('reads the hash mismatch, not the pending flag, as a newer-revision invalidation', () => {
    const staleTarget = revision({ revisionNo: 2, fileSha256: SHA_B });
    const state = deriveDesignApprovalGate([staleTarget], [
      approvalEvent(staleTarget.id, { approvedFileSha256: SHA_A })
    ])!.customer;
    expect(state.invalidatedByNewerRevision).toBe(true);

    const pendingTarget = revision();
    const pendingState = deriveDesignApprovalGate([pendingTarget], [
      pendingApproval(pendingTarget.id, 'customer')
    ])!.customer;
    expect(pendingState.invalidatedByNewerRevision).toBe(false);
  });

  it('validates the verification result vocabulary', () => {
    expect(validateEvidenceVerificationResult('confirmed')).toEqual({
      ok: true,
      value: 'confirmed'
    });
    expect(validateEvidenceVerificationResult('maybe').ok).toBe(false);
    expect(validateEvidenceVerificationResult(null).ok).toBe(false);
  });
});

describe('M8-OPER2 FIX 3: completed maker paper states', () => {
  it('recognises the production/shipping/delivery chain as past acceptance', () => {
    for (const state of FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES) {
      expect(isFilmOrderPastMakerAcceptance(state)).toBe(true);
    }
  });

  it('keeps the maker chain itself and the pre-approval states below the line', () => {
    for (const state of [
      'DRAFT',
      'MAKER_PO_READY',
      'APPROVED_FOR_MANUAL_SEND',
      'MAKER_PO_SENT_MANUALLY',
      'MAKER_PO_ACCEPTED',
      'SNAPSHOT_VOIDED',
      'ON_HOLD'
    ]) {
      expect(isFilmOrderPastMakerAcceptance(state)).toBe(false);
    }
  });
});
