import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { evaluateApprovalEvidenceIdentifierForBytes, normalizeMessageId, parseEml } from '@kanei/core';

// SYNTHETIC fixtures only: example.test hosts, invented ids, a 1x1 PNG built here.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const PARENT_ID = '<parent-0001@Mail.Example.test>';
const OWN_ID = '<reply-0002@Mail.Example.test>';

function replyWithInlinePng(): Buffer {
  const lines = [
    'From: Sender Example <sender@example.test>',
    'To: Receiver Example <receiver@example.test>',
    'Subject: Re: sample proof',
    'Date: Tue, 17 Nov 2026 09:00:00 +0900',
    `Message-ID: ${OWN_ID}`,
    `In-Reply-To: ${PARENT_ID}`,
    `References: <root-0000@mail.example.test> ${PARENT_ID}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'OK. Approved.',
    `> quoted earlier mail, Message-ID: ${PARENT_ID}`,
    '--REL',
    'Content-Type: image/png; name="image001.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <img001@example.test>',
    'Content-Disposition: inline',
    '',
    PNG.toString('base64'),
    '--REL--',
    ''
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

describe('evidence identifier: real EML shapes (G1 G2 G4)', () => {
  it('G1: message/rfc822 evidence with the mail\'s own Message-ID is verified, not pending', () => {
    const result = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: OWN_ID,
      bytes: replyWithInlinePng(),
      contentType: 'message/rfc822'
    });
    expect(result).toMatchObject({ ok: true, status: 'verified_in_document' });
  });

  it('G1: an unparsable message/rfc822 payload stays pending manual verification', () => {
    const result = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: OWN_ID,
      bytes: Buffer.from([0, 1, 2, 3]),
      contentType: 'message/rfc822'
    });
    expect(result).toMatchObject({ ok: true, status: 'pending_manual_verification' });
  });

  it('G2: normalizes angle brackets and the domain case only', () => {
    const result = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: 'reply-0002@mail.EXAMPLE.test',
      bytes: replyWithInlinePng(),
      contentType: 'message/rfc822; charset=utf-8'
    });
    expect(result).toMatchObject({ ok: true, status: 'verified_in_document' });
    expect(normalizeMessageId('<A@B.Test>')).toBe('A@b.test');
    // the local part keeps its case
    const wrongCase = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: '<REPLY-0002@mail.example.test>',
      bytes: replyWithInlinePng(),
      contentType: 'message/rfc822'
    });
    expect(wrongCase.ok).toBe(false);
  });

  it('G2: refuses the parent id found in quoted text, In-Reply-To and References', () => {
    for (const identifier of [PARENT_ID, '<root-0000@mail.example.test>']) {
      const result = evaluateApprovalEvidenceIdentifierForBytes({
        identifier,
        bytes: replyWithInlinePng(),
        contentType: 'message/rfc822'
      });
      expect(result).toMatchObject({ ok: false, code: 'EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT' });
    }
  });

  it('G2: a partial id (substring of the own Message-ID) is refused', () => {
    const result = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: 'reply-0002',
      bytes: replyWithInlinePng(),
      contentType: 'message/rfc822'
    });
    expect(result.ok).toBe(false);
  });

  it('G4: the inline PNG in multipart/related is an attachment with its sha256', () => {
    const parsed = parseEml(replyWithInlinePng());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.eml.attachments).toHaveLength(1);
    expect(parsed.eml.attachments[0]).toMatchObject({
      contentType: 'image/png',
      sha256: PNG_SHA,
      byteSize: PNG.length
    });
    expect(parsed.eml.bodyText).toContain('Approved');
  });

  it('G4: a Content-ID part outside multipart/related is also collected, text parts are not', () => {
    const raw = [
      'From: a@example.test',
      'Message-ID: <m1@example.test>',
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      '--MIX',
      'Content-Type: text/html; charset=UTF-8',
      'Content-ID: <html@example.test>',
      '',
      '<p>hi</p>',
      '--MIX',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <i@example.test>',
      '',
      PNG.toString('base64'),
      '--MIX--',
      ''
    ].join('\r\n');
    const parsed = parseEml(Buffer.from(raw, 'utf8'));
    expect(parsed.ok && parsed.eml.attachments.map((a) => a.sha256)).toEqual([PNG_SHA]);
  });
});
