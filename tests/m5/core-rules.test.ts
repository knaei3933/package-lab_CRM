import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ORGANIZATION_STATUS_LABELS,
  COMMISSION_READINESS_STATES,
  COMMISSION_READINESS_STATE_LABELS,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  FILM_SUPPLY_ORDER_STATUS_LABELS,
  FILM_SUPPLY_ORDER_TERMINAL_STATE,
  FILLING_DELIVERY_CONFIRMATION_STATES,
  FILLING_DELIVERY_CONFIRMATION_STATE_LABELS,
  MAKER_PO_STATUS_LABELS,
  MAKER_PURCHASE_ORDER_STATUSES,
  evaluateCommissionReadiness,
  evaluateDeliveryEvidence,
  evaluateFilmReceiptAssumption,
  filmSupplyOrderStatusLabelEntries,
  fillingDeliveryConfirmationState,
  filmSupplyOrderTransitions,
  isCommissionCalculationAllowed,
  japaneseStatusSurface,
  makerPoStatusLabelEntries,
  transitionFilmSupplyOrder,
  type CommissionReadinessState,
  type FilmSupplyOrderState
} from '@kanei/core';

const JAPANESE_TEXT = /[぀-ヿ一-鿿]/;

describe('M5 Japanese status surface (design section 8)', () => {
  it('every film supply order state has exactly one Japanese label', () => {
    const allStates: FilmSupplyOrderState[] = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES];
    expect(Object.keys(FILM_SUPPLY_ORDER_STATUS_LABELS).sort()).toEqual([...allStates].sort());
    for (const state of allStates) {
      const label = FILM_SUPPLY_ORDER_STATUS_LABELS[state];
      expect(label, `state ${state} has a label`).toBeTruthy();
      expect(label).toMatch(JAPANESE_TEXT);
    }
  });

  it('every maker purchase order status has exactly one Japanese label', () => {
    expect(Object.keys(MAKER_PO_STATUS_LABELS).sort()).toEqual([...MAKER_PURCHASE_ORDER_STATUSES].sort());
    for (const status of MAKER_PURCHASE_ORDER_STATUSES) {
      expect(MAKER_PO_STATUS_LABELS[status]).toMatch(JAPANESE_TEXT);
    }
  });

  it('readiness and filling confirmation states carry Japanese labels too', () => {
    expect(Object.keys(COMMISSION_READINESS_STATE_LABELS).sort()).toEqual([...COMMISSION_READINESS_STATES].sort());
    expect(Object.keys(FILLING_DELIVERY_CONFIRMATION_STATE_LABELS).sort())
      .toEqual([...FILLING_DELIVERY_CONFIRMATION_STATES].sort());
    for (const state of COMMISSION_READINESS_STATES) {
      expect(COMMISSION_READINESS_STATE_LABELS[state]).toMatch(JAPANESE_TEXT);
    }
    for (const state of FILLING_DELIVERY_CONFIRMATION_STATES) {
      expect(FILLING_DELIVERY_CONFIRMATION_STATE_LABELS[state]).toMatch(JAPANESE_TEXT);
    }
  });

  it('carries the design section 8 example labels verbatim', () => {
    expect(FILM_SUPPLY_ORDER_STATUS_LABELS.SEVEN_PO_VERIFIED).toBe('セブン化学発注書確認済');
    expect(FILM_SUPPLY_ORDER_STATUS_LABELS.ARTWORK_RECEIVED).toBe('デザインデータ受領');
    expect(FILM_SUPPLY_ORDER_STATUS_LABELS.FILM_DELIVERED).toBe('フィルム納品完了');
    expect(MAKER_PO_STATUS_LABELS.DRAFT).toBe('製造先発注承認待ち');
    expect(MAKER_PO_STATUS_LABELS.APPROVED_FOR_MANUAL_SEND).toBe('送信確認待ち');
    expect(APPROVAL_ORGANIZATION_STATUS_LABELS.customer).toBe('校了（顧客）');
    expect(APPROVAL_ORGANIZATION_STATUS_LABELS.seven).toBe('校了（セブン化学）');
    expect(FILLING_DELIVERY_CONFIRMATION_STATE_LABELS.PENDING_CONFIRMATION).toBe('充填製品納品確認待ち');
  });

  it('serves the surface in the canonical state order through the entry helpers', () => {
    const surface = japaneseStatusSurface();
    expect(surface.filmSupplyOrderStates).toHaveLength(
      FILM_SUPPLY_ORDER_STATES.length + FILM_SUPPLY_ORDER_EXCEPTION_STATES.length
    );
    expect(surface.filmSupplyOrderStates[0]).toEqual({ key: 'DRAFT', label: '下書き' });
    expect(surface.filmSupplyOrderStates.at(-1)).toEqual({ key: 'CANCELLATION_REVIEW', label: 'キャンセルレビュー中' });
    expect(surface.makerPurchaseOrderStatuses).toEqual(makerPoStatusLabelEntries());
    expect(surface.commissionReadinessStates).toEqual([
      { key: 'MISSING_DATA', label: 'データ不足' },
      { key: 'PENDING_VERIFICATION', label: '納品証跡確認待ち' },
      { key: 'READY', label: '手数料計算可能' }
    ]);
    expect(filmSupplyOrderStatusLabelEntries().map((entry) => entry.key)).toEqual([
      ...FILM_SUPPLY_ORDER_STATES,
      ...FILM_SUPPLY_ORDER_EXCEPTION_STATES
    ]);
  });
});

describe('M5 film receipt assumption (manual recording action)', () => {
  it('FILM_RECEIPT_ASSUMED_NO_ISSUE is reachable from FILM_DELIVERED and from nothing else', () => {
    const allStates: FilmSupplyOrderState[] = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES];
    for (const state of allStates) {
      const allowed = filmSupplyOrderTransitions(state).includes(FILM_SUPPLY_ORDER_TERMINAL_STATE);
      if (state === 'FILM_DELIVERED') {
        expect(allowed, `${state} may assume the receipt`).toBe(true);
      } else {
        expect(allowed, `${state} may not assume the receipt`).toBe(false);
        expect(transitionFilmSupplyOrder(state, FILM_SUPPLY_ORDER_TERMINAL_STATE).ok).toBe(false);
      }
    }
    expect(transitionFilmSupplyOrder('FILM_DELIVERED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE').ok).toBe(true);
  });

  it('requires a non-blank note, an explicit evidence-free acknowledgment, and nothing else', () => {
    const ok = evaluateFilmReceiptAssumption({
      currentStatus: 'FILM_DELIVERED',
      note: '受領待機期間は未確定のため問題なしとみなす（合成記録）',
      acknowledgeNoEvidence: true
    });
    expect(ok).toMatchObject({ ok: true, to: 'FILM_RECEIPT_ASSUMED_NO_ISSUE' });

    const noNote = evaluateFilmReceiptAssumption({
      currentStatus: 'FILM_DELIVERED',
      note: '   ',
      acknowledgeNoEvidence: true
    });
    expect(noNote).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_NOTE_REQUIRED' });

    const noAcknowledgment = evaluateFilmReceiptAssumption({
      currentStatus: 'FILM_DELIVERED',
      note: '合成メモ',
      acknowledgeNoEvidence: false
    });
    expect(noAcknowledgment).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED' });

    const badDate = evaluateFilmReceiptAssumption({
      currentStatus: 'FILM_DELIVERED',
      note: '合成メモ',
      acknowledgeNoEvidence: true,
      assumedAt: 'not-a-date'
    });
    expect(badDate).toMatchObject({ ok: false, code: 'INVALID_RECEIPT_ASSUMED_AT' });

    const wrongState = evaluateFilmReceiptAssumption({
      currentStatus: 'FILM_SHIPPED',
      note: '合成メモ',
      acknowledgeNoEvidence: true
    });
    expect(wrongState).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED' });
  });
});

describe('M5 commission readiness gating (T-36)', () => {
  const recorded = {
    filmDeliveryRecorded: true,
    fillingDeliveryRecorded: true,
    sevenPoOfficiallyRegistered: true
  };

  it('deliveries recorded without evidence stay PENDING_VERIFICATION and never calculate a commission', () => {
    const evaluation = evaluateCommissionReadiness({ ...recorded, filmDeliveryConfirmed: false, fillingDeliveryConfirmed: false });
    expect(evaluation).toEqual({
      state: 'PENDING_VERIFICATION',
      isReady: false,
      blocking: ['FILM_DELIVERY_PENDING_CONFIRMATION', 'FILLING_DELIVERY_PENDING_CONFIRMATION']
    });
    expect(isCommissionCalculationAllowed(evaluation.state)).toBe(false);

    const fillingOnly = evaluateCommissionReadiness({ ...recorded, filmDeliveryConfirmed: true, fillingDeliveryConfirmed: false });
    expect(fillingOnly.state).toBe('PENDING_VERIFICATION');
    expect(isCommissionCalculationAllowed(fillingOnly.state)).toBe(false);

    const filmOnly = evaluateCommissionReadiness({ ...recorded, filmDeliveryConfirmed: false, fillingDeliveryConfirmed: true });
    expect(filmOnly.state).toBe('PENDING_VERIFICATION');
    expect(isCommissionCalculationAllowed(filmOnly.state)).toBe(false);
  });

  it('MISSING_DATA while data is missing, READY only with every delivery confirmed', () => {
    const nothing = evaluateCommissionReadiness({
      filmDeliveryRecorded: false,
      fillingDeliveryRecorded: false,
      sevenPoOfficiallyRegistered: false,
      filmDeliveryConfirmed: false,
      fillingDeliveryConfirmed: false
    });
    expect(nothing).toMatchObject({ state: 'MISSING_DATA', isReady: false });
    expect(nothing.blocking).toEqual([
      'FILM_DELIVERY_NOT_RECORDED',
      'FILLING_DELIVERY_NOT_RECORDED',
      'SEVEN_PO_NOT_OFFICIALLY_REGISTERED'
    ]);

    const unregistered = evaluateCommissionReadiness({
      ...recorded,
      sevenPoOfficiallyRegistered: false,
      filmDeliveryConfirmed: true,
      fillingDeliveryConfirmed: true
    });
    expect(unregistered).toMatchObject({ state: 'MISSING_DATA', isReady: false });

    const ready = evaluateCommissionReadiness({ ...recorded, filmDeliveryConfirmed: true, fillingDeliveryConfirmed: true });
    expect(ready).toMatchObject({ state: 'READY', isReady: true, blocking: [] });
    expect(isCommissionCalculationAllowed(ready.state)).toBe(true);
    expect(isCommissionCalculationAllowed('MISSING_DATA' as CommissionReadinessState)).toBe(false);
    expect(isCommissionCalculationAllowed('PENDING_VERIFICATION')).toBe(false);
  });

  it('a delivery without evidence is PENDING_CONFIRMATION, with evidence CONFIRMED', () => {
    expect(fillingDeliveryConfirmationState(false)).toBe('PENDING_CONFIRMATION');
    expect(fillingDeliveryConfirmationState(true)).toBe('CONFIRMED');
  });

  it('delivery evidence must be a verified acceptance document of the same company and order', () => {
    const order = { projectId: 'project-a', filmSupplyOrderId: 'order-1' };

    expect(evaluateDeliveryEvidence(undefined, { order, evidenceDocument: null }))
      .toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_REQUIRED' });
    expect(evaluateDeliveryEvidence('version-1', { order, evidenceDocument: null }))
      .toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND' });
    expect(evaluateDeliveryEvidence('version-1', {
      order,
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'send_evidence',
        verificationStatus: 'verified',
        filmSupplyOrderId: 'order-1'
      }
    })).toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID' });
    expect(evaluateDeliveryEvidence('version-1', {
      order,
      evidenceDocument: {
        projectId: 'project-b',
        documentType: 'acceptance_evidence',
        verificationStatus: 'verified',
        filmSupplyOrderId: 'order-1'
      }
    })).toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_PROJECT_MISMATCH' });
    expect(evaluateDeliveryEvidence('version-1', {
      order,
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'acceptance_evidence',
        verificationStatus: 'verified',
        filmSupplyOrderId: 'order-9'
      }
    })).toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_ORDER_MISMATCH' });
    expect(evaluateDeliveryEvidence('version-1', {
      order,
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'acceptance_evidence',
        verificationStatus: 'unverified',
        filmSupplyOrderId: 'order-1'
      }
    })).toMatchObject({ ok: false, code: 'DELIVERY_EVIDENCE_NOT_VERIFIED' });

    // A filling delivery has no order binding on its documents: the company
    // match is the boundary there.
    expect(evaluateDeliveryEvidence('version-1', {
      order: { projectId: 'project-a', filmSupplyOrderId: null },
      evidenceDocument: {
        projectId: 'project-a',
        documentType: 'acceptance_evidence',
        verificationStatus: 'verified',
        filmSupplyOrderId: null
      }
    })).toMatchObject({ ok: true, confirmedOn: 'verified_delivery_evidence' });
  });
});
