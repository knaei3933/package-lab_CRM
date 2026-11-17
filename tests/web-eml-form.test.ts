import { describe, expect, it } from 'vitest';
import {
  isSentAtBeforeCeoApproval,
  parseDatetimeLocalValue,
  parseEmlHeaders,
  parseEmlFormSender,
  readEmlFormDefaults,
  toDatetimeLocalValue
} from '../apps/web/src/lib/eml-form.js';

describe('maker PO manual-send EML defaults', () => {
  it('parses folded Date and From headers', () => {
    const headers = parseEmlHeaders(
      'Message-ID: <maker-po@example.com>\r\nDate: Mon,\r\n 17 Nov 2026 09:54:00 +0000\r\nFrom: 製造担当\r\n <staff@kanei.example>\r\n\r\nbody'
    );
    expect(headers.date).toEqual(['Mon, 17 Nov 2026 09:54:00 +0000']);
    expect(headers.from).toEqual(['製造担当 <staff@kanei.example>']);
    expect(parseEmlFormSender(headers.from![0]!)).toBe('staff@kanei.example');
  });

  it('converts datetime-local values without shifting zones', () => {
    const local = new Date(2026, 10, 17, 18, 54);
    expect(toDatetimeLocalValue(local)).toBe('2026-11-17T18:54');
    expect(parseDatetimeLocalValue('2026-11-17T18:54')?.getTime()).toBe(local.getTime());
  });

  it('reads Date and From defaults without parsing MIME attachments', () => {
    const defaults = readEmlFormDefaults(
      'Date: Tue, 17 Nov 2026 09:54:00 +0000\r\nFrom: Staff <Staff@Kanei.Example>\r\n\r\nbody'
    );
    expect(defaults.senderAddress).toBe('staff@kanei.example');
    expect(defaults.sentAt).toBe(toDatetimeLocalValue(new Date('2026-11-17T09:54:00+00:00')));
  });

  it('flags only a valid send time earlier than CEO approval', () => {
    expect(isSentAtBeforeCeoApproval('2026-11-16T18:54', '2026-11-17T09:00:00.000Z')).toBe(true);
    expect(isSentAtBeforeCeoApproval('2026-11-17T18:54', '2026-11-17T09:00:00.000Z')).toBe(false);
    expect(isSentAtBeforeCeoApproval('not-a-time', '2026-11-17T09:00:00.000Z')).toBe(false);
    expect(isSentAtBeforeCeoApproval('2026-11-16T18:54', null)).toBe(false);
  });
});
