import { describe, expect, it } from 'vitest';
import {
  asiaTokyoDatetimeLocalNow,
  datetimeLocalToIso,
  normalizeDateTimeForApi,
  offsetDateTimeField
} from '../apps/web/src/lib/datetime.js';
import { mergeEmlFormValues, parseDatetimeLocalValue, toDatetimeLocalValue } from '../apps/web/src/lib/eml-form.js';

describe('maker PO datetime-local submissions', () => {
  it('submits browser-local time as an explicit UTC offset', () => {
    const local = '2026-11-17T18:54';
    const iso = datetimeLocalToIso(local);

    expect(iso).toMatch(/Z$/);
    expect(Date.parse(iso!)).toBe(Date.parse(local));
    expect(toDatetimeLocalValue(new Date(iso!))).toBe(local);
  });

  it('normalizes naive action input as Asia/Tokyo without relying on server TZ', () => {
    const normalized = normalizeDateTimeForApi('2026-11-17T18:54');
    expect(normalized).toBe('2026-11-17T18:54:00+09:00');
    expect(Date.parse(normalized!)).toBe(Date.parse('2026-11-17T18:54:00+09:00'));
    expect(normalizeDateTimeForApi('2026-11-17T18:54:00+00:00')).toBe('2026-11-17T18:54:00+00:00');
    expect(normalizeDateTimeForApi('2026-11-17T18:54:00Z')).toBe('2026-11-17T18:54:00Z');
    expect(normalizeDateTimeForApi('not-a-time')).toBeNull();
  });

  it('clears stale EML auto-fill values unless the operator edited them', () => {
    const current = { senderAddress: 'old@maker.example', sentAt: '2026-11-17T18:54' };
    const unedited = mergeEmlFormValues(current, { senderAddress: false, sentAt: false }, {});
    expect(unedited).toEqual({ senderAddress: '', sentAt: '' });

    const partlyEdited = mergeEmlFormValues(
      current,
      { senderAddress: true, sentAt: false },
      { senderAddress: 'new@maker.example', sentAt: '2026-11-17T09:54' }
    );
    expect(partlyEdited).toEqual({ senderAddress: 'old@maker.example', sentAt: '2026-11-17T09:54' });
  });

  it('falls back to the visible Local field as Asia/Tokyo before hydration', () => {
    const form = new FormData();
    form.set('verifiedAt', '2026-11-17T09:54:00Z');
    expect(offsetDateTimeField(form, 'verifiedAt')).toBe('2026-11-17T09:54:00Z');

    form.set('verifiedAt', '');
    form.set('verifiedAtLocal', '2026-11-17T18:54');
    expect(offsetDateTimeField(form, 'verifiedAt')).toBe('2026-11-17T18:54:00+09:00');

    // A present but malformed hidden value must not suppress the Local fallback.
    form.set('verifiedAt', 'broken-server-conversion');
    form.set('verifiedAtLocal', '2026-11-17T18:54');
    expect(offsetDateTimeField(form, 'verifiedAt')).toBe('2026-11-17T18:54:00+09:00');

    form.set('verifiedAtLocal', 'not-a-time');
    expect(offsetDateTimeField(form, 'verifiedAt')).toBe('');
  });

  it('prefills the Asia/Tokyo wall clock regardless of server timezone and unifies fractions', () => {
    expect(asiaTokyoDatetimeLocalNow(new Date('2026-11-17T09:54:00Z'))).toBe('2026-11-17T18:54');
    const sixFractionDigits = '2026-11-17T18:54:00.123456';
    expect(datetimeLocalToIso(sixFractionDigits)).toBe(new Date(sixFractionDigits).toISOString());
    expect(parseDatetimeLocalValue(sixFractionDigits)?.getTime()).toBe(Date.parse(sixFractionDigits));
    expect(datetimeLocalToIso('2026-11-17T18:54:00.1234567')).toBeNull();
    expect(parseDatetimeLocalValue('2026-11-17T18:54:00.1234567')).toBeNull();
  });
});
