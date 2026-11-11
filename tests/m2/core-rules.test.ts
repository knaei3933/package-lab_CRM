import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  ISSUER_ENTITIES,
  OFFICIAL_ARTIFACT_DOCUMENT_TYPES,
  SEVEN_PO_AUTHENTICITY_CHECKLIST,
  evaluateSevenPoChecklist,
  evaluateSevenPoPrecedenceGate,
  evaluateSevenPoVerificationGate,
  isOfficialArtifactDocumentType,
  validateDocumentType,
  validateIssuerEntity
} from '@kanei/core';

const registeredAt = new Date('2026-11-05T00:00:00.000Z');
const receivedAt = new Date('2026-11-01T00:00:00.000Z');

/** A purchase order that passed every axis: official registration + checklist. */
const verifiedPo = {
  officialRegisteredAt: registeredAt,
  verificationStatus: 'verified' as const,
  reviewPending: false
};

/**
 * A complete human record of the seven checklist items (design section 5.10).
 * Tamper hints are advisory and stay empty here.
 */
function completeChecklist(overrides: Record<string, unknown> = {}) {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: 'PO-2026-1105-01',
    issueDateRecorded: true,
    issueDate: '2026-11-05',
    sendingChannelRecorded: true,
    sendingChannel: '専用ポータル',
    pastTransactionCompared: true,
    pastTransactionNote: '過去3件の発注書と様式が一致',
    quoteCompared: true,
    quoteMatchesPo: true,
    quoteComparisonNote: '見積と仕様・数量・金額が一致',
    tamperHints: '',
    uncertain: false,
    confirmationReplyRecorded: false,
    confirmationReplyNote: '',
    verificationNote: '合成チェックリスト記録',
    ...overrides
  };
}

describe('M2 document vocabulary', () => {
  it('accepts exactly the seven document types and five issuer entities', () => {
    expect(DOCUMENT_TYPES).toHaveLength(7);
    expect(ISSUER_ENTITIES).toHaveLength(5);
    for (const documentType of DOCUMENT_TYPES) {
      expect(validateDocumentType(documentType)).toEqual({ ok: true, documentType });
    }
    for (const issuerEntity of ISSUER_ENTITIES) {
      expect(validateIssuerEntity(issuerEntity)).toEqual({ ok: true, issuerEntity });
    }
    expect(validateDocumentType('invoice').ok).toBe(false);
    expect(validateIssuerEntity('competitor').ok).toBe(false);
    expect(validateDocumentType(42).ok).toBe(false);
  });

  it('classifies the official artifacts that require a verified purchase order', () => {
    expect(OFFICIAL_ARTIFACT_DOCUMENT_TYPES).toHaveLength(4);
    expect(isOfficialArtifactDocumentType('proof')).toBe(true);
    expect(isOfficialArtifactDocumentType('acceptance_evidence')).toBe(true);
    expect(isOfficialArtifactDocumentType('seven_po')).toBe(false);
    expect(isOfficialArtifactDocumentType('film_quote_kanei')).toBe(false);
  });
});

describe('M2 seven PO precedence gate', () => {
  it('T-06 evaluates the date axis on official_registered_at only', () => {
    // Checklist verification can never substitute for the official registration
    // date: the gate fails with the registration code, not the verification code.
    const gate = evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: null,
      verificationStatus: 'verified',
      reviewPending: false
    });
    expect(gate).toMatchObject({ ok: false, code: 'OFFICIAL_REGISTRATION_REQUIRED' });

    // The date gate itself still reads official_registered_at only; the received
    // date is reference data that never satisfies it.
    expect(evaluateSevenPoVerificationGate({ officialRegisteredAt: registeredAt, originalReceivedAt: receivedAt }))
      .toEqual({ ok: true, gatedOn: 'official_registered_at' });
    expect(evaluateSevenPoVerificationGate({ officialRegisteredAt: null, originalReceivedAt: receivedAt }))
      .toMatchObject({ ok: false, code: 'OFFICIAL_REGISTRATION_REQUIRED' });
  });

  it('rejects unverified purchase orders on the authenticity axis', () => {
    expect(evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: registeredAt,
      verificationStatus: 'unverified',
      reviewPending: false
    })).toMatchObject({ ok: false, code: 'SEVEN_PO_NOT_VERIFIED' });

    expect(evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: registeredAt,
      verificationStatus: 'mismatch',
      reviewPending: false
    })).toMatchObject({ ok: false, code: 'SEVEN_PO_NOT_VERIFIED' });
  });

  it('keeps the gate closed while a quote comparison review is pending', () => {
    expect(evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: registeredAt,
      verificationStatus: 'verified',
      reviewPending: true
    })).toMatchObject({ ok: false, code: 'PO_REVIEW_PENDING' });
  });

  it('opens only for a registered and checklist-verified purchase order', () => {
    expect(evaluateSevenPoPrecedenceGate(verifiedPo)).toEqual({
      ok: true,
      gatedOn: 'official_registration_and_checklist_verification'
    });
  });
});

describe('M2 seven PO authenticity checklist', () => {
  it('lists the seven design items', () => {
    expect(SEVEN_PO_AUTHENTICITY_CHECKLIST).toHaveLength(7);
  });

  it('T-18 refuses to verify authenticity from metadata alone', () => {
    // Issuer, document number, issue date and sending channel are metadata;
    // without the human comparisons the submission is incomplete.
    const metadataOnly = evaluateSevenPoChecklist({
      issuerNameRecorded: true,
      issuerName: '合成セブン化学事業',
      documentNumberRecorded: true,
      documentNumber: 'PO-2026-1105-01',
      issueDateRecorded: true,
      issueDate: '2026-11-05',
      sendingChannelRecorded: true,
      sendingChannel: '専用ポータル',
      uncertain: false
    });
    expect(metadataOnly).toMatchObject({ ok: false, code: 'CHECKLIST_INCOMPLETE' });
    if (!metadataOnly.ok) {
      expect(metadataOnly.missing).toContain('past-transaction comparison');
      expect(metadataOnly.missing).toContain('quote comparison');
    }

    // The empty case and the quote-result case are incomplete too.
    expect(evaluateSevenPoChecklist({})).toMatchObject({ ok: false, code: 'CHECKLIST_INCOMPLETE' });
    expect(evaluateSevenPoChecklist(completeChecklist({ quoteMatchesPo: undefined })))
      .toMatchObject({ ok: false, code: 'CHECKLIST_INCOMPLETE' });
  });

  it('requires a confirmation reply exactly when the reviewer is uncertain', () => {
    const missingReply = evaluateSevenPoChecklist(completeChecklist({
      uncertain: true,
      confirmationReplyRecorded: false
    }));
    expect(missingReply).toMatchObject({ ok: false, code: 'CONFIRMATION_REPLY_REQUIRED' });

    const withReply = evaluateSevenPoChecklist(completeChecklist({
      uncertain: true,
      confirmationReplyRecorded: true,
      confirmationReplyNote: 'セブン担当に確認済み（返信記録）'
    }));
    expect(withReply).toMatchObject({ ok: true, status: 'verified', reviewPending: false });
  });

  it('records tamper-hint notes as advisory only: they never change the verdict', () => {
    const withoutHints = evaluateSevenPoChecklist(completeChecklist({ tamperHints: '' }));
    expect(withoutHints).toMatchObject({ ok: true, status: 'verified', reviewPending: false });
    if (withoutHints.ok) expect(withoutHints.checklist.tamperHints).toBeNull();

    const alarming = evaluateSevenPoChecklist(completeChecklist({
      tamperHints: '検印のフォントが過去分と異なる（参考メモ）'
    }));
    expect(alarming).toMatchObject({ ok: true, status: 'verified', reviewPending: false });
    if (alarming.ok) {
      expect(alarming.checklist.tamperHints).toBe('検印のフォントが過去分と異なる（参考メモ）');
    }
  });

  it('T-19 turns a quote-vs-PO mismatch into the mismatch status with review pending', () => {
    const mismatch = evaluateSevenPoChecklist(completeChecklist({
      quoteMatchesPo: false,
      quoteComparisonNote: '金額が見積より120,000円大きい'
    }));
    expect(mismatch).toMatchObject({ ok: true, status: 'mismatch', reviewPending: true });
    if (mismatch.ok) {
      expect(mismatch.checklist.quoteMatchesPo).toBe(false);
    }

    // And the mismatch feeds the precedence gate: registered but under review.
    expect(evaluateSevenPoPrecedenceGate({
      officialRegisteredAt: registeredAt,
      verificationStatus: 'mismatch',
      reviewPending: true
    })).toMatchObject({ ok: false, code: 'PO_REVIEW_PENDING' });
  });

  it('verifies when every required item carries a human record', () => {
    const result = evaluateSevenPoChecklist(completeChecklist());
    expect(result).toMatchObject({ ok: true, status: 'verified', reviewPending: false });
    if (result.ok) {
      expect(result.checklist.issuerName).toBe('合成セブン化学事業');
      expect(result.checklist.pastTransactionCompared).toBe(true);
      expect(result.checklist.verificationNote).toBe('合成チェックリスト記録');
    }
  });
});
