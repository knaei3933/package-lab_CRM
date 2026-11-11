import { describe, expect, it } from 'vitest';
import {
  deriveOrderApprovalGate,
  evaluateApprovalEvidenceBinding,
  evaluateRevisionRegistrationGate,
  hasApprovalHistoryForDesign,
  shouldAdvanceToDualApproved,
  validateApprovalDecision,
  validateApprovalEvidenceSource,
  validateApprovalOrganization,
  type ApprovalEventView,
  type ArtworkRevisionView
} from '@kanei/core';

const ORDER_ID = '11111111-1111-7111-8111-111111111111';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

function revision(overrides: Partial<ArtworkRevisionView> = {}): ArtworkRevisionView {
  return {
    id: nextId(),
    filmSupplyOrderId: ORDER_ID,
    designKey: 'label-front',
    revisionNo: 1,
    fileSha256: SHA_A,
    lotMarking: null,
    ...overrides
  };
}

function event(
  revisionId: string,
  overrides: Partial<Omit<ApprovalEventView, 'artworkRevisionId'>> = {}
): ApprovalEventView {
  return {
    id: nextId(),
    artworkRevisionId: revisionId,
    organization: 'customer',
    decision: 'APPROVE',
    approvedFileSha256: SHA_A,
    recordedAt: `2026-11-11T09:0${sequence % 10}:00.000Z`,
    eventTime: `2026-11-11T08:0${sequence % 10}:00.000Z`,
    supersedesEventId: null,
    ...overrides
  };
}

function dualApprovals(revisionId: string, sha256 = SHA_A): ApprovalEventView[] {
  return [
    event(revisionId, { organization: 'customer', approvedFileSha256: sha256 }),
    event(revisionId, { organization: 'seven', approvedFileSha256: sha256 })
  ];
}

describe('M3 dual approval derivation', () => {
  it('T-07 keeps the gate closed when only the customer approved', () => {
    const current = revision();
    const gate = deriveOrderApprovalGate(
      [current],
      [event(current.id, { organization: 'customer' })]
    );
    expect(gate.dualApproved).toBe(false);
    expect(gate.designs[0]!.customer.valid).toBe(true);
    expect(gate.designs[0]!.seven.valid).toBe(false);
    expect(gate.missingApprovals).toEqual([{ designKey: 'label-front', organization: 'seven' }]);
  });

  it('T-08 keeps the gate closed when only seven approved', () => {
    const current = revision();
    const gate = deriveOrderApprovalGate(
      [current],
      [event(current.id, { organization: 'seven' })]
    );
    expect(gate.dualApproved).toBe(false);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.seven.valid).toBe(true);
    expect(gate.missingApprovals).toEqual([{ designKey: 'label-front', organization: 'customer' }]);
  });

  it('T-09 reaches dual approval when customer approves first and seven second', () => {
    const current = revision();
    const customer = event(current.id, { organization: 'customer', recordedAt: '2026-11-11T10:00:00.000Z' });
    const seven = event(current.id, { organization: 'seven', recordedAt: '2026-11-11T11:00:00.000Z' });
    const gate = deriveOrderApprovalGate([current], [customer, seven]);
    expect(gate.dualApproved).toBe(true);
    expect(gate.missingApprovals).toEqual([]);
    expect(shouldAdvanceToDualApproved(gate, 'APPROVAL_PENDING')).toBe(true);
  });

  it('T-10 reaches dual approval equally when seven approves first and customer second', () => {
    const current = revision();
    const seven = event(current.id, { organization: 'seven', recordedAt: '2026-11-11T10:00:00.000Z' });
    const customer = event(current.id, { organization: 'customer', recordedAt: '2026-11-11T11:00:00.000Z' });
    const gate = deriveOrderApprovalGate([current], [seven, customer]);
    expect(gate.dualApproved).toBe(true);
    expect(gate.missingApprovals).toEqual([]);
  });

  it('T-11 never transfers an approval to a new revision, and keeps the old events as history', () => {
    const first = revision({ id: nextId(), revisionNo: 1, fileSha256: SHA_A });
    const second = revision({ revisionNo: 2, fileSha256: SHA_B });
    const history = dualApprovals(first.id);
    const gate = deriveOrderApprovalGate([first, second], history);

    expect(gate.designs[0]!.currentRevisionId).toBe(second.id);
    expect(gate.designs[0]!.fileSha256).toBe(SHA_B);
    expect(gate.dualApproved).toBe(false);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.seven.valid).toBe(false);
    // The approvals are not gone: they stay readable as audit history of the
    // superseded revision.
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.decision === 'APPROVE')).toBe(true);
    expect(hasApprovalHistoryForDesign([first, second], history, 'label-front')).toBe(true);
  });

  it('binds a valid approval to the exact current revision hash', () => {
    const current = revision({ fileSha256: SHA_A });
    const wrongHash = event(current.id, { organization: 'customer', approvedFileSha256: SHA_B });
    const gate = deriveOrderApprovalGate([current], [wrongHash]);
    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.customer.invalidatedByNewerRevision).toBe(true);
  });

  it('T-13 a REVOKE invalidates only that organization and leaves past events readable', () => {
    const current = revision();
    const customerApprove = event(current.id, { organization: 'customer', recordedAt: '2026-11-11T10:00:00.000Z' });
    const sevenApprove = event(current.id, { organization: 'seven', recordedAt: '2026-11-11T10:05:00.000Z' });
    const customerRevoke = event(current.id, {
      organization: 'customer',
      decision: 'REVOKE',
      recordedAt: '2026-11-11T12:00:00.000Z'
    });
    const gate = deriveOrderApprovalGate([current], [customerApprove, sevenApprove, customerRevoke]);

    expect(gate.designs[0]!.customer.valid).toBe(false);
    expect(gate.designs[0]!.customer.revoked).toBe(true);
    expect(gate.designs[0]!.seven.valid).toBe(true);
    expect(gate.dualApproved).toBe(false);
    // Every event is still there to be read.
    expect([customerApprove, sevenApprove, customerRevoke]).toHaveLength(3);

    const reApproved = event(current.id, { organization: 'customer', recordedAt: '2026-11-11T13:00:00.000Z' });
    const reopened = deriveOrderApprovalGate([current], [customerApprove, sevenApprove, customerRevoke, reApproved]);
    expect(reopened.designs[0]!.customer.valid).toBe(true);
    expect(reopened.dualApproved).toBe(true);
  });

  it('T-34 stays closed until every required design holds both approvals', () => {
    const designA = revision({ designKey: 'label-front' });
    const designB = revision({ designKey: 'label-back', fileSha256: SHA_B });
    const partial = deriveOrderApprovalGate(
      [designA, designB],
      [...dualApprovals(designA.id), event(designB.id, { organization: 'customer', approvedFileSha256: SHA_B })]
    );
    expect(partial.dualApproved).toBe(false);
    expect(partial.requiredDesignKeys).toEqual(['label-back', 'label-front']);
    expect(partial.missingApprovals).toEqual([{ designKey: 'label-back', organization: 'seven' }]);

    const complete = deriveOrderApprovalGate(
      [designA, designB],
      [
        ...dualApprovals(designA.id),
        event(designB.id, { organization: 'customer', approvedFileSha256: SHA_B }),
        event(designB.id, { organization: 'seven', approvedFileSha256: SHA_B })
      ]
    );
    expect(complete.dualApproved).toBe(true);
    expect(complete.missingApprovals).toEqual([]);
  });

  it('an order without revisions is never dual-approved', () => {
    const gate = deriveOrderApprovalGate([], []);
    expect(gate.dualApproved).toBe(false);
    expect(gate.requiredDesignKeys).toEqual([]);
    expect(gate.designs).toEqual([]);
  });

  it('never advances automatically from an exception or already-approved state', () => {
    const current = revision();
    const gate = deriveOrderApprovalGate([current], dualApprovals(current.id));
    expect(gate.dualApproved).toBe(true);
    expect(shouldAdvanceToDualApproved(gate, 'SEVEN_PO_VERIFIED')).toBe(true);
    expect(shouldAdvanceToDualApproved(gate, 'ARTWORK_RECEIVED')).toBe(true);
    expect(shouldAdvanceToDualApproved(gate, 'PROOF_READY')).toBe(true);
    expect(shouldAdvanceToDualApproved(gate, 'APPROVAL_PENDING')).toBe(true);
    expect(shouldAdvanceToDualApproved(gate, 'DUAL_APPROVED')).toBe(false);
    expect(shouldAdvanceToDualApproved(gate, 'ON_HOLD')).toBe(false);
    expect(shouldAdvanceToDualApproved(gate, 'CHANGE_REVIEW')).toBe(false);
    expect(shouldAdvanceToDualApproved(gate, 'MAKER_PO_READY')).toBe(false);
  });
});

describe('M3 revision registration gate', () => {
  it('rejects a DRAFT order and accepts every state past SEVEN_PO_VERIFIED', () => {
    expect(evaluateRevisionRegistrationGate('DRAFT')).toEqual({
      ok: false,
      code: 'ORDER_NOT_PAST_SEVEN_PO_VERIFIED',
      message: expect.stringContaining('SEVEN_PO_VERIFIED')
    });
    for (const status of ['SEVEN_PO_VERIFIED', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'ON_HOLD', 'CHANGE_REVIEW']) {
      expect(evaluateRevisionRegistrationGate(status).ok).toBe(true);
    }
  });

  it('counts approval history only from APPROVE events of the same design', () => {
    const first = revision({ designKey: 'label-front' });
    const otherDesign = revision({ designKey: 'label-back' });
    const revocations = [
      event(first.id, { organization: 'customer', decision: 'REVOKE' }),
      event(otherDesign.id, { organization: 'seven' })
    ];
    expect(hasApprovalHistoryForDesign([first, otherDesign], revocations, 'label-front')).toBe(false);
    expect(hasApprovalHistoryForDesign(
      [first, otherDesign],
      [...revocations, event(first.id, { organization: 'customer' })],
      'label-front'
    )).toBe(true);
  });
});

describe('M3 approval evidence binding', () => {
  const order = { id: ORDER_ID, projectId: 'project-a' };
  const revisionInput = { designKey: 'label-front' };

  it('accepts evidence bound to the same order, design and project', () => {
    expect(evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'approval_evidence',
        filmSupplyOrderId: ORDER_ID,
        designKey: 'label-front'
      },
      order,
      revision: revisionInput
    })).toEqual({ ok: true, boundOn: 'order_design_project' });
  });

  it('rejects evidence of another company, order, design or document type', () => {
    expect(evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: 'project-b',
        documentType: 'approval_evidence',
        filmSupplyOrderId: ORDER_ID,
        designKey: 'label-front'
      },
      order,
      revision: revisionInput
    })).toMatchObject({ ok: false, code: 'EVIDENCE_PROJECT_MISMATCH' });

    expect(evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'approval_evidence',
        filmSupplyOrderId: '22222222-2222-7222-8222-222222222222',
        designKey: 'label-front'
      },
      order,
      revision: revisionInput
    })).toMatchObject({ ok: false, code: 'EVIDENCE_ORDER_MISMATCH' });

    expect(evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'approval_evidence',
        filmSupplyOrderId: ORDER_ID,
        designKey: 'label-back'
      },
      order,
      revision: revisionInput
    })).toMatchObject({ ok: false, code: 'EVIDENCE_DESIGN_MISMATCH' });

    expect(evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'proof',
        filmSupplyOrderId: ORDER_ID,
        designKey: 'label-front'
      },
      order,
      revision: revisionInput
    })).toMatchObject({ ok: false, code: 'EVIDENCE_DOCUMENT_TYPE_INVALID' });
  });
});

describe('M3 approval vocabulary', () => {
  it('validates organizations, decisions and evidence sources', () => {
    expect(validateApprovalOrganization('customer')).toEqual({ ok: true, value: 'customer' });
    expect(validateApprovalOrganization('maker')).toMatchObject({ ok: false, code: 'UNKNOWN_APPROVAL_ORGANIZATION' });
    expect(validateApprovalDecision('APPROVE')).toEqual({ ok: true, value: 'APPROVE' });
    expect(validateApprovalDecision('REJECT')).toMatchObject({ ok: false, code: 'UNKNOWN_APPROVAL_DECISION' });
    expect(validateApprovalEvidenceSource('email')).toEqual({ ok: true, value: 'email' });
    expect(validateApprovalEvidenceSource('verbal')).toMatchObject({ ok: false, code: 'UNKNOWN_EVIDENCE_SOURCE' });
  });
});
