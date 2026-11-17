import { describe, expect, it } from 'vitest';
import {
  isMakerPoBoundDocumentType,
  toMakerPoChoices
} from '../apps/web/src/lib/document-maker-po.js';

describe('document upload maker PO binding', () => {
  it('binds only acceptance and send evidence to a maker PO', () => {
    expect(isMakerPoBoundDocumentType('acceptance_evidence')).toBe(true);
    expect(isMakerPoBoundDocumentType('send_evidence')).toBe(true);
    expect(isMakerPoBoundDocumentType('seven_po')).toBe(false);
  });

  it('lists live maker POs tagged with their order and skips cancelled ones', () => {
    const choices = toMakerPoChoices(
      [{ id: 'o1', code: 'FSO-1' }, { id: 'o2', code: 'FSO-2' }],
      new Map([
        ['o1', [{ id: 'aaaaaaaa-1', status: 'CANCELLED' }, { id: 'bbbbbbbb-2', status: 'MAKER_PO_SENT_MANUALLY' }]],
        ['o2', [{ id: 'cccccccc-3', status: 'APPROVED_FOR_MANUAL_SEND' }]]
      ])
    );
    expect(choices.map((c) => [c.value, c.filmSupplyOrderId])).toEqual([
      ['bbbbbbbb-2', 'o1'],
      ['cccccccc-3', 'o2']
    ]);
    expect(choices[0]!.label).toContain('FSO-1');
  });
});
