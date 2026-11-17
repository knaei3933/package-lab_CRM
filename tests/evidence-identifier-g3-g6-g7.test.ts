import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateMakerPoEmlEvidence, extractPdfText, parseEml } from '@kanei/core';
import { makerPoMailSubject } from '../apps/web/src/lib/eml-form.js';

const ORDER_CODE = 'FSO-G7-0001';

function pdfWithText(text: string): Buffer {
  const content = `BT (${text}) Tj ET`;
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Length ' + content.length + ' >>',
      'stream',
      content,
      'endstream',
      'endobj',
      '%%EOF',
      ''
    ].join('\n'),
    'utf8'
  );
}

function mailWithPdf(pdf: Buffer, subject = `製造先発注書 ${ORDER_CODE}`): Buffer {
  const lines = [
    'From: KANEI Staff <staff@kanei.example>',
    'To: Maker Inc. <maker-po@example.test>',
    `Subject: ${subject}`,
    'Date: Tue, 17 Nov 2026 09:00:00 +0900',
    `Message-ID: <maker-po-${ORDER_CODE}@mail.kanei.example>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '発注書を添付します。',
    '--MIX',
    'Content-Type: application/pdf; name="maker-po.pdf"',
    'Content-Disposition: attachment; filename="maker-po.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--MIX--',
    ''
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function evaluate(pdf: Buffer, subject?: string) {
  return evaluateMakerPoEmlEvidence({
    bytes: mailWithPdf(pdf, subject),
    sentAt: new Date('2026-11-17T00:00:00.000Z'),
    ceoApprovedAt: new Date('2026-11-16T00:00:00.000Z'),
    now: new Date('2026-11-17T00:10:00.000Z'),
    expectedRecipientAddress: 'maker-po@example.test',
    recordedSenderAddress: 'staff@kanei.example',
    subjectIdentifiers: [ORDER_CODE, 'SEVEN-G7'],
    documentCode: ORDER_CODE,
    artworkFileSha256s: [createHash('sha256').update(pdf).digest('hex')]
  });
}

describe('evidence identifier decisions G3/G6/G7', () => {
  it('G3 puts the order code before the recorded mail subject template', () => {
    expect(makerPoMailSubject(ORDER_CODE)).toBe(`${ORDER_CODE} 製造先発注書`);
    expect(makerPoMailSubject(ORDER_CODE, '校正確認のお願い')).toBe(`${ORDER_CODE} 校正確認のお願い`);
    expect(makerPoMailSubject(ORDER_CODE, ` ${ORDER_CODE} already named`)).toBe(
      `${ORDER_CODE} already named`
    );
  });

  it('G6 reads the Message-ID from the stored mail itself, not quoted text', () => {
    const parsed = parseEml(mailWithPdf(pdfWithText(ORDER_CODE)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.eml.messageId).toBe(`<maker-po-${ORDER_CODE}@mail.kanei.example>`);
  });

  it('G7 extracts an uncompressed PDF text layer for the cross-check', () => {
    expect(extractPdfText(pdfWithText(`発注コード ${ORDER_CODE}`))).toContain(ORDER_CODE);
  });

  it('G7 verifies a text PDF whose printed code matches the mail subject', () => {
    const result = evaluate(pdfWithText(`発注コード ${ORDER_CODE}`));
    expect(result).toMatchObject({ verificationStatus: 'VERIFIED' });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')).toMatchObject({ status: 'passed' });
  });

  it('G7 blocks a text PDF whose printed number disagrees and names the mismatch', () => {
    const result = evaluate(pdfWithText('printed number 987654'));
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EVIDENCE_CODE_MISMATCH'
    });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')).toMatchObject({ status: 'failed' });
    if (result.verificationStatus === 'PENDING_MANUAL_VERIFICATION') {
      expect(result.reasonNote).toContain('コード不一致');
    }
  });

  it('G5 keeps an image-only scan on the existing manual path without a false mismatch', () => {
    const scanned = Buffer.from('%PDF-1.4\nsingle page JPEG with no text stream\n%%EOF\n', 'utf8');
    const result = evaluate(scanned);
    expect(result).toMatchObject({ verificationStatus: 'VERIFIED' });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')).toMatchObject({
      status: 'skipped',
      detail: 'scan'
    });
  });
});
