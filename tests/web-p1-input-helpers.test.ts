import { describe, expect, it } from 'vitest';
import { bytesToBase64, detectFileKind, readMailIdentifiers } from '../apps/web/src/lib/file-kind.js';
import { formatAmount, formatQuantity, formatQuantityWithUnit } from '../apps/web/src/lib/number-format.js';
import { draftKey, draftValues, forget, hasUnsavedInput, isLeavingClick, markDirty } from '../apps/web/src/lib/unsaved-guard.js';

const enc = (text: string) => new TextEncoder().encode(text);

describe('detectFileKind (R22)', () => {
  it('detects a PDF by its signature whatever the file name says', () => {
    expect(detectFileKind(enc('%PDF-1.7\n...'), 'scan.txt')).toMatchObject({ ok: true, contentType: 'application/pdf' });
  });

  it('detects a PNG by its 8-byte signature', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectFileKind(png, 'a.dat')).toMatchObject({ ok: true, contentType: 'image/png' });
  });

  it('does not take a truncated PNG signature for a PNG', () => {
    const almost = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, 1, 2]);
    expect(detectFileKind(almost, 'a.png')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('detects a JPEG by its signature', () => {
    expect(detectFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'p.jpg')).toMatchObject({ ok: true, contentType: 'image/jpeg' });
  });

  it('detects a mail by its header even without the .eml extension', () => {
    const mail = 'Return-Path: <a@b.example>\r\nFrom: a@b.example\r\nMessage-ID: <x@b.example>\r\n\r\nbody';
    expect(detectFileKind(enc(mail), 'approval.bin')).toMatchObject({ ok: true, contentType: 'message/rfc822' });
  });

  it('detects a mail by the .eml extension', () => {
    expect(detectFileKind(enc('anything readable'), 'x.EML')).toMatchObject({ ok: true, contentType: 'message/rfc822' });
  });

  it('does not take text with a mail-looking line that is not first for a mail', () => {
    expect(detectFileKind(enc('hello\nFrom: a@b\nMessage-ID: <1>'), 'n.txt')).toMatchObject({ contentType: 'text/plain' });
  });

  it('detects CSV by extension and plain text by .txt or no extension', () => {
    expect(detectFileKind(enc('a,b\n1,2'), 'rows.csv')).toMatchObject({ ok: true, contentType: 'text/csv' });
    expect(detectFileKind(enc('memo'), 'memo.txt')).toMatchObject({ ok: true, contentType: 'text/plain' });
    expect(detectFileKind(enc('memo'), 'memo')).toMatchObject({ ok: true, contentType: 'text/plain' });
  });

  it('refuses binary data that is not a known signature', () => {
    expect(detectFileKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]), 'a.zip')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses readable text with an unsupported extension', () => {
    expect(detectFileKind(enc('hello'), 'doc.docx')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reports an empty file as empty', () => {
    expect(detectFileKind(new Uint8Array(0), 'a.pdf')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('readMailIdentifiers (R22)', () => {
  it('reads the Message-ID and converts the Date to an ISO instant', () => {
    const mail = 'From: a@b\r\nMessage-ID: <abc123@mail.example>\r\nDate: Fri, 20 Nov 2026 10:00:00 +0900\r\n\r\nbody';
    expect(readMailIdentifiers(mail)).toEqual({ messageId: '<abc123@mail.example>', date: '2026-11-20T01:00:00.000Z' });
  });

  it('reads a folded Message-ID header', () => {
    const mail = 'Message-ID:\r\n <folded-id@mail.example>\r\nDate: Fri, 20 Nov 2026 10:00:00 +0900\r\n\r\nx';
    expect(readMailIdentifiers(mail).messageId).toBe('<folded-id@mail.example>');
  });

  it('reads LF-only header blocks', () => {
    expect(readMailIdentifiers('Message-ID: <lf-only@x.example>\n\nbody').messageId).toBe('<lf-only@x.example>');
  });

  it('returns null for a missing Message-ID', () => {
    expect(readMailIdentifiers('From: a@b\r\nDate: Fri, 20 Nov 2026 10:00:00 +0900\r\n\r\nbody').messageId).toBeNull();
  });

  it('returns null for a Message-ID shorter than 8 characters', () => {
    expect(readMailIdentifiers('Message-ID: <a@b>\r\n\r\nx').messageId).toBeNull();
  });

  it('returns null date for an unparseable Date', () => {
    expect(readMailIdentifiers('Message-ID: <long-enough@x.example>\r\nDate: not a date\r\n\r\nx').date).toBeNull();
  });

  it('returns null date when there is no Date header', () => {
    expect(readMailIdentifiers('Message-ID: <long-enough@x.example>\r\n\r\nx').date).toBeNull();
  });

  it('does not read identifiers from the message body', () => {
    expect(readMailIdentifiers('From: a@b\r\n\r\nMessage-ID: <in-body@x.example>\r\nDate: Fri, 20 Nov 2026 10:00:00 +0900')).toEqual({ messageId: null, date: null });
  });
});

describe('bytesToBase64', () => {
  it('round-trips a buffer larger than one chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(Buffer.from(bytesToBase64(bytes), 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('number-format (R31)', () => {
  it('drops trailing zeros: 300.000 -> 300', () => {
    expect(formatQuantity('300.000')).toBe('300');
  });

  it('groups thousands: 1200000 -> 1,200,000 (string and number)', () => {
    expect(formatQuantity('1200000')).toBe('1,200,000');
    expect(formatQuantity(1200000)).toBe('1,200,000');
  });

  it('keeps at most 3 decimals', () => {
    expect(formatQuantity('1234.5678')).toBe('1,234.568');
  });

  it('formats a negative number', () => {
    expect(formatQuantity('-5')).toBe('-5');
  });

  it('passes a non-number through as typed', () => {
    expect(formatQuantity('12abc')).toBe('12abc');
    expect(formatQuantity('')).toBe('');
    expect(formatQuantity('1,000')).toBe('1,000');
  });

  it('returns an empty string for null and undefined, never "NaN" or "null"', () => {
    expect(formatQuantity(null)).toBe('');
    expect(formatQuantity(undefined)).toBe('');
  });

  it.each([['meters', '300 m'], ['rolls', '300 ロール'], ['sheets', '300 枚'], ['pods', '300 ポッド'], ['pieces', '300 個']])('writes unit %s as a short symbol', (unit, expected) => {
    expect(formatQuantityWithUnit('300.000', unit)).toBe(expected);
  });

  it('shows only the number for an unknown or missing unit code', () => {
    expect(formatQuantityWithUnit('300', 'furlongs')).toBe('300');
    expect(formatQuantityWithUnit('300', null)).toBe('300');
  });

  it('formats JPY with a yen sign and grouping', () => {
    expect(formatAmount('JPY', '312000')).toMatch(/^[¥￥]312,000$/);
    expect(formatAmount(null, 480000)).toMatch(/^[¥￥]480,000$/);
  });

  it('formats another currency as number plus code', () => {
    expect(formatAmount('USD', '1200.5')).toBe('1,200.5 USD');
  });

  it('passes a non-numeric amount through and gives empty for null', () => {
    expect(formatAmount('JPY', 'abc')).toBe('abc');
    expect(formatAmount('JPY', null)).toBe('');
  });
});

describe('isLeavingClick (R34)', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const anchor = { href: '/p/A/orders', target: '', hasDownload: false, hash: '', pathname: '/p/A/orders', search: '' };
  const here = { pathname: '/p/A/o/X', search: '' };

  it('is a leaving click for a plain same-tab link to another page', () => {
    expect(isLeavingClick(click, anchor, here)).toBe(true);
  });

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)('is not leaving with %s held', (key) => {
    expect(isLeavingClick({ ...click, [key]: true }, anchor, here)).toBe(false);
  });

  it('is not leaving for a middle or right click or a prevented click', () => {
    expect(isLeavingClick({ ...click, button: 1 }, anchor, here)).toBe(false);
    expect(isLeavingClick({ ...click, button: 2 }, anchor, here)).toBe(false);
    expect(isLeavingClick({ ...click, defaultPrevented: true }, anchor, here)).toBe(false);
  });

  it('is not leaving for target=_blank, but is for target=_self', () => {
    expect(isLeavingClick(click, { ...anchor, target: '_blank' }, here)).toBe(false);
    expect(isLeavingClick(click, { ...anchor, target: '_self' }, here)).toBe(true);
  });

  it('is not leaving for a download link', () => {
    expect(isLeavingClick(click, { ...anchor, hasDownload: true }, here)).toBe(false);
  });

  it('is not leaving for an empty or javascript: href', () => {
    expect(isLeavingClick(click, { ...anchor, href: '' }, here)).toBe(false);
    expect(isLeavingClick(click, { ...anchor, href: 'javascript:void(0)' }, here)).toBe(false);
  });

  it('is not leaving for a hash jump inside the same page and query', () => {
    expect(isLeavingClick(click, { ...anchor, href: '#step-3', hash: '#step-3', pathname: here.pathname, search: '' }, here)).toBe(false);
  });

  it('is leaving for the same path with another query, or a hash on another page', () => {
    expect(isLeavingClick(click, { ...anchor, hash: '#x', pathname: here.pathname, search: '?step=3' }, here)).toBe(true);
    expect(isLeavingClick(click, { ...anchor, hash: '#x' }, here)).toBe(true);
  });
});

describe('draftValues / draftKey / dirty registry (R34)', () => {
  const control = (name: string, type: string, value: string, checked?: boolean) => ({ name, type, value, ...(checked === undefined ? {} : { checked }) });

  it('keeps named visible text values and drops empty ones', () => {
    expect(draftValues([control('memo', 'text', 'hello'), control('blank', 'text', ''), control('area', 'textarea', 'x')])).toEqual({ memo: 'hello', area: 'x' });
  });

  it('excludes hidden, file, password and submit controls', () => {
    expect(draftValues([
      control('orderId', 'hidden', 'o1'), control('upload', 'file', 'C:\\fakepath\\a.pdf'),
      control('pw', 'password', 'secret'), control('go', 'submit', 'send'), control('keep', 'text', 'ok')
    ])).toEqual({ keep: 'ok' });
  });

  it('excludes the form-internal _kanei* fields even when they are visible-typed', () => {
    expect(draftValues([control('_kaneiRenderedProjectId', 'text', 'p1'), control('_kaneiIdempotencyKey', 'text', 'k'), control('ok', 'text', '1')])).toEqual({ ok: '1' });
  });

  it('excludes controls without a name', () => {
    expect(draftValues([control('', 'text', 'x')])).toEqual({});
  });

  it('keeps only checked checkboxes and radios, with on as the default value', () => {
    expect(draftValues([
      control('a', 'checkbox', 'on', true), control('b', 'checkbox', 'on', false),
      control('c', 'radio', 'yes', true), control('d', 'checkbox', '', true)
    ])).toEqual({ a: 'on', c: 'yes', d: 'on' });
  });

  it('builds the storage key from the screen path and form name', () => {
    expect(draftKey('/p/A/o/X', 'proof')).toBe('kanei-draft:/p/A/o/X:proof');
  });

  it('tracks unsaved input per form and clears it on forget / markDirty(false)', () => {
    const a = {};
    const b = {};
    expect(hasUnsavedInput()).toBe(false);
    markDirty(a, true);
    markDirty(b, true);
    expect(hasUnsavedInput()).toBe(true);
    markDirty(a, false);
    expect(hasUnsavedInput()).toBe(true);
    forget(b);
    expect(hasUnsavedInput()).toBe(false);
  });
});
