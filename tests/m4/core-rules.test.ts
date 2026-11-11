import { describe, expect, it } from 'vitest';
import {
  approvedSnapshotMatchesCurrent,
  buildMakerPoSnapshot,
  canonicalJson,
  computeMakerPoSnapshotSha256,
  evaluateMakerPoAcceptEvidence,
  evaluateMakerPoApproval,
  evaluateMakerPoCreationGate,
  evaluateMakerPoSendEvidence,
  evaluateMakerPoSendTransition,
  MAKER_PURCHASE_ORDER_STATUSES,
  transitionMakerPurchaseOrder,
  validateMakerPoEventType,
  validateMakerPoStatus,
  validateMakerPoVerificationStatus,
  type MakerPoEvidenceDocument,
  type MakerPoSnapshotInput
} from '@kanei/core';

const ORDER_ID = '11111111-1111-7111-8111-111111111111';
const PROJECT_ID = '22222222-2222-7222-8222-222222222222';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

function snapshotInput(overrides: Partial<MakerPoSnapshotInput> = {}): MakerPoSnapshotInput {
  return {
    order: { id: ORDER_ID, code: 'FSO-M4-CORE', sevenPoNumber: 'SEVEN-M4-CORE' },
    items: [
      { lineNumber: 2, description: '合成台紙', orderedQuantity: '50.000', unit: 'rolls' },
      { lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '100000.000', unit: 'sheets' }
    ],
    artworkFiles: [{ designKey: 'label-front', revisionNo: 1, fileSha256: SHA_A }],
    amounts: { currency: 'JPY', totalAmount: '480000' },
    recipientAddress: '  maker-po@example.com ',
    ...overrides
  };
}

function snapshot(overrides: Partial<MakerPoSnapshotInput> = {}) {
  return buildMakerPoSnapshot(snapshotInput(overrides));
}

function sendEvidence(overrides: Partial<MakerPoEvidenceDocument> = {}): MakerPoEvidenceDocument {
  return {
    documentId: nextId(),
    versionId: nextId(),
    sha256: SHA_C,
    documentType: 'send_evidence',
    projectId: PROJECT_ID,
    filmSupplyOrderId: ORDER_ID,
    designKey: null,
    verificationStatus: 'unverified',
    ...overrides
  };
}

const SEND_CONTEXT = {
  order: { id: ORDER_ID, projectId: PROJECT_ID },
  approvedSnapshotSha256: computeMakerPoSnapshotSha256(snapshot()),
  currentSnapshotSha256: computeMakerPoSnapshotSha256(snapshot()),
  snapshot: snapshot(),
  evidenceDocument: sendEvidence()
};

describe('M4 snapshot identity (G10)', () => {
  it('canonical JSON is key-order independent and array-order significant', () => {
    expect(canonicalJson({ b: 2, a: { d: 1, c: [3, 1] } })).toBe(canonicalJson({ b: 2, a: { c: [3, 1], d: 1 } }));
    expect(canonicalJson([1, 2])).toBe('[1,2]');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('the digest only moves when the underlying business data moves', () => {
    // Normalization (item order, recipient whitespace) never moves the digest.
    const normalized = computeMakerPoSnapshotSha256(snapshot());
    const reordered = computeMakerPoSnapshotSha256(buildMakerPoSnapshot({
      ...snapshotInput(),
      items: [...snapshotInput().items].reverse(),
      recipientAddress: 'maker-po@example.com'
    }));
    expect(reordered).toBe(normalized);

    // A quantity change (T-23) or a new artwork hash (T-24) always does.
    expect(computeMakerPoSnapshotSha256(snapshot({
      items: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '95000.000', unit: 'sheets' }]
    }))).not.toBe(normalized);
    expect(computeMakerPoSnapshotSha256(snapshot({
      artworkFiles: [{ designKey: 'label-front', revisionNo: 2, fileSha256: SHA_B }]
    }))).not.toBe(normalized);
    expect(computeMakerPoSnapshotSha256(snapshot({
      recipientAddress: 'other-maker@example.com'
    }))).not.toBe(normalized);
    expect(computeMakerPoSnapshotSha256(snapshot({ amounts: { currency: 'JPY', totalAmount: '1' } })))
      .not.toBe(normalized);
  });

  it('approved snapshot hash equality is exact and order-independent of the arguments', () => {
    expect(approvedSnapshotMatchesCurrent(SHA_A, SHA_A)).toBe(true);
    expect(approvedSnapshotMatchesCurrent(SHA_A, SHA_B)).toBe(false);
    expect(approvedSnapshotMatchesCurrent(SHA_B, SHA_A)).toBe(false);
  });

  it('the snapshot carries the order, items, quantities, specs, amounts and recipient', () => {
    const frozen = snapshot();
    expect(frozen.order).toEqual({ id: ORDER_ID, code: 'FSO-M4-CORE', sevenPoNumber: 'SEVEN-M4-CORE' });
    expect(frozen.items.map((item) => item.lineNumber)).toEqual([1, 2]);
    expect(frozen.quantities).toEqual([
      { lineNumber: 1, orderedQuantity: '100000.000', unit: 'sheets' },
      { lineNumber: 2, orderedQuantity: '50.000', unit: 'rolls' }
    ]);
    expect(frozen.specs.artworkFiles).toEqual([{ designKey: 'label-front', revisionNo: 1, fileSha256: SHA_A }]);
    expect(frozen.amounts).toEqual({ currency: 'JPY', totalAmount: '480000' });
    expect(frozen.recipient).toEqual({ address: 'maker-po@example.com' });
    expect(computeMakerPoSnapshotSha256(frozen)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('amounts stay null unless both currency and total amount are recorded', () => {
    expect(snapshot({ amounts: null }).amounts).toBeNull();
    expect(snapshot({ amounts: { currency: 'JPY', totalAmount: undefined } }).amounts).toBeNull();
  });
});

describe('M4 allowed transitions (G8)', () => {
  it('the CEO approval is the only exit from DRAFT and the only way back from a voided snapshot', () => {
    expect(transitionMakerPurchaseOrder('DRAFT', 'APPROVED_FOR_MANUAL_SEND').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('DRAFT', 'MAKER_PO_SENT_MANUALLY').ok).toBe(false);
    expect(transitionMakerPurchaseOrder('DRAFT', 'SEND_UNVERIFIED').ok).toBe(false);
    expect(transitionMakerPurchaseOrder('SNAPSHOT_VOIDED', 'APPROVED_FOR_MANUAL_SEND').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('SNAPSHOT_VOIDED', 'MAKER_PO_SENT_MANUALLY').ok).toBe(false);
    expect(transitionMakerPurchaseOrder('SNAPSHOT_VOIDED', 'SEND_UNVERIFIED').ok).toBe(false);
  });

  it('an approved paper can be sent, recorded as unverifiable, or voided', () => {
    expect(transitionMakerPurchaseOrder('APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('APPROVED_FOR_MANUAL_SEND', 'SEND_UNVERIFIED').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('APPROVED_FOR_MANUAL_SEND', 'SNAPSHOT_VOIDED').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_ACCEPTED').ok).toBe(false);
  });

  it('SEND_UNVERIFIED is a dead end and acceptance only follows a proven send', () => {
    for (const target of MAKER_PURCHASE_ORDER_STATUSES) {
      expect(transitionMakerPurchaseOrder('SEND_UNVERIFIED', target).ok).toBe(false);
      expect(transitionMakerPurchaseOrder('MAKER_PO_ACCEPTED', target).ok).toBe(false);
    }
    expect(transitionMakerPurchaseOrder('MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED').ok).toBe(true);
    expect(transitionMakerPurchaseOrder('MAKER_PO_SENT_MANUALLY', 'SEND_UNVERIFIED').ok).toBe(false);
    expect(makerPurchaseOrderTransitions('SEND_UNVERIFIED')).toEqual([]);
  });

  it('the approval and send gates expose the transition rules with a code', () => {
    expect(evaluateMakerPoApproval('DRAFT').ok).toBe(true);
    expect(evaluateMakerPoApproval('SNAPSHOT_VOIDED').ok).toBe(true);
    const blocked = evaluateMakerPoApproval('APPROVED_FOR_MANUAL_SEND');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('MAKER_PO_TRANSITION_BLOCKED');
      expect(blocked.from).toBe('APPROVED_FOR_MANUAL_SEND');
    }
    const sendBlocked = evaluateMakerPoSendTransition('SEND_UNVERIFIED');
    expect(sendBlocked.ok).toBe(false);
    if (!sendBlocked.ok) expect(sendBlocked.code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    expect(evaluateMakerPoSendTransition('APPROVED_FOR_MANUAL_SEND').ok).toBe(true);
    expect(evaluateMakerPoSendTransition('DRAFT').ok).toBe(false);
    expect(evaluateMakerPoSendTransition('MAKER_PO_ACCEPTED').ok).toBe(false);
  });

  it('the maker paper is frozen only at MAKER_PO_READY', () => {
    expect(evaluateMakerPoCreationGate({ orderStatus: 'MAKER_PO_READY' }).ok).toBe(true);
    const gate = evaluateMakerPoCreationGate({ orderStatus: 'APPROVAL_PENDING' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('MAKER_PO_NOT_READY');
    expect(evaluateMakerPoCreationGate({ orderStatus: 'DUAL_APPROVED' }).ok).toBe(false);
    expect(evaluateMakerPoCreationGate({ orderStatus: 'APPROVED_FOR_MANUAL_SEND' }).ok).toBe(false);
  });

  it('validates the M4 vocabulary', () => {
    expect(validateMakerPoStatus('SEND_UNVERIFIED').ok).toBe(true);
    expect(validateMakerPoStatus('SENT').ok).toBe(false);
    expect(validateMakerPoEventType('SNAPSHOT_VOIDED').ok).toBe(true);
    expect(validateMakerPoEventType('APPROVED').ok).toBe(false);
    expect(validateMakerPoVerificationStatus('VERIFIED').ok).toBe(true);
    expect(validateMakerPoVerificationStatus('verified').ok).toBe(false);
  });
});

describe('M4 send evidence verification (G9)', () => {
  const sentAt = '2026-11-12T09:00:00.000Z';

  it('records a bare sent_at timestamp as an UNVERIFIED send', () => {
    const result = evaluateMakerPoSendEvidence(
      { evidenceDocumentVersionId: null, senderAddress: null, recipients: null, sentAt, attachmentHashes: null },
      SEND_CONTEXT
    );
    expect(result).toMatchObject({ ok: true, verificationStatus: 'UNVERIFIED', sentAt });
  });

  it('requires sent_at in both shapes', () => {
    const withoutAnything = evaluateMakerPoSendEvidence(
      { evidenceDocumentVersionId: null, senderAddress: null, recipients: null, sentAt: null, attachmentHashes: null },
      SEND_CONTEXT
    );
    expect(withoutAnything).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'SENT_AT_REQUIRED' });

    const evidenceWithoutSentAt = evaluateMakerPoSendEvidence(
      {
        evidenceDocumentVersionId: 'v1',
        senderAddress: 'sender@example.com',
        recipients: ['maker-po@example.com'],
        sentAt: null,
        attachmentHashes: null
      },
      SEND_CONTEXT
    );
    expect(evidenceWithoutSentAt).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'SENT_AT_REQUIRED' });
  });

  it('verifies a send proven by a bound send_evidence document and records its hash', () => {
    const result = evaluateMakerPoSendEvidence(
      {
        evidenceDocumentVersionId: 'v1',
        senderAddress: ' sender@example.com ',
        recipients: ['Maker-PO@example.com', 'archive@example.com'],
        sentAt,
        attachmentHashes: [SHA_B],
      },
      SEND_CONTEXT
    );
    expect(result).toMatchObject({
      ok: true,
      verificationStatus: 'VERIFIED',
      senderAddress: 'sender@example.com',
      recipients: ['Maker-PO@example.com', 'archive@example.com'],
      sentAt,
      evidenceDocumentVersionId: 'v1'
    });
    if (result.ok && result.verificationStatus === 'VERIFIED') {
      // The evidence document's own bytes are always part of the recorded set.
      expect(result.attachmentHashes).toEqual([SHA_C, SHA_B]);
    }
  });

  it('voids the snapshot when the recomputed digest no longer matches the approved one', () => {
    const drifted = computeMakerPoSnapshotSha256(snapshot({
      items: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '95000.000', unit: 'sheets' }]
    }));
    const result = evaluateMakerPoSendEvidence(
      {
        evidenceDocumentVersionId: 'v1',
        senderAddress: 'sender@example.com',
        recipients: ['maker-po@example.com'],
        sentAt,
        attachmentHashes: null
      },
      { ...SEND_CONTEXT, currentSnapshotSha256: drifted }
    );
    expect(result).toMatchObject({ ok: false, outcome: 'snapshot_voided', code: 'SNAPSHOT_VOIDED' });
  });

  it('rejects evidence that is unknown, of another type, company or order, or headed elsewhere', () => {
    const provenRequest = {
      evidenceDocumentVersionId: 'v1',
      senderAddress: 'sender@example.com',
      recipients: ['maker-po@example.com'],
      sentAt,
      attachmentHashes: null
    };

    expect(evaluateMakerPoSendEvidence(provenRequest, { ...SEND_CONTEXT, evidenceDocument: null }))
      .toMatchObject({ ok: false, outcome: 'rejected', code: 'SEND_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND' });
    expect(evaluateMakerPoSendEvidence(provenRequest, {
      ...SEND_CONTEXT,
      evidenceDocument: sendEvidence({ documentType: 'proof' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'SEND_EVIDENCE_DOCUMENT_TYPE_INVALID' });
    expect(evaluateMakerPoSendEvidence(provenRequest, {
      ...SEND_CONTEXT,
      evidenceDocument: sendEvidence({ projectId: '33333333-3333-7333-8333-333333333333' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'SEND_EVIDENCE_PROJECT_MISMATCH' });
    expect(evaluateMakerPoSendEvidence(provenRequest, {
      ...SEND_CONTEXT,
      evidenceDocument: sendEvidence({ filmSupplyOrderId: '44444444-4444-7444-8444-444444444444' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'SEND_EVIDENCE_ORDER_MISMATCH' });
    expect(evaluateMakerPoSendEvidence(
      { ...provenRequest, recipients: ['archive@example.com'] },
      SEND_CONTEXT
    )).toMatchObject({ ok: false, outcome: 'rejected', code: 'SEND_RECIPIENT_MISMATCH' });
  });

  it('refuses malformed request fields without recording anything', () => {
    const missingSender = evaluateMakerPoSendEvidence(
      {
        evidenceDocumentVersionId: 'v1',
        senderAddress: '',
        recipients: ['maker-po@example.com'],
        sentAt,
        attachmentHashes: null
      },
      SEND_CONTEXT
    );
    expect(missingSender).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'SENDER_ADDRESS_REQUIRED' });

    const missingRecipients = evaluateMakerPoSendEvidence(
      { evidenceDocumentVersionId: 'v1', senderAddress: 'sender@example.com', recipients: [], sentAt, attachmentHashes: null },
      SEND_CONTEXT
    );
    expect(missingRecipients).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'RECIPIENTS_REQUIRED' });

    const badHashes = evaluateMakerPoSendEvidence(
      {
        evidenceDocumentVersionId: 'v1',
        senderAddress: 'sender@example.com',
        recipients: ['maker-po@example.com'],
        sentAt,
        attachmentHashes: ['not-a-hash']
      },
      SEND_CONTEXT
    );
    expect(badHashes).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'INVALID_ATTACHMENT_HASH' });
  });
});

describe('M4 acceptance (T-22)', () => {
  const request = { evidenceDocumentVersionId: 'v1', attachmentHashes: null, acceptedAt: '2026-11-12T10:00:00.000Z' };
  const context = {
    order: { id: ORDER_ID, projectId: PROJECT_ID },
    evidenceDocument: sendEvidence({
      documentType: 'acceptance_evidence',
      verificationStatus: 'verified'
    })
  };

  it('requires an acceptance evidence document version', () => {
    expect(evaluateMakerPoAcceptEvidence(
      { evidenceDocumentVersionId: null, attachmentHashes: null, acceptedAt: null },
      context
    )).toMatchObject({ ok: false, outcome: 'invalid_request', code: 'ACCEPT_EVIDENCE_REQUIRED' });
    expect(evaluateMakerPoAcceptEvidence(request, { ...context, evidenceDocument: null }))
      .toMatchObject({ ok: false, outcome: 'rejected', code: 'ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND' });
  });

  it('rejects foreign, mistyped or humanly-unverified acceptance documents', () => {
    expect(evaluateMakerPoAcceptEvidence(request, {
      ...context,
      evidenceDocument: sendEvidence({ documentType: 'proof', verificationStatus: 'verified' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID' });
    expect(evaluateMakerPoAcceptEvidence(request, {
      ...context,
      evidenceDocument: sendEvidence({ documentType: 'acceptance_evidence', projectId: '33333333-3333-7333-8333-333333333333' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'ACCEPT_EVIDENCE_PROJECT_MISMATCH' });
    expect(evaluateMakerPoAcceptEvidence(request, {
      ...context,
      evidenceDocument: sendEvidence({ documentType: 'acceptance_evidence', filmSupplyOrderId: '44444444-4444-7444-8444-444444444444' })
    })).toMatchObject({ ok: false, outcome: 'rejected', code: 'ACCEPT_EVIDENCE_ORDER_MISMATCH' });
    const unverified = evaluateMakerPoAcceptEvidence(request, {
      ...context,
      evidenceDocument: sendEvidence({ documentType: 'acceptance_evidence', verificationStatus: 'unverified' })
    });
    expect(unverified).toMatchObject({ ok: false, outcome: 'rejected', code: 'ACCEPT_EVIDENCE_NOT_VERIFIED' });
  });

  it('accepts behind a verified acceptance document and records its hash', () => {
    const result = evaluateMakerPoAcceptEvidence(
      { ...request, attachmentHashes: [SHA_B] },
      context
    );
    expect(result).toMatchObject({ ok: true, verificationStatus: 'VERIFIED', acceptedAt: '2026-11-12T10:00:00.000Z' });
    if (result.ok) expect(result.attachmentHashes).toEqual([SHA_C, SHA_B]);
  });
});
