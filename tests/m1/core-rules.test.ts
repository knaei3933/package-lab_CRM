import { describe, expect, it } from 'vitest';
import {
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  evaluateSevenPoVerificationGate,
  filmSupplyOrderTransitions,
  isExceptionFilmSupplyOrderState,
  isLegacyHoldReleaseTarget,
  toQuantityString,
  resolveCancellationReview,
  transitionFilmSupplyOrder,
  validateQuantity,
  validateUnit,
  type FilmSupplyOrderState,
  type NormalFilmSupplyOrderState
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
    expect(transitionFilmSupplyOrder('ON_HOLD', 'PROOF_READY', 'PROOF_READY').ok).toBe(true);
    expect(transitionFilmSupplyOrder('ON_HOLD', 'FILM_IN_PRODUCTION', 'FILM_IN_PRODUCTION').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', 'MAKER_PO_READY', 'MAKER_PO_READY').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'ARTWORK_RECEIVED').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'PROOF_READY').ok).toBe(true);
    // CHANGE_REVIEW restarts the artwork/approval chain, not production.
    expect(transitionFilmSupplyOrder('CHANGE_REVIEW', 'FILM_SHIPPED').ok).toBe(false);
  });

  it('a hold releases only to its immediate prior state', () => {
    expect(transitionFilmSupplyOrder('ON_HOLD', 'FILM_IN_PRODUCTION', 'APPROVED_FOR_MANUAL_SEND').ok).toBe(false);
    expect(transitionFilmSupplyOrder('ON_HOLD', 'APPROVED_FOR_MANUAL_SEND', 'APPROVED_FOR_MANUAL_SEND').ok).toBe(true);
    expect(transitionFilmSupplyOrder('ON_HOLD', 'PROOF_READY').ok).toBe(false);
  });

  it('a cancellation review releases only to its immediate prior state', () => {
    expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', 'FILM_IN_PRODUCTION', 'DRAFT').ok).toBe(false);
    expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', 'DRAFT', 'DRAFT').ok).toBe(true);
    expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', 'MAKER_PO_READY').ok).toBe(false);
  });

  it('resolves a cancellation review only to its origin, an allowed legacy target, or cancellation', () => {
    expect(resolveCancellationReview('resume', 'APPROVED_FOR_MANUAL_SEND', 'APPROVED_FOR_MANUAL_SEND'))
      .toMatchObject({ ok: true, outcome: 'resume', target: 'APPROVED_FOR_MANUAL_SEND' });
    expect(resolveCancellationReview('resume', 'APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_READY'))
      .toMatchObject({ ok: false, code: 'CANCELLATION_RESUME_TARGET_INVALID' });
    expect(resolveCancellationReview('resume', 'MAKER_PO_SENT_MANUALLY'))
      .toMatchObject({ ok: true, target: 'MAKER_PO_SENT_MANUALLY' });
    expect(resolveCancellationReview('resume', undefined, 'MAKER_PO_ACCEPTED'))
      .toMatchObject({ ok: true, target: 'MAKER_PO_ACCEPTED' });
    expect(resolveCancellationReview('resume', undefined, 'FILM_IN_PRODUCTION'))
      .toMatchObject({ ok: false, code: 'CANCELLATION_RESUME_TARGET_INVALID' });
    expect(resolveCancellationReview('resume', undefined))
      .toMatchObject({ ok: false, code: 'CANCELLATION_RESUME_REQUIRED' });
    expect(resolveCancellationReview('cancel', 'MAKER_PO_ACCEPTED'))
      .toMatchObject({ ok: true, outcome: 'cancel', target: 'CANCELLED' });
  });

  it('exhaustively keeps production unreachable without maker acceptance', () => {
    const chain = FILM_SUPPLY_ORDER_STATES as readonly FilmSupplyOrderState[];
    const acceptedIndex = chain.indexOf('MAKER_PO_ACCEPTED');
    const makerChainStates = new Set(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED']);
    type Node = { state: FilmSupplyOrderState; origin: NormalFilmSupplyOrderState | null };

    for (const start of chain) {
      const seen = new Set<string>();
      const queue: Node[] = [{ state: start, origin: null }];
      while (queue.length > 0) {
        const node = queue.shift()!;
        const key = `${node.state}|${node.origin ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const to of filmSupplyOrderTransitions(node.state)) {
          // The generic transitions endpoint refuses every maker-chain target;
          // those states are written only by evidence-backed dedicated APIs.
          if (makerChainStates.has(to)) continue;
          const nextOrigin = isExceptionFilmSupplyOrderState(node.state)
            ? node.origin as NormalFilmSupplyOrderState | null
            : to === 'ON_HOLD' || to === 'CANCELLATION_REVIEW'
              ? node.state
              : null;
          if (!transitionFilmSupplyOrder(node.state, to, nextOrigin).ok) continue;
          queue.push({ state: to, origin: nextOrigin });
        }
      }

      const reachable = [...seen].map((key) => key.split('|')[0]!);
      const startIndex = chain.indexOf(start);
      if (startIndex < acceptedIndex) {
        for (const later of chain.slice(acceptedIndex + 1)) {
          expect(reachable, `${start} -> ${later}`).not.toContain(later);
        }
      }
    }

    // The pre-fix escape was a maker-chain origin entering CR and leaving to a
    // different state. Core keeps that origin exact; API additionally denies
    // every generic CR exit and exposes the admin resolution endpoint.
    for (const origin of ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'] as const) {
      for (const state of FILM_SUPPLY_ORDER_STATES) {
        if (state === origin) continue;
        expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', state, origin).ok, `${origin}->CR->${state}`).toBe(false);
      }
      expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', origin, origin).ok).toBe(true);
    }
  });

  it('models the updated 124-edge H1 probe graph without unsafe late reachability', () => {
    const normal = FILM_SUPPLY_ORDER_STATES as readonly NormalFilmSupplyOrderState[];
    const acceptedIndex = normal.indexOf('MAKER_PO_ACCEPTED');
    const makerChain = new Set(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED']);
    // The recheck probe measured 124 API edges at HEAD 56422c8. This update
    // removes all 13 generic CR exits and adds two admin resolution outcomes
    // per CR origin: 124 - 13 + (13 * 2) = 137.
    let edgeCount = 124;
    for (const origin of normal.filter((state) => state !== 'FILM_RECEIPT_ASSUMED_NO_ISSUE')) {
      expect(transitionFilmSupplyOrder('CANCELLATION_REVIEW', origin, origin).ok).toBe(true);
      expect(resolveCancellationReview('resume', origin)).toMatchObject({ ok: true, target: origin });
      expect(resolveCancellationReview('cancel', origin)).toMatchObject({ ok: true, target: 'CANCELLED' });
      edgeCount += 1;
    }

    expect(edgeCount).toBe(137);

    // BFS the API-visible graph from every pre-acceptance start plus the
    // legacy hold node and assert no send/accept/late state appears.
    type Node = { state: FilmSupplyOrderState; origin: NormalFilmSupplyOrderState | null };
    const late = new Set(normal.slice(acceptedIndex + 1));
    for (const start of normal.slice(0, acceptedIndex)) {
      const seen = new Set<string>([start]);
      const queue: Node[] = [{ state: start, origin: null }];
      while (queue.length > 0) {
        const node = queue.shift()!;
        for (const target of normal) {
          if (makerChain.has(target) || !transitionFilmSupplyOrder(node.state, target).ok) continue;
          const nextOrigin = isExceptionFilmSupplyOrderState(target) ? node.state as NormalFilmSupplyOrderState : null;
          const key = `${target}|${nextOrigin ?? ''}`;
          if (!seen.has(key)) {
            seen.add(key);
            queue.push({ state: target, origin: nextOrigin });
          }
        }
        if (node.state === 'ON_HOLD' && node.origin) {
          const key = `${node.origin}|`;
          if (!seen.has(key)) {
            seen.add(key);
            queue.push({ state: node.origin, origin: null });
          }
        }
        if (node.state === 'CANCELLATION_REVIEW') {
          // Resolving to CANCELLED or the exact origin never adds a late state.
          continue;
        }
        if (node.state === 'CHANGE_REVIEW') {
          for (const target of ['ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING'] as const) {
            const key = `${target}|`;
            if (!seen.has(key)) {
              seen.add(key);
              queue.push({ state: target, origin: null });
            }
          }
        }
      }
      for (const reached of seen) {
        const state = reached.split('|')[0]!;
        expect(late.has(state as NormalFilmSupplyOrderState), `${start} reached ${state}`).toBe(false);
      }
    }
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
