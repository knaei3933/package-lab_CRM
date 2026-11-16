import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildMakerPoSnapshot,
  computeMakerPoSnapshotSha256,
  evaluateMakerPoAcceptEvidence,
  evaluateMakerPoCancellation,
  evaluateMakerPoEmlEvidence,
  evaluateMakerPoSentAtCurrency,
  evaluateMakerPoSendEvidence,
  isActiveMakerPurchaseOrderStatus,
  isValidMessageId,
  makerPurchaseOrderTransitions,
  MAKER_PURCHASE_ORDER_STATUSES,
  MAKER_PO_EVENT_VERIFICATION_STATUSES,
  MAKER_PO_EVENT_TYPES,
  MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK,
  MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS,
  parseEml,
  transitionMakerPurchaseOrder,
  validateMakerPoEventType,
  validateMakerPoStatus,
  validateMakerPoVerificationStatus,
  type MakerPoSnapshot
} from '@kanei/core';

/**
 * M8-HARDEN pure rules: the .eml verification of the send evidence (FIX C1),
 * the time guards (FIX C2), the one-active-maker-PO vocabulary and the
 * cancellation gate (FIX B2), and the acceptance evidence bound to one maker PO
 * (FIX B2 d). The API-level behavior these rules power is pinned in
 * tests/m8-fail/m8-fail-scenarios.test.ts.
 */

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const ARTWORK_BYTES = 'composite approved artwork bytes\n';
const ARTWORK_HASH = sha256(ARTWORK_BYTES);
const ORDER_CODE = 'FSO-HARDEN-0001';
const RECIPIENT = 'maker-po@example.com';
const SENDER = 'staff@kanei.example';

const SNAPSHOT: MakerPoSnapshot = buildMakerPoSnapshot({
  order: { id: '11111111-1111-7111-8111-111111111111', code: ORDER_CODE, sevenPoNumber: 'SEVEN-HARDEN-0001' },
  items: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '100000.000', unit: 'sheets' }],
  artworkFiles: [{ designKey: 'label-front', revisionNo: 1, fileSha256: ARTWORK_HASH }],
  amounts: { currency: 'JPY', totalAmount: '480000' },
  recipientAddress: RECIPIENT
});

/** A genuine multipart export: the artwork attached, everything the checks read. */
function buildEml(overrides: {
  to?: string;
  from?: string;
  subject?: string;
  dateIso?: string;
  withMessageId?: boolean;
  messageId?: string;
  attachmentBytes?: string;
  cc?: string;
} = {}): Buffer {
  const date = new Date(overrides.dateIso ?? '2026-11-16T00:00:00.000Z').toUTCString();
  const attachment = overrides.attachmentBytes ?? ARTWORK_BYTES;
  const boundary = '------------kanei-hardener-boundary';
  const headers = [
    `From: KANEI 担当 <${overrides.from ?? SENDER}>`,
    `To: Maker Inc. <${overrides.to ?? RECIPIENT}>`,
    ...(overrides.cc ? [`Cc: ${overrides.cc}`] : []),
    `Subject: ${overrides.subject ?? `製造先発注書 ${ORDER_CODE}`}`,
    `Date: ${date}`,
    ...(overrides.withMessageId === false
      ? []
      : [`Message-ID: ${overrides.messageId ?? `<maker-po-${ORDER_CODE}@mail.kanei.example>`}`]),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `発注コード ${ORDER_CODE} の製造先発注書を添付します。`,
    '',
    `--${boundary}`,
    'Content-Type: application/pdf; name="maker-po.pdf"',
    'Content-Disposition: attachment; filename="maker-po.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(attachment, 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  return Buffer.from([...headers, '', body].join('\r\n'), 'utf8');
}

function evaluateEml(bytes: Buffer, overrides: {
  sentAt?: Date;
  ceoApprovedAt?: Date | null;
  now?: Date;
  recipient?: string;
  sender?: string;
  subjectIdentifiers?: string[];
  artworkHashes?: string[];
} = {}) {
  return evaluateMakerPoEmlEvidence({
    bytes,
    sentAt: overrides.sentAt ?? new Date('2026-11-16T00:00:00.000Z'),
    ceoApprovedAt: overrides.ceoApprovedAt ?? new Date('2026-11-15T23:00:00.000Z'),
    now: overrides.now ?? new Date('2026-11-16T00:01:00.000Z'),
    expectedRecipientAddress: overrides.recipient ?? RECIPIENT,
    recordedSenderAddress: overrides.sender ?? SENDER,
    subjectIdentifiers: overrides.subjectIdentifiers ?? [ORDER_CODE],
    artworkFileSha256s: overrides.artworkHashes ?? [ARTWORK_HASH]
  });
}

describe('M8-HARDEN C1: the send evidence is verified as an email', () => {
  it('parses the headers, the encoded subject and the attachment hash of a Thunderbird export', () => {
    const parsed = parseEml(buildEml({ cc: 'archive@kanei.example' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.eml.from?.address).toBe(SENDER);
    expect(parsed.eml.to.map((address) => address.address)).toEqual([RECIPIENT]);
    expect(parsed.eml.cc.map((address) => address.address)).toEqual(['archive@kanei.example']);
    expect(parsed.eml.date?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(parsed.eml.attachments).toHaveLength(1);
    expect(parsed.eml.attachments[0]?.sha256).toBe(ARTWORK_HASH);
    expect(parsed.eml.subject).toContain(ORDER_CODE);
  });

  it('verifies an export that names the maker, the order and carries the approved artwork', () => {
    const result = evaluateEml(buildEml());
    expect(result.verificationStatus).toBe('VERIFIED');
    expect(result.verificationMethod).toBe(MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK);
    expect(result.matchedAttachmentHashes).toEqual([ARTWORK_HASH]);
    expect(result.recipients).toEqual([RECIPIENT]);
    const byKey = new Map(result.checks.map((check) => [check.key, check.status]));
    expect(byKey.get('eml_parse')).toBe('passed');
    expect(byKey.get('message_id')).toBe('passed');
    expect(byKey.get('from_header')).toBe('passed');
    expect(byKey.get('recipient_address')).toBe('passed');
    expect(byKey.get('date_header')).toBe('passed');
    expect(byKey.get('date_sent_at_consistency')).toBe('passed');
    expect(byKey.get('subject_identifier')).toBe('passed');
    expect(byKey.get('attachment_hash')).toBe('passed');
    expect(byKey.get('sent_at_plausibility')).toBe('passed');
  });

  it('records a strong attachment match even when the subject carries the seven PO number instead', () => {
    const result = evaluateEml(buildEml({ subject: `製造先発注書 SEVEN-HARDEN-0001` }), {
      subjectIdentifiers: [ORDER_CODE, 'SEVEN-HARDEN-0001']
    });
    expect(result.verificationStatus).toBe('VERIFIED');
  });

  it('downgrades every broken export to PENDING_MANUAL_VERIFICATION and says which check failed', () => {
    const cases: Array<{ name: string; bytes: Buffer; overrides?: Parameters<typeof evaluateEml>[1]; code: string }> = [
      {
        name: 'no Message-ID',
        bytes: buildEml({ withMessageId: false }),
        code: 'EML_MESSAGE_ID_MISSING'
      },
      {
        name: 'a malformed Message-ID',
        bytes: buildEml({ messageId: '<has spaces@mail.example>' }),
        code: 'EML_MESSAGE_ID_INVALID'
      },
      {
        name: 'a recipient the paper does not name',
        bytes: buildEml({ to: 'someone-else@example.com' }),
        code: 'EML_RECIPIENT_MISMATCH'
      },
      {
        name: 'a From that contradicts the recorded sender',
        bytes: buildEml({ from: 'someone@kanei.example' }),
        code: 'EML_SENDER_MISMATCH'
      },
      {
        name: 'no From header at all',
        bytes: Buffer.from(buildEml().toString('utf8').replace(/^From: .*\r\n/m, ''), 'utf8'),
        code: 'EML_FROM_HEADER_MISSING'
      },
      {
        name: 'a subject that names another order',
        bytes: buildEml({ subject: '製造先発注書 FSO-OTHER-9999' }),
        code: 'EML_SUBJECT_IDENTIFIER_MISSING'
      },
      {
        name: 'a Date that contradicts the recorded sentAt',
        bytes: buildEml({ dateIso: '2026-11-16T00:00:00.000Z' }),
        overrides: { sentAt: new Date('2026-11-17T12:00:00.000Z') },
        code: 'EML_DATE_SENT_AT_CONFLICT'
      },
      {
        name: 'a send recorded before its own approval',
        bytes: buildEml(),
        overrides: { ceoApprovedAt: new Date('2026-11-16T06:00:00.000Z') },
        code: 'SENT_AT_PRECEDES_CEO_APPROVAL'
      },
      {
        name: 'a PDF instead of an EML',
        bytes: Buffer.from('%PDF-1.7\n% not an email\n', 'utf8'),
        code: 'EML_UNPARSABLE'
      },
      {
        name: 'a plain note',
        bytes: Buffer.from('このファイルには送信事実が一切含まれていません。\n', 'utf8'),
        code: 'EML_UNPARSABLE'
      }
    ];
    for (const { name, bytes, overrides, code } of cases) {
      const result = evaluateEml(bytes, overrides);
      if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
        throw new Error(`${name}: the broken export must stay pending, not ${result.verificationStatus}`);
      }
      expect(result.pendingCode, name).toBe(code);
      expect(result.reasonNote.length, name).toBeGreaterThan(0);
      expect(result.checks.some((check) => check.status === 'failed'), name).toBe(true);
    }
  });

  it('M8-HARDEN2 FIX 1: a wrong attachment keeps a header-clean mail pending, with the mismatch reason', () => {
    const result = evaluateEml(buildEml({ attachmentBytes: 'other bytes entirely\n' }));
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error(`an unapproved attachment must stay pending, not ${result.verificationStatus}`);
    }
    // A re-exported PDF of the approved PO is exactly this case: real-looking
    // mail, correct headers, and bytes nobody approved.
    expect(result.pendingCode).toBe('attachment_hash_mismatch');
    expect(result.reasonNote).toContain('ハッシュ');
    expect(result.matchedAttachmentHashes).toEqual([]);
    const byKey = new Map(result.checks.map((check) => [check.key, check.status]));
    expect(byKey.get('attachment_hash')).toBe('not_matched');
    expect(byKey.get('attachment_gate')).toBe('failed');
    // Every core check passed: the attachment is the only reason.
    expect(byKey.get('message_id')).toBe('passed');
    expect(byKey.get('recipient_address')).toBe('passed');
    expect(result.checks.filter((check) => check.status === 'failed')).toHaveLength(1);
  });

  it('M8-HARDEN2 FIX 1: a mail with no attachment at all stays pending as attachment_missing', () => {
    const noAttachment = Buffer.from(
      [
        `From: KANEI 担当 <${SENDER}>`,
        `To: Maker Inc. <${RECIPIENT}>`,
        `Subject: 製造先発注書 ${ORDER_CODE}`,
        'Date: Tue, 16 Nov 2026 00:00:00 +0000',
        `Message-ID: <maker-po-${ORDER_CODE}@mail.kanei.example>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        `発注コード ${ORDER_CODE} の製造先発注書を送付します。`
      ].join('\r\n'),
      'utf8'
    );
    const result = evaluateEml(noAttachment);
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error(`a mail without any attachment must stay pending, not ${result.verificationStatus}`);
    }
    expect(result.pendingCode).toBe('attachment_missing');
    expect(result.attachmentHashes).toEqual([]);
  });

  it('M8-HARDEN2 FIX 1: a mail that only points at a download link says so', () => {
    const linked = Buffer.from(
      [
        `From: KANEI 担当 <${SENDER}>`,
        `To: Maker Inc. <${RECIPIENT}>`,
        `Subject: 製造先発注書 ${ORDER_CODE}`,
        'Date: Tue, 16 Nov 2026 00:00:00 +0000',
        `Message-ID: <maker-po-${ORDER_CODE}@mail.kanei.example>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        '発注書はこちらからダウンロードしてください: https://files.example.com/d/abc123 。',
        '期日までに入手できない場合はご連絡ください。'
      ].join('\r\n'),
      'utf8'
    );
    const result = evaluateEml(linked);
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error(`a link-only mail must stay pending, not ${result.verificationStatus}`);
    }
    expect(result.pendingCode).toBe('attachment_link_only');
    expect(result.reasonNote).toContain('ダウンロード');
  });

  it('M8-HARDEN2 FIX 1: the attachment reason surfaces only when the headers themselves are clean', () => {
    // A mail that both lacks a Message-ID and carries nothing: the header is
    // the reason a reviewer reads first, and the gate stays recorded beside it.
    const result = evaluateEml(Buffer.from(
      [
        `From: KANEI 担当 <${SENDER}>`,
        `To: Maker Inc. <${RECIPIENT}>`,
        `Subject: 製造先発注書 ${ORDER_CODE}`,
        'Date: Tue, 16 Nov 2026 00:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        '本文のみ。'
      ].join('\r\n'),
      'utf8'
    ));
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error(`a broken mail must stay pending, not ${result.verificationStatus}`);
    }
    expect(result.pendingCode).toBe('EML_MESSAGE_ID_MISSING');
    const byKey = new Map(result.checks.map((check) => [check.key, check.status]));
    expect(byKey.get('message_id')).toBe('failed');
    expect(byKey.get('attachment_gate')).toBe('failed');
  });

  it('M8-HARDEN2 FIX 1: an approved attachment is what verifies, and no approved hash means no verify', () => {
    // The strong case: the attached bytes ARE the approved artifact.
    const verified = evaluateEml(buildEml());
    expect(verified.verificationStatus).toBe('VERIFIED');
    expect(verified.matchedAttachmentHashes).toEqual([ARTWORK_HASH]);

    // The snapshot freezes nothing: nothing can match, so the human decides.
    const nothingApproved = evaluateEml(buildEml(), { artworkHashes: [] });
    if (nothingApproved.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error('a mail verified against nothing approved must stay pending');
    }
    expect(nothingApproved.pendingCode).toBe('attachment_hash_mismatch');
  });

  it('refuses to parse bytes that are not a message', () => {
    expect(parseEml(Buffer.alloc(0)).ok).toBe(false);
    expect(parseEml(Buffer.from('plain text\n', 'utf8')).ok).toBe(false);
    expect(isValidMessageId('<ok@mail.example>')).toBe(true);
    expect(isValidMessageId('ok@mail.example')).toBe(false);
    expect(isValidMessageId('<no-at-sign>')).toBe(false);
    expect(isValidMessageId('<two><@mail.example>')).toBe(false);
  });

  it('carries the verification through the send evaluation: VERIFIED, pending, or the legacy verdict', () => {
    const evidence = {
      documentId: 'document',
      versionId: 'v-eml',
      sha256: sha256('eml bytes'),
      documentType: 'send_evidence' as const,
      projectId: '11111111-1111-7111-8111-222222222222',
      filmSupplyOrderId: SNAPSHOT.order.id,
      designKey: null,
      verificationStatus: 'unverified',
      makerPurchaseOrderId: '11111111-1111-7111-8111-333333333333'
    };
    const context = {
      order: { id: SNAPSHOT.order.id, projectId: evidence.projectId },
      approvedSnapshotSha256: computeMakerPoSnapshotSha256(SNAPSHOT),
      currentSnapshotSha256: computeMakerPoSnapshotSha256(SNAPSHOT),
      snapshot: SNAPSHOT,
      evidenceDocument: evidence,
      ceoApprovedAt: new Date('2026-11-15T23:00:00.000Z'),
      now: new Date('2026-11-16T00:01:00.000Z')
    };
    const request = {
      evidenceDocumentVersionId: 'v-eml',
      senderAddress: SENDER,
      recipients: [RECIPIENT],
      sentAt: new Date('2026-11-16T00:00:00.000Z'),
      attachmentHashes: null
    };

    const verified = evaluateMakerPoSendEvidence({ ...request, emlBytes: buildEml() }, context);
    expect(verified.ok).toBe(true);
    if (verified.ok && verified.verificationStatus === 'VERIFIED') {
      expect(verified.verification.verificationMethod).toBe(MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK);
      expect(verified.verification.emlMessageId).toContain('@');
      expect(verified.attachmentHashes).toContain(ARTWORK_HASH);
    } else {
      throw new Error('a genuine export must verify');
    }

    const pending = evaluateMakerPoSendEvidence(
      { ...request, emlBytes: buildEml({ withMessageId: false }) },
      context
    );
    expect(pending.ok).toBe(true);
    if (pending.ok && pending.verificationStatus === 'PENDING_MANUAL_VERIFICATION') {
      expect(pending.pendingCode).toBe('EML_MESSAGE_ID_MISSING');
      expect(pending.verification.verificationChecks?.some((check) => check.status === 'failed')).toBe(true);
    } else {
      throw new Error('an export without a Message-ID must stay pending');
    }

    // Without bytes the evaluation cannot verify content at all: that is the
    // pre-C1 verdict, which no API path reaches (the endpoints always supply
    // the stored bytes or the payload).
    const withoutBytes = evaluateMakerPoSendEvidence(request, context);
    expect(withoutBytes.ok).toBe(true);
    if (withoutBytes.ok && withoutBytes.verificationStatus === 'VERIFIED') {
      expect(withoutBytes.verification.verificationMethod).toBeNull();
    }
  });
});

describe('M8-HARDEN C2: the recorded send time must be possible', () => {
  it('accepts a sentAt inside the tolerance and refuses one further ahead of the server clock', () => {
    const now = new Date('2026-11-16T00:00:00.000Z');
    expect(evaluateMakerPoSentAtCurrency({ sentAt: new Date(now.getTime() - 1000), now }).ok).toBe(true);
    expect(evaluateMakerPoSentAtCurrency({
      sentAt: new Date(now.getTime() + MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS - 1000), now
    }).ok).toBe(true);
    const refused = evaluateMakerPoSentAtCurrency({
      sentAt: new Date(now.getTime() + MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS + 1000), now
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('SENT_AT_IN_FUTURE');
      expect(refused.serverNow).toBe(now.toISOString());
    }
    // The comparison is the UTC instant, so a timezone-shifted wall clock value
    // that is really future is caught the same way.
    const wallClock = new Date('2026-11-16T09:00:00.000Z');
    expect(evaluateMakerPoSentAtCurrency({ sentAt: wallClock, now }).ok).toBe(false);
  });

  it('downgrades a send recorded before its approval instead of hard-failing it', () => {
    const result = evaluateEml(buildEml(), {
      sentAt: new Date('2026-11-15T00:00:00.000Z'),
      ceoApprovedAt: new Date('2026-11-15T23:00:00.000Z')
    });
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error(`a pre-approval send must stay pending, not ${result.verificationStatus}`);
    }
    // Both time problems are real in this export: the Date header sits a day
    // after the recorded sentAt AND sentAt precedes the approval. The surfaced
    // pendingCode is the first failing check in evaluation order — the
    // date/consistency conflict — while the plausibility failure stays recorded
    // on the check list beside it.
    expect(result.pendingCode).toBe('EML_DATE_SENT_AT_CONFLICT');
    const byKey = new Map(result.checks.map((check) => [check.key, check.status]));
    expect(byKey.get('date_sent_at_consistency')).toBe('failed');
    expect(byKey.get('sent_at_plausibility')).toBe('failed');
  });
});

describe('M8-HARDEN B2: one active maker PO per order', () => {
  it('knows which statuses hold the order and which are the replacement exit', () => {
    expect(MAKER_PURCHASE_ORDER_STATUSES).toContain('CANCELLED');
    expect(isActiveMakerPurchaseOrderStatus('DRAFT')).toBe(true);
    expect(isActiveMakerPurchaseOrderStatus('MAKER_PO_SENT_MANUALLY')).toBe(true);
    expect(isActiveMakerPurchaseOrderStatus('CANCELLED')).toBe(false);
    expect(validateMakerPoStatus('CANCELLED').ok).toBe(true);
  });

  it('lets an operator cancel live paper and never lets a closed paper be cancelled', () => {
    expect(evaluateMakerPoCancellation('DRAFT').ok).toBe(true);
    expect(evaluateMakerPoCancellation('APPROVED_FOR_MANUAL_SEND').ok).toBe(true);
    expect(evaluateMakerPoCancellation('MAKER_PO_SENT_MANUALLY').ok).toBe(true);
    expect(evaluateMakerPoCancellation('SNAPSHOT_VOIDED').ok).toBe(true);
    const deadEnd = evaluateMakerPoCancellation('SEND_UNVERIFIED');
    expect(deadEnd.ok).toBe(false);
    if (!deadEnd.ok) expect(deadEnd.code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    const finished = evaluateMakerPoCancellation('MAKER_PO_ACCEPTED');
    expect(finished.ok).toBe(false);
    const cancelled = evaluateMakerPoCancellation('CANCELLED');
    expect(cancelled.ok).toBe(false);
    expect(transitionMakerPurchaseOrder('CANCELLED', 'APPROVED_FOR_MANUAL_SEND').ok).toBe(false);
    expect(makerPurchaseOrderTransitions('DRAFT')).toContain('CANCELLED');
    expect(makerPurchaseOrderTransitions('SEND_UNVERIFIED')).toEqual([]);
  });

  it('carries the cancellation as an append-only event type', () => {
    expect(MAKER_PO_EVENT_TYPES).toContain('MAKER_PO_CANCELLED');
    expect(validateMakerPoEventType('MAKER_PO_CANCELLED').ok).toBe(true);
  });
});

describe('M8-HARDEN B2 d: acceptance evidence is bound to one maker PO', () => {
  const poId = '11111111-1111-7111-8111-333333333333';
  const otherPoId = '11111111-1111-7111-8111-444444444444';
  const context = {
    order: { id: SNAPSHOT.order.id, projectId: '11111111-1111-7111-8111-222222222222' },
    makerPurchaseOrderId: poId,
    snapshotOrder: { id: SNAPSHOT.order.id }
  };
  const evidence = (overrides: Partial<{ makerPurchaseOrderId: string | null; projectId: string; order: string }> = {}) => ({
    documentId: 'document',
    versionId: 'v-accept',
    sha256: sha256('acceptance bytes'),
    documentType: 'acceptance_evidence' as const,
    projectId: overrides.projectId ?? context.order.projectId,
    filmSupplyOrderId: overrides.order ?? SNAPSHOT.order.id,
    designKey: null,
    verificationStatus: 'verified',
    makerPurchaseOrderId: overrides.makerPurchaseOrderId === undefined ? poId : overrides.makerPurchaseOrderId
  });
  const request = { evidenceDocumentVersionId: 'v-accept', attachmentHashes: null, acceptedAt: '2026-11-16T09:00:00.000Z' };

  it('accepts paperwork bound to exactly this paper', () => {
    const result = evaluateMakerPoAcceptEvidence(request, { ...context, evidenceDocument: evidence() });
    expect(result.ok).toBe(true);
  });

  it('refuses paperwork of another paper of the same order, and paperwork of no paper at all', () => {
    for (const makerPurchaseOrderId of [otherPoId, null]) {
      const result = evaluateMakerPoAcceptEvidence(request, {
        ...context,
        evidenceDocument: evidence({ makerPurchaseOrderId })
      });
      expect(result.ok).toBe(false);
      if (!result.ok && result.outcome === 'rejected') {
        expect(result.code).toBe('ACCEPT_EVIDENCE_PO_MISMATCH');
      } else {
        throw new Error(`binding to ${String(makerPurchaseOrderId)} must be refused`);
      }
    }
  });

  it('refuses a snapshot that describes another order', () => {
    const result = evaluateMakerPoAcceptEvidence(request, {
      ...context,
      snapshotOrder: { id: '11111111-1111-7111-8111-555555555555' },
      evidenceDocument: evidence()
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'rejected') expect(result.code).toBe('ACCEPT_EVIDENCE_PO_MISMATCH');
  });

  it('keeps the order and project refusals ahead of the binding refusal', () => {
    const foreignOrder = evaluateMakerPoAcceptEvidence(request, {
      ...context,
      evidenceDocument: evidence({ order: '11111111-1111-7111-8111-666666666666' })
    });
    expect(foreignOrder.ok).toBe(false);
    if (!foreignOrder.ok && foreignOrder.outcome === 'rejected') {
      expect(foreignOrder.code).toBe('ACCEPT_EVIDENCE_ORDER_MISMATCH');
    }
  });
});

describe('M8-HARDEN C1 vocabulary', () => {
  it('adds PENDING_MANUAL_VERIFICATION to the event verification statuses', () => {
    expect(MAKER_PO_EVENT_VERIFICATION_STATUSES).toContain('PENDING_MANUAL_VERIFICATION');
    expect(validateMakerPoVerificationStatus('PENDING_MANUAL_VERIFICATION').ok).toBe(true);
    expect(validateMakerPoVerificationStatus('VERIFIED').ok).toBe(true);
    expect(validateMakerPoVerificationStatus('verified').ok).toBe(false);
  });
});
