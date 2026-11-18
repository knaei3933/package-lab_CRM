import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
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
const PDF_MAX_STREAM_OUTPUT_BYTES_FOR_TEST = 8 * 1024 * 1024;

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

function withPageTree(objects: TestPdfObject[], pageId: number): TestPdfObject[] {
  return [
    ...objects,
    { id: 102, dict: `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>` },
    { id: 103, dict: '<< /Type /Catalog /Pages 102 0 R >>' }
  ];
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
    dict: '<< /Type /Page /Parent 102 0 R /Contents 3 0 R /Resources << /Font << /F1 100 0 R >> >> >>'
  });
  return buildPdf(withPageTree(objects, 101));
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
    dict: '<< /Type /Page /Parent 102 0 R /Contents 3 0 R /Resources << /Font << /F1 100 0 R >> >> >>'
  });
  return buildPdf(withPageTree(objects, 101));
}

function structuredTextPdf(input: {
  content?: Buffer;
  contentDict?: string;
  pageDict?: string;
  pagesDict?: string;
  catalogDict?: string;
  extraObjects?: TestPdfObject[];
} = {}): Buffer {
  const content = input.content ?? Buffer.from(`BT /F1 12 Tf (${ORDER_CODE}) Tj ET`, 'utf8');
  const compressed = deflateSync(content);
  const objects = textPageObjects({
    contentsId: 3,
    contents: compressed,
    contentsDict: input.contentDict ?? `<< /Filter /FlateDecode /Length ${compressed.length} >>`
  });
  objects.push({
    id: 101,
    dict: input.pageDict
      ?? '<< /Type /Page /Parent 102 0 R /Contents 3 0 R /Resources << /Font << /F1 100 0 R >> >> >>'
  });
  objects.push({
    id: 102,
    dict: input.pagesDict ?? '<< /Type /Pages /Kids [101 0 R] /Count 1 >>'
  });
  objects.push({
    id: 103,
    dict: input.catalogDict ?? '<< /Type /Catalog /Pages 102 0 R >>'
  });
  objects.push(...(input.extraObjects ?? []));
  return buildPdf(objects);
}

function appendPdfObjects(pdf: Buffer, objects: TestPdfObject[]): Buffer {
  return Buffer.concat([pdf, buildPdf(objects)]);
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
      dict: `<< /Type /Page /Parent 102 0 R /Contents ${10 + index} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`
    });
  });
  const kids = pages.map((_text, index) => `${20 + index} 0 R`).join(' ');
  objects.push({ id: 102, dict: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` });
  objects.push({ id: 103, dict: '<< /Type /Catalog /Pages 102 0 R >>' });
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
      dict: '<< /Type /Page /Parent 102 0 R /Contents 2 0 R /Resources << /XObject << /Im0 1 0 R >> >> >>'
    }
  ];
  if (input.hiddenText) {
    const hidden = Buffer.from(`BT (${input.hiddenText}) Tj ET`, 'latin1');
    objects.push({ id: 3, dict: `<< /Length ${hidden.length} >>`, stream: hidden });
  }
  return buildPdf(withPageTree(objects, 101));
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

  it('P3f keeps transparent image-page text pending as opaque', () => {
    const pdf = scanPdf({ transparentText: true });
    expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    expect(evaluate(pdf)).toMatchObject({
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE',
      pendingCodes: ['PDF_TEXT_LAYER_INDETERMINATE']
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

  describe('allow-list PDF hardening', () => {
    it('H1: rejects ObjStm and indirect /Type instead of parsing their objects', () => {
      const withObjStm = appendPdfObjects(pdfWithText(ORDER_CODE), [
        { id: 900, dict: '<< /Type /ObjStm /Length 4 >>', stream: Buffer.from('test', 'latin1') }
      ]);
      expect(inspectPdfTextLayers(withObjStm)).toMatchObject([{ state: 'indeterminate', text: '' }]);
      expect(evaluate(withObjStm)).toMatchObject({
        verificationStatus: 'PENDING_MANUAL_VERIFICATION',
        pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE'
      });

      const indirectCatalogType = structuredTextPdf({
        catalogDict: '<< /Type 104 0 R /Pages 102 0 R >>',
        extraObjects: [{ id: 104, dict: '<< /Type /Catalog >>' }]
      });
      expect(inspectPdfTextLayers(indirectCatalogType)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    });

    it('H2: rejects #xx-obfuscated /Type names', () => {
      const pdf = appendPdfObjects(pdfWithText(ORDER_CODE), [
        { id: 901, dict: '<< /Type /#50age >>' }
      ]);
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
      expect(evaluate(pdf)).toMatchObject({
        verificationStatus: 'PENDING_MANUAL_VERIFICATION',
        pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE'
      });
    });

    it('H3: ignores an unlinked decoy page while following Catalog→Pages→Kids', () => {
      const decoyContent = Buffer.from('BT /F1 12 Tf (WRONG-0000) Tj ET', 'utf8');
      const pdf = appendPdfObjects(pdfWithText(ORDER_CODE), [
        { id: 902, dict: `<< /Type /Page /Contents 903 0 R >>` },
        { id: 903, dict: `<< /Length ${decoyContent.length} >>`, stream: decoyContent }
      ]);
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'text', text: ORDER_CODE }]);
      expect(evaluate(pdf)).toMatchObject({ verificationStatus: 'VERIFIED' });
    });

    it('H3: fails closed on a cyclic Pages/Kids tree', () => {
      const pdf = structuredTextPdf({
        pagesDict: '<< /Type /Pages /Kids [102 0 R] /Count 1 >>'
      });
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    });

    it('H4b: rejects an inline image (BI…EI) even when matching text is present', () => {
      const pdf = structuredTextPdf({
        content: Buffer.from(
          `BT /F1 12 Tf (${ORDER_CODE}) Tj ET BI /W 3 /H 3 EI ET`,
          'latin1'
        )
      });
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    });

    it('H5: strips comments before parsing, so commented code cannot rescue wrong text', () => {
      const pdf = structuredTextPdf({
        content: Buffer.from(
          `BT /F1 12 Tf (WRONG-987654) Tj ET % (${ORDER_CODE}) Tj ET`,
          'latin1'
        )
      });
      const result = evaluate(pdf);
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'text', text: 'WRONG-987654' }]);
      expect(result).toMatchObject({
        verificationStatus: 'PENDING_MANUAL_VERIFICATION',
        pendingCode: 'EVIDENCE_CODE_MISMATCH'
      });
    });

    it('H6: rejects transparent text, zero font size and white color operators', () => {
      const contents = [
        `BT /F1 12 Tf 7 Tr (${ORDER_CODE}) Tj ET`,
        `BT /F1 0 Tf (${ORDER_CODE}) Tj ET`,
        `BT 1 g /F1 12 Tf (${ORDER_CODE}) Tj ET`,
        `BT 1 1 1 rg /F1 12 Tf (${ORDER_CODE}) Tj ET`,
        `BT 0 0 0 0 k /F1 12 Tf (${ORDER_CODE}) Tj ET`
      ];
      for (const content of contents) {
        const pdf = structuredTextPdf({ content: Buffer.from(content, 'latin1') });
        expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
        expect(evaluate(pdf)).toMatchObject({
          verificationStatus: 'PENDING_MANUAL_VERIFICATION',
          pendingCode: 'PDF_TEXT_LAYER_INDETERMINATE'
        });
      }
    });

    it("H9: normalizes '03 Tr' as integer 3 and rejects it", () => {
      const pdf = structuredTextPdf({
        content: Buffer.from(`BT /F1 12 Tf 03 Tr (${ORDER_CODE}) Tj ET`, 'latin1')
      });
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
    });

    it('stops a compressed stream above 8MB before a large expansion, in under one second', () => {
      const bomb = deflateSync(Buffer.alloc(PDF_MAX_STREAM_OUTPUT_BYTES_FOR_TEST + 1));
      const pdf = structuredTextPdf({
        content: bomb,
        contentDict: `<< /Filter /FlateDecode /Length ${bomb.length} >>`
      });
      const started = performance.now();
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('bounds /Contents references and decodes a repeated stream only once', () => {
      const reference = '3 0 R';
      const references = Array.from({ length: 21 }, () => reference).join(' ');
      const pdf = structuredTextPdf({
        pageDict: `<< /Type /Page /Parent 102 0 R /Contents [${references}] /Resources << /Font << /F1 100 0 R >> >> >>`
      });
      const started = performance.now();
      expect(inspectPdfTextLayers(pdf)).toMatchObject([{ state: 'indeterminate', text: '' }]);
      expect(performance.now() - started).toBeLessThan(1000);
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
