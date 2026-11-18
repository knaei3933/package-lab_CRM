import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';
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

interface TestPdfObject {
  id: number;
  dict: string;
  stream?: Buffer | undefined;
}

function buildPdf(objects: TestPdfObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  for (const object of objects) {
    chunks.push(Buffer.from(`${object.id} 0 obj ${object.dict}`, 'latin1'));
    if (object.stream !== undefined) {
      chunks.push(
        Buffer.from(`\nstream\n`, 'latin1'),
        object.stream,
        Buffer.from(`\nendstream\n`, 'latin1')
      );
    }
    chunks.push(Buffer.from('endobj\n', 'latin1'));
  }
  chunks.push(Buffer.from('%%EOF\n', 'latin1'));
  return Buffer.concat(chunks);
}

function textPageObjects(input: {
  contentsId: number;
  contents: Buffer;
  contentsDict?: string;
  fontObjectId?: number;
  firstPageId?: number;
}): TestPdfObject[] {
  const fontObjectId = input.fontObjectId ?? 100;
  const firstPageId = input.firstPageId ?? 101;
  return [
    {
      id: 1,
      dict: '<< /Length 6 >>',
      stream: Buffer.from([0x00, 0x01, 0xca, 0xfe, 0x00, 0x10])
    },
    {
      id: 2,
      dict: '<< /Length 58 >>',
      stream: Buffer.from('/CIDSystemInfo << /Registry (Adobe) >>\nbeginbfchar\nendbfchar\n', 'latin1')
    },
    {
      id: input.contentsId,
      dict: input.contentsDict ?? `<< /Length ${input.contents.length} >>`,
      stream: input.contents
    },
    {
      id: fontObjectId,
      dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontFile2 1 0 R /ToUnicode 2 0 R >>'
    }
  ];
}

function zlibTextPdf(text: string): Buffer {
  const contents = Buffer.from(`BT /F1 12 Tf (${text}) Tj ET`, 'utf8');
  const compressed = deflateSync(contents);
  const objects = textPageObjects({
    contentsId: 3,
    contents: compressed,
    contentsDict: `<< /Filter /FlateDecode /Length ${compressed.length} >>`
  });
  objects.push({
    id: 101,
    dict: '<< /Type /Page /Contents 3 0 R /Resources << /Font << /F1 100 0 R >> >> >>'
  });
  return buildPdf(objects);
}

function pdfWithText(text: string): Buffer {
  return zlibTextPdf(text);
}

function rawFlateFallbackPdf(text: string): Buffer {
  const contents = Buffer.from(`BT /F1 12 Tf (${text}) Tj ET`, 'utf8');
  const compressed = deflateRawSync(contents);
  const objects = textPageObjects({
    contentsId: 3,
    contents: compressed,
    contentsDict: `<< /Filter /FlateDecode /Length ${compressed.length} >>`
  });
  objects.push({
    id: 101,
    dict: '<< /Type /Page /Contents 3 0 R /Resources << /Font << /F1 100 0 R >> >> >>'
  });
  return buildPdf(objects);
}

function multiPagePdf(pages: string[]): Buffer {
  const objects: TestPdfObject[] = [
    {
      id: 1,
      dict: '<< /Length 6 >>',
      stream: Buffer.from([0x00, 0x01, 0xca, 0xfe, 0x00, 0x10])
    },
    {
      id: 2,
      dict: '<< /Length 58 >>',
      stream: Buffer.from('/CIDSystemInfo << /Registry (Adobe) >>\nbeginbfchar\nendbfchar\n', 'latin1')
    },
    { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontFile2 1 0 R /ToUnicode 2 0 R >>' }
  ];
  pages.forEach((text, index) => {
    const contents = Buffer.from(`BT /F1 12 Tf (${text}) Tj ET`, 'utf8');
    objects.push({
      id: 10 + index,
      dict: `<< /Length ${contents.length} >>`,
      stream: contents
    });
    objects.push({
      id: 20 + index,
      dict: `<< /Type /Page /Contents ${10 + index} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`
    });
  });
  return buildPdf(objects);
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

function flatePdfWithFontAndCMap(): Buffer {
  return zlibTextPdf(`発注コード ${ORDER_CODE}`);
}

function scanPdf(input: {
  hiddenText?: string;
  transparentText?: boolean;
  visibleText?: boolean;
} = {}): Buffer {
  const contentText = input.transparentText
    ? `/Im0 Do BT 3 Tr (${ORDER_CODE}) Tj ET`
    : input.visibleText
      ? `/Im0 Do BT (${ORDER_CODE}) Tj ET`
    : '/Im0 Do ET';
  const contents = Buffer.from(`BT ${contentText} ET`, 'latin1');
  const objects: TestPdfObject[] = [
    {
      id: 1,
      dict: '<< /Subtype /Image /Filter /DCTDecode /Length 4 >>',
      stream: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    },
    { id: 2, dict: `<< /Length ${contents.length} >>`, stream: contents },
    {
      id: 101,
      dict: '<< /Type /Page /Contents 2 0 R /Resources << /XObject << /Im0 1 0 R >> >> >>'
    }
  ];
  if (input.hiddenText) {
    const hidden = Buffer.from(`BT (${input.hiddenText}) Tj ET`, 'latin1');
    objects.push({ id: 3, dict: `<< /Length ${hidden.length} >>`, stream: hidden });
  }
  return buildPdf(objects);
}

function imageOnlyScanPdf(): Buffer {
  return scanPdf();
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

  it('M9 mutation: order-code comparison normalizes case but keeps code-character boundaries', () => {
    expect(hasNormalizedToken('fso-1', 'FSO-1')).toBe(true);
    expect(hasNormalizedToken('FSO-1_2', 'FSO-1')).toBe(false);
    expect(hasNormalizedToken('FSO-1.5', 'FSO-1')).toBe(false);
    expect(hasNormalizedToken('FSO-1-2', 'FSO-1')).toBe(false);
    expect(hasNormalizedToken('(FSO-1)', 'FSO-1')).toBe(true);
    expect(hasNormalizedToken('FSO-1.', 'FSO-1')).toBe(false);
    expect(hasNormalizedToken('FSO-1。', 'FSO-1')).toBe(false);
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

  it('G7 extracts a zlib-wrapped PDF text layer for the cross-check', () => {
    expect(extractPdfText(pdfWithText(`発注コード ${ORDER_CODE}`))).toContain(ORDER_CODE);
  });

  it('G5 accepts standard zlib Flate content and keeps raw DEFLATE as fallback-only', () => {
    const zlibPdf = zlibTextPdf(`発注コード ${ORDER_CODE}`);
    expect(inspectPdfTextLayers(zlibPdf)).toMatchObject([{ state: 'text' }]);
    expect(evaluate(zlibPdf)).toMatchObject({ verificationStatus: 'VERIFIED' });

    const rawPdf = rawFlateFallbackPdf(`発注コード ${ORDER_CODE}`);
    expect(inspectPdfTextLayers(rawPdf)).toMatchObject([{ state: 'text' }]);
    expect(evaluate(rawPdf)).toMatchObject({ verificationStatus: 'VERIFIED' });
  });

  it('G5 ignores FontFile and ToUnicode auxiliary streams when a text page exists', () => {
    const pdf = flatePdfWithFontAndCMap();
    const layers = inspectPdfTextLayers(pdf);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ state: 'text' });
    expect(layers[0]?.text).toContain(ORDER_CODE);
    expect(evaluate(pdf)).toMatchObject({ verificationStatus: 'VERIFIED' });
  });

  it('G5 keeps an image XObject page pending as a true scan', () => {
    const result = evaluate(imageOnlyScanPdf());
    expect(inspectPdfTextLayers(imageOnlyScanPdf())).toMatchObject([
      { state: 'scan', text: '' }
    ]);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'SCAN_PDF_MANUAL_VERIFICATION_REQUIRED',
      pendingCodes: ['SCAN_PDF_MANUAL_VERIFICATION_REQUIRED']
    });
  });

  it('P3c/P3f ignores an unreferenced hidden text stream beside an image scan', () => {
    const pdf = scanPdf({ hiddenText: ORDER_CODE });
    expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'scan', text: '' }]);
    expect(evaluate(pdf)).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'SCAN_PDF_MANUAL_VERIFICATION_REQUIRED',
      pendingCodes: ['SCAN_PDF_MANUAL_VERIFICATION_REQUIRED']
    });
  });

  it('P3f sends transparent image-page text to a human as an OCR layer', () => {
    const pdf = scanPdf({ transparentText: true });
    expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'ocr' }]);
    expect(evaluate(pdf)).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_OCR_TEXT_REQUIRES_HUMAN',
      pendingCodes: ['PDF_OCR_TEXT_REQUIRES_HUMAN']
    });
  });

  it('P3f sends visible text over an image to a human as an OCR layer', () => {
    const pdf = scanPdf({ visibleText: true });
    expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'ocr' }]);
    expect(evaluate(pdf)).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_OCR_TEXT_REQUIRES_HUMAN',
      pendingCodes: ['PDF_OCR_TEXT_REQUIRES_HUMAN']
    });
  });

  it('treats an unparsable page structure as indeterminate rather than authenticated', () => {
    const pdf = buildPdf([{ id: 1, dict: '<< /Type /Page >>' }]);
    expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    expect(evaluate(pdf)).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE',
      pendingCodes: ['PDF_TEXT_LAYER_INDETERMINATE']
    });
  });

  it('G7 rejects FSO-1 when the PDF token is FSO-10 even though it is a substring', () => {
    const result = evaluate(pdfWithText('FSO-10'));
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EVIDENCE_CODE_MISMATCH'
    });
  });

  it('P4c boundary mutation: underscore and dot are not code constituents', () => {
    expect(evaluate(pdfWithText('FSO-1_2'), `${ORDER_CODE} 発注`))
      .toMatchObject({ verificationStatus: 'PENDING_MANUAL_VERIFICATION' });
    expect(evaluate(pdfWithText('FSO-1.5'), `${ORDER_CODE} 発注`))
      .toMatchObject({ verificationStatus: 'PENDING_MANUAL_VERIFICATION' });
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

  it('subject checking rejects ASCII and full-width terminal periods consistently', () => {
    expect(hasNormalizedToken(`${ORDER_CODE}.`, ORDER_CODE)).toBe(false);
    expect(hasNormalizedToken(`${ORDER_CODE}。`, ORDER_CODE)).toBe(false);
    const result = evaluate(pdfWithText(ORDER_CODE), `${ORDER_CODE}。発注`);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'EML_SUBJECT_IDENTIFIER_MISSING'
    });
    const checks = 'checks' in result ? result.checks : [];
    expect(checks.find((check) => check.key === 'subject_identifier')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('。')
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
    const result = evaluate(imageOnlyScanPdf());
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

  it('G5/P10 treats a referenced ASCIIHex Contents stream as indeterminate, never as a scan', () => {
    const hidden = '48 65 6c 6c 6f';
    const pdf = buildPdf([
      { id: 1, dict: `<< /Filter /ASCIIHexDecode /Length ${hidden.length} >>`, stream: Buffer.from(hidden, 'latin1') },
      { id: 2, dict: '<< /Type /Page /Contents 1 0 R >>' }
    ]);
    expect(inspectPdfTextLayers(pdf)[0]).toMatchObject({ state: 'indeterminate' });
    const result = evaluate(pdf);
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE'
    });
  });

  it('G7 blocks a multi-page PDF when any text page mismatches', () => {
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
    expect(result.pendingCodes).toEqual(['EVIDENCE_CODE_MISMATCH']);
    expect(result.checks.find((entry) => entry.key === 'code_consistency')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('page(s) 2')
    });
  });

  it('exposes every pending code when subject and scan both fail', () => {
    const scanned = imageOnlyScanPdf();
    const bytes = mailWithPdf(scanned);
    const scannedHash = createHash('sha256').update(scanned).digest('hex');
    const result = evaluateMakerPoEmlEvidence({
      bytes,
      sentAt: new Date('2026-11-17T09:00:00+09:00'),
      ceoApprovedAt: new Date('2026-11-16T09:00:00+09:00'),
      now: new Date('2026-11-17T09:10:00+09:00'),
      expectedRecipientAddress: 'maker-po@example.test',
      recordedSenderAddress: 'staff@kanei.example',
      subjectIdentifiers: ['OTHER-G7'],
      subjectCode: 'OTHER-G7',
      documentCode: ORDER_CODE,
      artworkFileSha256s: [scannedHash]
    });
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      throw new Error('a missing subject plus a scan must stay pending');
    }
    expect(result).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCodes: ['EML_SUBJECT_IDENTIFIER_MISSING', 'SCAN_PDF_MANUAL_VERIFICATION_REQUIRED']
    });
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
