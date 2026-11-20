import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_DICTIONARY } from '../apps/web/src/lib/error-dictionary-data.js';
import { describeApiFailure, dictionaryEntry, isOperatorSafeText, unexpectedErrorText, webErrorText } from '../apps/web/src/lib/error-dictionary.js';

/**
 * P0 R09: every refusal code the server can send has operator wording; the
 * wording has no machine text; unknown codes and uncoded refusals are handled
 * by one rule (describeApiFailure).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(root, dir, name));
}

const serverCodes = [...new Set(
  [...sourceFiles('apps/api/src'), ...sourceFiles('packages/core/src')].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/code: ?'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]!)
  )
)].sort();

const ALLOWED_ASCII = new Set(['MB', 'PDF', 'EML', 'ID']);

/**
 * Exception lists for wording defects. Both are empty: the two defects found
 * during P0 (an ASCII e-mail example, a kanji inside Korean) were fixed, and
 * each now has its own regular test below. Keep them empty.
 */
const JA_ASCII_EXAMPLE = new Set<string>(); // fixed: RECIPIENT_ADDRESS_INVALID no longer carries an ASCII example
const KO_HAN_TYPO = new Set<string>(); // fixed: 확認 → 확인 in ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND
const withoutQuotedLabels = (ko: string) => ko.replace(/「[^」]*」/g, '');

function stray(text: string): string[] {
  return (text.match(/[A-Za-z]+/g) ?? []).filter((word) => !ALLOWED_ASCII.has(word));
}

describe('the dictionary covers every code the server source can return', () => {
  it('finds the server codes (guards the scan itself)', () => {
    expect(serverCodes.length).toBeGreaterThan(100);
    expect(serverCodes).toContain('PO_NUMBER_REQUIRED');
  });

  it.each(serverCodes)('%s has an entry', (code) => {
    expect(dictionaryEntry(code), `${code} is missing from error-dictionary-data.ts`).not.toBeNull();
  });

  it('the web-side codes have entries too', () => {
    for (const code of ['API_TIMEOUT', 'API_UNREACHABLE', 'SESSION_EXPIRED', 'PROJECT_CONTEXT_MISMATCH', 'DUPLICATE', 'UPLOAD_TOO_LARGE', 'INTERNAL_ERROR', 'ROLE_FORBIDDEN', 'DB_UNAVAILABLE']) {
      expect(dictionaryEntry(code), code).not.toBeNull();
    }
  });
});

describe('every entry is operator wording', () => {
  const entries = Object.entries(ERROR_DICTIONARY);

  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  const japanese = entries.filter(([code]) => !JA_ASCII_EXAMPLE.has(code)).map(([code, entry]) => [code, entry.ja] as const);

  it.each(japanese)('%s: the Japanese text passes isOperatorSafeText', (_code, ja) => {
    expect(isOperatorSafeText(ja)).toBe(true);
  });

  it.each(japanese)('%s: the Japanese text has no ASCII letters besides MB/PDF/EML/ID', (_code, ja) => {
    expect(stray(ja)).toEqual([]);
  });

  it('RECIPIENT_ADDRESS_INVALID: no ASCII e-mail example in the Japanese text (was a known defect)', () => {
    expect(stray(ERROR_DICTIONARY.RECIPIENT_ADDRESS_INVALID!.ja)).toEqual([]);
  });

  it.each(entries.map(([code, entry]) => [code, entry.ja] as const))('%s: the Japanese text is a sentence (non-empty, ends with 。)', (_code, ja) => {
    expect(ja.trim().length).toBeGreaterThan(5);
    expect(ja.trim().endsWith('。')).toBe(true);
  });

  it.each(entries.map(([code, entry]) => [code, entry.ko] as const))('%s: the Korean auxiliary text exists and has no URL or code', (_code, ko) => {
    expect(ko.trim().length).toBeGreaterThan(5);
    expect(ko).not.toMatch(/https?:|127\.0\.0\.1|localhost/);
  });

  // 「…」 quotes a Japanese screen label (the operator reads it on the screen), so it may stay Japanese.
  it.each(entries.filter(([code]) => !KO_HAN_TYPO.has(code)).map(([code, entry]) => [code, entry.ko] as const))('%s: outside quoted screen labels the Korean text has no kana or kanji', (_code, ko) => {
    expect(withoutQuotedLabels(ko)).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  it('ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND: no kanji inside the Korean text (was a known defect)', () => {
    expect(withoutQuotedLabels(ERROR_DICTIONARY.ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND!.ko)).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  it('no entry hands out a permission bypass (the rule is stated, not a way around)', () => {
    for (const [, entry] of entries) expect(entry.ja).not.toMatch(/回避|迂回|無視して/);
  });
});

describe('unknown codes', () => {
  it('read 「予期しないエラーです（コード: X）」 with the code in brackets', () => {
    const text = webErrorText('SOMETHING_NEW');
    expect(text.message.startsWith('予期しないエラーです（コード: SOMETHING_NEW）')).toBe(true);
    expect(text.code).toBe('SOMETHING_NEW');
    expect(text.messageKo).toContain('SOMETHING_NEW');
  });

  it('the code is cleaned (no markup or spaces) and cut to 80 characters', () => {
    expect(unexpectedErrorText('A<b>c d').code).toBe('Abcd');
    expect(unexpectedErrorText('X'.repeat(200)).code.length).toBe(80);
    expect(unexpectedErrorText('<>').code).toBe('UNKNOWN');
  });

  it('a prototype key is not a dictionary entry', () => {
    expect(dictionaryEntry('constructor')).toBeNull();
    expect(dictionaryEntry('__proto__')).toBeNull();
    expect(webErrorText('toString').message).toContain('予期しないエラー');
  });

  it('a known code reads its entry, never the unknown-code sentence', () => {
    expect(webErrorText('ROLE_FORBIDDEN').message).toBe(ERROR_DICTIONARY.ROLE_FORBIDDEN!.ja);
  });
});

describe('isOperatorSafeText', () => {
  it.each([
    ['日本語の文です。', true],
    ['ファイルは5MBまでです。', true],
    ['EMLファイルを選んでください。', true],
    ['', false],
    ['   ', false],
    ['http://127.0.0.1:3081/api/me に接続できません', false],
    ['localhost に接続できません', false],
    ['接続先 127.0.0.1:3081', false],
    ['paymentTerms: prepaid / on_delivery を選択してください', false],
    ['Forbidden', false],
    ['権限がありません (ROLE_FORBIDDEN)', false],
    ['api.example.com', false]
  ])('%j => %s', (text, expected) => {
    expect(isOperatorSafeText(text)).toBe(expected);
  });
});

describe('describeApiFailure', () => {
  const failure = (status: number, code: string | null, apiMessage: string | null, kind?: 'timeout' | 'unreachable') =>
    describeApiFailure({ status, code, apiMessage, ...(kind ? { failure: kind } : {}) });

  it('a timeout is API_TIMEOUT whatever else arrived', () => {
    expect(failure(0, null, null, 'timeout').code).toBe('API_TIMEOUT');
    expect(failure(503, 'X', 'text', 'timeout').code).toBe('API_TIMEOUT');
  });

  it('an unreachable API is API_UNREACHABLE', () => {
    expect(failure(0, null, null, 'unreachable').code).toBe('API_UNREACHABLE');
  });

  it.each([null, 'AUTH_REQUIRED', 'SESSION_INVALID', 'ROLE_FORBIDDEN', 'NOT_A_CODE'])('401 with code %j is always SESSION_EXPIRED', (code) => {
    const text = failure(401, code, 'Unauthorized');
    expect(text.code).toBe('SESSION_EXPIRED');
    expect(text.message).toBe(ERROR_DICTIONARY.SESSION_EXPIRED!.ja);
  });

  it('a coded refusal shows the dictionary text and never the API text', () => {
    const text = failure(422, 'PO_NUMBER_REQUIRED', 'poNumber is required');
    expect(text.message).toBe(ERROR_DICTIONARY.PO_NUMBER_REQUIRED!.ja);
    expect(text.message).not.toContain('poNumber');
    expect(text.messageKo).toBe(ERROR_DICTIONARY.PO_NUMBER_REQUIRED!.ko);
  });

  it('a coded refusal with a code the dictionary lacks shows the unknown-code sentence, never the API text', () => {
    const text = failure(422, 'BRAND_NEW_CODE', '日本語の説明です');
    expect(text.message).toContain('予期しないエラーです（コード: BRAND_NEW_CODE）');
    expect(text.message).not.toContain('日本語の説明です');
  });

  it('uncoded 403 is the role refusal', () => {
    expect(failure(403, null, 'Forbidden').code).toBe('ROLE_FORBIDDEN');
  });

  it('uncoded 413 is the upload size refusal', () => {
    expect(failure(413, null, 'Payload Too Large').code).toBe('UPLOAD_TOO_LARGE');
  });

  it.each([500, 502, 503, 504])('uncoded %i is INTERNAL_ERROR', (status) => {
    expect(failure(status, null, 'stack trace here').code).toBe('INTERNAL_ERROR');
  });

  it('an uncoded 4xx with safe Japanese text keeps that text', () => {
    const text = failure(400, null, '日付の形式が正しくありません');
    expect(text.message).toBe('日付の形式が正しくありません');
    expect(text.code).toBe('HTTP_400');
    expect(text.messageKo).toBeNull();
  });

  it.each(['Bad Request', 'validation failed: poNumber', 'http://127.0.0.1:3081/x', '数量 (quantity) が不正です'])('an uncoded 4xx with unsafe text %j is replaced', (apiMessage) => {
    const text = failure(400, null, apiMessage);
    expect(text.message).not.toContain(apiMessage);
    expect(text.message).toContain('予期しないエラーです（コード: HTTP_400）');
  });

  it('an uncoded 4xx without any text is the unknown-code sentence with the status', () => {
    expect(failure(404, null, null).message).toContain('HTTP_404');
  });

  it('no result ever contains a URL or a port', () => {
    const results = [
      failure(0, null, null, 'timeout'),
      failure(0, null, null, 'unreachable'),
      failure(401, null, null),
      failure(403, null, null),
      failure(500, null, null),
      failure(400, null, 'http://127.0.0.1:3081/api/x failed')
    ];
    for (const result of results) {
      expect(result.message).not.toMatch(/https?:|:\d{4}|127\.0\.0\.1|localhost/);
      expect(result.messageKo ?? '').not.toMatch(/https?:|:\d{4}|127\.0\.0\.1|localhost/);
    }
  });
});
