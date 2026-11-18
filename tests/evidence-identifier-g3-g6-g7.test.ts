import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateMakerPoEmlEvidence,
  extractPdfText,
  extractStoredEmlMessageId,
  hasNormalizedToken,
  inspectPdfTextLayers,
  parseEml
} from '@kanei/core';
import {
  insertMakerPoMailSubject,
  makerPoMailSubject,
  utf8TextToBase64
} from '../apps/web/src/lib/eml-form.js';

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

function multiPagePdf(pages: string[]): Buffer {
  const objects = pages.map((text, index) => {
    const content = `BT (${text}) Tj ET`;
    return [
      `${index + 1} 0 obj << /Length ${content.length} >>`,
      'stream',
      content,
      'endstream',
      'endobj'
    ].join('\n');
  });
  return Buffer.from(['%PDF-1.4', ...objects, '%%EOF', ''].join('\n'), 'utf8');
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
    sentAt: new Date('2026-11-17T09:00:00+09:00'),
    ceoApprovedAt: new Date('2026-11-16T09:00:00+09:00'),
    now: new Date('2026-11-17T09:10:00+09:00'),
    expectedRecipientAddress: 'maker-po@example.test',
    recordedSenderAddress: 'staff@kanei.example',
    subjectIdentifiers: [ORDER_CODE, 'SEVEN-G7'],
    documentCode: ORDER_CODE,
    artworkFileSha256s: [createHash('sha256').update(pdf).digest('hex')]
  });
}

describe('evidence identifier decisions G3/G6/G7', () => {
  it('G3 inserts the order code into the actual EML subject and uses token boundaries', () => {
    expect(makerPoMailSubject(ORDER_CODE)).toBe(`${ORDER_CODE} 製造先発注書`);
    expect(makerPoMailSubject(ORDER_CODE, '校正確認のお願い')).toBe(`${ORDER_CODE} 校正確認のお願い`);
    expect(makerPoMailSubject(ORDER_CODE, `${ORDER_CODE.toLowerCase()} already named`)).toBe(
      `${ORDER_CODE.toLowerCase()} already named`
    );
    expect(makerPoMailSubject('FSO-1', 'FSO-10 was another paper')).toBe('FSO-1 FSO-10 was another paper');

    const original = [
      'From: KANEI <staff@kanei.example>',
      'Subject: 校正確認',
      'Date: Tue, 17 Nov 2026 18:00:00 +0900',
      '',
      'body remains unchanged'
    ].join('\r\n');
    const edited = insertMakerPoMailSubject(original, ORDER_CODE);
    expect(edited.inserted).toBe(true);
    expect(Buffer.from(edited.eml, 'utf8').toString('base64')).toBe(utf8TextToBase64(edited.eml));
    expect(edited.eml).toContain(`Subject: ${ORDER_CODE} 校正確認`);
    expect(edited.eml).toContain('body remains unchanged');
  });

  it('M2 mutation: duplicate Message-ID headers are never auto-extracted', () => {
    const mail = Buffer.from(
      [
        'From: a@example.test',
        'Message-ID: <own-0001@example.test>',
        'Message-ID: <second-0002@example.test>',
        '',
        'body'
      ].join('\r\n'),
      'utf8'
    );
    expect(extractStoredEmlMessageId(mail)).toBeNull();
  });

  it('subject matching is normalized only at token boundaries', () => {
    expect(hasNormalizedToken('fso-1 の発注書', 'FSO-1')).toBe(true);
    expect(hasNormalizedToken('FSO-10 の発注書', 'FSO-1')).toBe(false);
    expect(hasNormalizedToken('XFSO-1 の発注書', 'FSO-1')).toBe(false);
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

  it('G7 rejects FSO-1 when the PDF token is FSO-10 even though it is a substring', () => {
    const result = evaluate(pdfWithText('FSO-10'));
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EVIDENCE_CODE_MISMATCH'
    });
  });

  it('G7 verifies a text PDF whose printed code matches the mail subject', () => {
    const result = evaluate(pdfWithText(`発注コード ${ORDER_CODE}`));
    expect(result).toMatchObject({ verificationStatus: 'VERIFIED' });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')).toMatchObject({ status: 'passed' });
  });

  it('G7 accepts lower-case snapshot and PDF codes after normalization', () => {
    const result = evaluate(pdfWithText(`発注コード ${ORDER_CODE.toLowerCase()}`), `${ORDER_CODE.toLowerCase()} 発注`);
    expect(result).toMatchObject({ verificationStatus: 'VERIFIED' });
  });

  it('subject checking refuses a longer order code that merely contains the token', () => {
    const result = evaluate(pdfWithText(ORDER_CODE), `${ORDER_CODE}0 発注`);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EML_SUBJECT_IDENTIFIER_MISSING'
    });
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

  it('G5 requires human verification for an image-only scan even when hashes match', () => {
    const scanned = Buffer.from('%PDF-1.4\nsingle page JPEG with no text stream\n%%EOF\n', 'utf8');
    const result = evaluate(scanned);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'SCAN_PDF_MANUAL_VERIFICATION_REQUIRED',
      pendingCodes: ['SCAN_PDF_MANUAL_VERIFICATION_REQUIRED']
    });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')).toMatchObject({
      status: 'skipped',
      detail: 'scan: human verification required'
    });
  });

  it('G5/P10 treats an ASCIIHex text stream as indeterminate, never as a scan', () => {
    const hidden = '48 65 6c 6c 6f';
    const pdf = Buffer.from(
      [
        '%PDF-1.4',
        '1 0 obj << /Filter /ASCIIHexDecode /Length ' + hidden.length + ' >>',
        'stream',
        hidden,
        'endstream',
        'endobj',
        '%%EOF',
        ''
      ].join('\n'),
      'utf8'
    );
    expect(inspectPdfTextLayers(pdf)[0]).toMatchObject({ state: 'indeterminate' });
    const result = evaluate(pdf);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE'
    });
  });

  it('G7 blocks a mixed multi-page PDF and exposes scan plus mismatch reasons', () => {
    const pdf = Buffer.concat([
      multiPagePdf([ORDER_CODE, 'WRONG-987654']).subarray(0, -7),
      Buffer.from(
        [
          '3 0 obj << /Subtype /Image /Length 4 >>',
          'stream',
          'JPEG',
          'endstream',
          'endobj',
          '%%EOF',
          ''
        ].join('\n'),
        'utf8'
      )
    ]);
    const result = evaluate(pdf);
    expect(result).toMatchObject({ verificationStatus: 'PENDING_MANUAL_VERIFICATION' });
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') return;
    expect(result.pendingCodes).toContain('EVIDENCE_CODE_MISMATCH');
    expect(result.checks.find((entry) => entry.key === 'pending_codes')).toMatchObject({
      status: 'failed',
      detail: result.pendingCodes.join(',')
    });
  });

  it('G7 compares both the snapshot code and the code matched in the subject', () => {
    const result = evaluate(pdfWithText('下位コード SEVEN-G7'), '下位コード SEVEN-G7');
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EVIDENCE_CODE_MISMATCH'
    });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'code_consistency')?.detail).toContain(ORDER_CODE);
    expect(checks.find((check) => check.key === 'code_consistency')?.detail).toContain('SEVEN-G7');
  });
});
