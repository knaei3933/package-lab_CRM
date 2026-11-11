import { evaluateSevenPoVerificationGate } from './state-machine.js';

/**
 * M2 document intake and seven purchase order precedence (design sections
 * 5.4, 5.6 and 5.10).
 *
 * Two axes are kept strictly apart:
 * - the date axis: official_registered_at is the only date any gate reads;
 * - the authenticity axis: a human recorded the seven checklist items through
 *   the checklist endpoint. A content hash proves bytes are unchanged; it never
 *   proves the document is authentic, so authenticity can never be estimated
 *   from metadata alone.
 */

export const DOCUMENT_TYPES = [
  'seven_po',
  'filling_quote_seven',
  'film_quote_kanei',
  'proof',
  'approval_evidence',
  'send_evidence',
  'acceptance_evidence'
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Input paperwork: what a purchase order is verified against. Never gated. */
export const INPUT_DOCUMENT_TYPES = ['seven_po', 'filling_quote_seven', 'film_quote_kanei'] as const;

/**
 * Official artifacts of the flow. Registering one requires a purchase order
 * that is both officially registered and checklist-verified (T-04, T-05).
 */
export const OFFICIAL_ARTIFACT_DOCUMENT_TYPES = [
  'proof',
  'approval_evidence',
  'send_evidence',
  'acceptance_evidence'
] as const;

export const ISSUER_ENTITIES = ['seven', 'kanei', 'maker', 'customer_generated', 'unknown'] as const;
export type IssuerEntity = (typeof ISSUER_ENTITIES)[number];

export const VERIFICATION_STATUSES = ['unverified', 'verified', 'mismatch'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type DocumentTypeValidation =
  | { ok: true; documentType: DocumentType }
  | { ok: false; code: 'UNKNOWN_DOCUMENT_TYPE'; message: string };

export function validateDocumentType(value: unknown): DocumentTypeValidation {
  if (typeof value !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_DOCUMENT_TYPE',
      message: `documentType must be one of ${DOCUMENT_TYPES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, documentType: value as DocumentType };
}

export type IssuerEntityValidation =
  | { ok: true; issuerEntity: IssuerEntity }
  | { ok: false; code: 'UNKNOWN_ISSUER_ENTITY'; message: string };

export function validateIssuerEntity(value: unknown): IssuerEntityValidation {
  if (typeof value !== 'string' || !(ISSUER_ENTITIES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_ISSUER_ENTITY',
      message: `issuerEntity must be one of ${ISSUER_ENTITIES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, issuerEntity: value as IssuerEntity };
}

export function isOfficialArtifactDocumentType(documentType: DocumentType): boolean {
  return (OFFICIAL_ARTIFACT_DOCUMENT_TYPES as readonly string[]).includes(documentType);
}

export interface SevenPoPrecedenceGateInput {
  officialRegisteredAt: Date | string | null;
  verificationStatus: VerificationStatus;
  reviewPending: boolean;
}

export type SevenPoPrecedenceGate =
  | { ok: true; gatedOn: 'official_registration_and_checklist_verification' }
  | {
      ok: false;
      code: 'OFFICIAL_REGISTRATION_REQUIRED' | 'SEVEN_PO_NOT_VERIFIED' | 'PO_REVIEW_PENDING';
      message: string;
    };

/**
 * Precedence gate for registering an official artifact or a supply order
 * against a seven purchase order.
 *
 * The date axis is evaluated first and reads official_registered_at ONLY (T-06):
 * original_received_at is reference data and checklist verification can never
 * substitute for the official registration date. Only then is the authenticity
 * axis evaluated, from the recorded checklist result.
 */
export function evaluateSevenPoPrecedenceGate(po: SevenPoPrecedenceGateInput): SevenPoPrecedenceGate {
  const dateGate = evaluateSevenPoVerificationGate(po);
  if (!dateGate.ok) return dateGate;

  if (po.reviewPending) {
    return {
      ok: false,
      code: 'PO_REVIEW_PENDING',
      message: 'the quote-vs-PO comparison is under review; the gate stays closed until the review resolves'
    };
  }
  if (po.verificationStatus !== 'verified') {
    return {
      ok: false,
      code: 'SEVEN_PO_NOT_VERIFIED',
      message: 'seven purchase order authenticity has not been verified through the checklist'
    };
  }
  return { ok: true, gatedOn: 'official_registration_and_checklist_verification' };
}

/**
 * The seven authenticity checklist items of design section 5.10. Every item is
 * a human record; item 6 (tamper-hint notes) is advisory only and never
 * influences the verdict, and item 7 (confirmation reply) is required exactly
 * when the reviewer marked the document as uncertain.
 */
export const SEVEN_PO_AUTHENTICITY_CHECKLIST = [
  'issuer name',
  'document number and issue date',
  'sending channel',
  'past-transaction comparison',
  'quote comparison',
  'tamper-hint notes (advisory only)',
  'confirmation reply when uncertain'
] as const;

export interface SevenPoChecklistRecord {
  issuerNameRecorded: boolean;
  issuerName: string | null;
  documentNumberRecorded: boolean;
  documentNumber: string | null;
  issueDateRecorded: boolean;
  issueDate: string | null;
  sendingChannelRecorded: boolean;
  sendingChannel: string | null;
  pastTransactionCompared: boolean;
  pastTransactionNote: string | null;
  quoteCompared: boolean;
  quoteMatchesPo: boolean | null;
  quoteComparisonNote: string | null;
  tamperHints: string | null;
  uncertain: boolean;
  confirmationReplyRecorded: boolean;
  confirmationReplyNote: string | null;
  verificationNote: string | null;
}

export type SevenPoChecklistEvaluation =
  | {
      ok: true;
      status: 'verified' | 'mismatch';
      reviewPending: boolean;
      checklist: SevenPoChecklistRecord;
    }
  | {
      ok: false;
      code: 'CHECKLIST_INCOMPLETE' | 'CONFIRMATION_REPLY_REQUIRED';
      missing: string[];
      message: string;
    };

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredFlag(value: unknown): boolean {
  return value === true;
}

/**
 * Evaluates a checklist submission. The verdict is derived only from the
 * recorded human items: a submission that records document metadata without the
 * past-transaction and quote comparisons is incomplete (T-18), and a recorded
 * quote mismatch produces the mismatch status with reviewPending=true so every
 * precedence gate stays closed (T-19).
 */
export function evaluateSevenPoChecklist(raw: unknown): SevenPoChecklistEvaluation {
  const body = (raw ?? {}) as Record<string, unknown>;
  const missing: string[] = [];

  const issuerNameRecorded = requiredFlag(body.issuerNameRecorded);
  if (!issuerNameRecorded) missing.push('issuer name');

  const documentNumberRecorded = requiredFlag(body.documentNumberRecorded);
  if (!documentNumberRecorded) missing.push('document number');
  const issueDateRecorded = requiredFlag(body.issueDateRecorded);
  if (!issueDateRecorded) missing.push('issue date');

  const sendingChannelRecorded = requiredFlag(body.sendingChannelRecorded);
  if (!sendingChannelRecorded) missing.push('sending channel');

  const pastTransactionCompared = requiredFlag(body.pastTransactionCompared);
  if (!pastTransactionCompared) missing.push('past-transaction comparison');

  const quoteCompared = requiredFlag(body.quoteCompared);
  const quoteMatchesPo = typeof body.quoteMatchesPo === 'boolean' ? body.quoteMatchesPo : null;
  if (!quoteCompared || quoteMatchesPo === null) missing.push('quote comparison');

  const uncertain = body.uncertain === true;
  const confirmationReplyRecorded = requiredFlag(body.confirmationReplyRecorded);
  if (uncertain && !confirmationReplyRecorded) {
    // Item 7 is conditional: a confirmation reply is mandatory when the reviewer
    // was uncertain, and no amount of metadata can replace it.
    return {
      ok: false,
      code: 'CONFIRMATION_REPLY_REQUIRED',
      missing: ['confirmation reply when uncertain'],
      message: 'a confirmation reply must be recorded when the reviewer is uncertain'
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CHECKLIST_INCOMPLETE',
      missing,
      message: `the authenticity checklist requires a human record of: ${missing.join(', ')}`
    };
  }

  // Tamper-hint notes are advisory: they are stored verbatim and are never read
  // when deciding the verdict.
  const checklist: SevenPoChecklistRecord = {
    issuerNameRecorded,
    issuerName: optionalText(body.issuerName),
    documentNumberRecorded,
    documentNumber: optionalText(body.documentNumber),
    issueDateRecorded,
    issueDate: optionalText(body.issueDate),
    sendingChannelRecorded,
    sendingChannel: optionalText(body.sendingChannel),
    pastTransactionCompared,
    pastTransactionNote: optionalText(body.pastTransactionNote),
    quoteCompared,
    quoteMatchesPo,
    quoteComparisonNote: optionalText(body.quoteComparisonNote),
    tamperHints: optionalText(body.tamperHints),
    uncertain,
    confirmationReplyRecorded,
    confirmationReplyNote: optionalText(body.confirmationReplyNote),
    verificationNote: optionalText(body.verificationNote)
  };

  if (quoteMatchesPo === false) {
    return {
      ok: true,
      status: 'mismatch',
      reviewPending: true,
      checklist
    };
  }
  return { ok: true, status: 'verified', reviewPending: false, checklist };
}
