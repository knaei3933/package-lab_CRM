import { describe, expect, it } from 'vitest';
import {
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  evaluateSevenPoVerificationGate,
  filmSupplyOrderTransitions,
  toQuantityString,
  transitionFilmSupplyOrder,
  validateQuantity,
  validateUnit,
  type FilmSupplyOrderState
} from '@kanei/core';

describe('M1 film supply order state machine', () => {
  it('advances the normal chain from DRAFT to FILM_RECEIPT_ASSUMED_NO_ISSUE', () => {
    const chain: FilmSupplyOrderState[] = [
      'SEVEN_PO_VERIFIED',
      'ARTWORK_RECEIVED',
      'PROOF_READY',
      'APPROVAL_PENDING',
      'DUAL_APPROVED',
      'MAKER_PO_READY',
      'APPROVED_FOR_MANUAL_SEND',
      'MAKER_PO_SENT_MANUALLY',
      'MAKER_PO_ACCEPTED',
      'FILM_IN_PRODUCTION',
      'FILM_SHIPPED',
      'FILM_DELIVERED',
      'FILM_RECEIPT_ASSUMED_NO_ISSUE'
    ];
    let state: FilmSupplyOrderState = 'DRAFT';
    for (const next of chain) {
      const result = transitionFilmSupplyOrder(state, next);
      expect(result.ok).toBe(true);
      state = next;
    }
    expect(state).toBe('FILM_RECEIPT_ASSUMED_NO_ISSUE');
  });

  it('rejects skipping states with the from/to pair', () => {
    expect(transitionFilmSupplyOrder('DRAFT', 'FILM_SHIPPED'))
      .toEqual({ ok: false, from: 'DRAFT', to: 'FILM_SHIPPED' });
    expect(transitionFilmSupplyOrder('PROOF_READY', 'MAKER_PO_SENT_MANUALLY').ok).toBe(false);
  });

  it('FILM_RECEIPT_ASSUMED_NO_ISSUE is terminal', () => {
    expect(filmSupplyOrderTransitions('FILM_RECEIPT_ASSUMED_NO_ISSUE')).toEqual([]);
    expect(transitionFilmSupplyOrder('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'DRAFT').ok).toBe(false);
  });

  it('every non-terminal normal state can enter the three exception states', () => {
    for (const state of FILM_SUPPLY_ORDER_STATES) {
      if (state === 'FILM_RECEIPT_ASSUMED_NO_ISSUE') continue;
      for (const exception of FILM_SUPPLY_ORDER_EXCEPTION_STATES) {
        expect(transitionFilmSupplyOrder(state, exception).ok).toBe(true);
      }
    }
  });

  it('exception states resolve back into named normal states', () => {
    expect(transitionFilmSupplyOrder('ON_HOLD', 'PROOF_READY').ok).toBe(true);
    expect(transitionFilmSupplyOrder('ON_HOLD', 'FILM_IN_PRODUCTION').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', 'MAKER_PO_READY').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'ARTWORK_RECEIVED').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'PROOF_READY').ok).toBe(true);
    // CHANGE_REVIEW restarts the artwork/approval chain, not production.
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'FILM_SHIPPED').ok).toBe(false);
  });
});

describe('M1 date separation rule', () => {
  it('fails the gate when official_registered_at is missing even if original_received_at exists', () => {
    const gate = evaluateSevenPoVerificationGate({
      officialRegisteredAt: null,
      originalReceivedAt: new Date('2026-11-01T00:00:00.000Z')
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('OFFICIAL_REGISTRATION_REQUIRED');
    }
  });

  it('passes the gate on official_registered_at alone', () => {
    const gate = evaluateSevenPoVerificationGate({
      officialRegisteredAt: new Date('2026-11-02T00:00:00.000Z'),
      originalReceivedAt: null
    });
    expect(gate).toEqual({ ok: true, gatedOn: 'official_registered_at' });
  });
});

describe('M1 units vocabulary', () => {
  it('accepts film units on film records', () => {
    expect(validateUnit('rolls', 'film')).toMatchObject({ ok: true, unit: 'rolls', domain: 'film' });
    expect(validateUnit('meters', 'film')).toMatchObject({ ok: true, unit: 'meters', domain: 'film' });
    expect(validateUnit('sheets', 'film')).toMatchObject({ ok: true, unit: 'sheets', domain: 'film' });
  });

  it('accepts filling units on filling records', () => {
    expect(validateUnit('pods', 'filling')).toMatchObject({ ok: true, unit: 'pods', domain: 'filling' });
    expect(validateUnit('pieces', 'filling')).toMatchObject({ ok: true, unit: 'pieces', domain: 'filling' });
  });

  it('rejects mixing units across the film/filling boundary', () => {
    const filmRejection = validateUnit('pods', 'film');
    expect(filmRejection).toMatchObject({ ok: false, code: 'UNIT_DOMAIN_MISMATCH' });
    const fillingRejection = validateUnit('rolls', 'filling');
    expect(fillingRejection).toMatchObject({ ok: false, code: 'UNIT_DOMAIN_MISMATCH' });
  });

  it('rejects units outside the vocabulary', () => {
    expect(validateUnit('cartons', 'film')).toMatchObject({ ok: false, code: 'UNKNOWN_UNIT' });
    expect(validateUnit(42, 'filling')).toMatchObject({ ok: false, code: 'UNKNOWN_UNIT' });
  });

  it('quantities must be positive and finite, stored as numeric(14,3) text', () => {
    expect(validateQuantity(0).ok).toBe(false);
    expect(validateQuantity(-5).ok).toBe(false);
    expect(validateQuantity(Number.NaN).ok).toBe(false);
    expect(validateQuantity(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateQuantity(95000)).toMatchObject({ ok: true, quantity: 95000 });
    expect(toQuantityString(95000)).toBe('95000.000');
    expect(toQuantityString(1200.5)).toBe('1200.500');
  });
});
