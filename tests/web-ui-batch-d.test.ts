import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  FILM_ORDER_CANCELLATION_STATE,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES
} from '@kanei/core';

/**
 * UI batch D unit rules (recheck 6: High-A, Low-6; CANCELLED badge; hold /
 * review reasons). The real-API parity of the same rules is in
 * tests/web-ui-batch-d-parity.test.tsx.
 */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project',
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'anonymous' })
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const {
  acknowledgementEvidenceDocuments,
  cancellationAcknowledgementMayBeRequired,
  cancelSendStateCopy,
  hasVerifiedSendEvent,
  loadManualVerificationsForEvents,
  makerPoSendProof,
  sendEventsWithoutKnownDecision
} = await import('../apps/web/src/lib/maker-po-data.js');
const { statusTone, FILM_ORDER_STATUS_TONES } = await import('../apps/web/src/lib/status-tone.js');
const { orderProgress } = await import('../apps/web/src/lib/project-data.js');
const {
  releaseFilmOrderHoldAction,
  resolveCancellationReviewAction,
  transitionFilmSupplyOrderAction
} = await import('../apps/web/src/app/actions.js');

type EventRow = Parameters<typeof makerPoSendProof>[0][number];
type Verification = Parameters<typeof makerPoSendProof>[1][number];

const send = (id: string, verificationStatus: string): EventRow =>
  ({ id, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus });
const decision = (makerPoEventId: string, result: 'confirmed' | 'rejected'): Verification => ({
  makerPoEventId, result, verifierName: '代表者', verifiedAt: '2026-11-18T01:00:00.000Z', reasonNote: '原本確認', recordedAt: '2026-11-18T01:00:01.000Z'
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', 'project'); // P0 R03: the form was drawn for the selected project
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  callApi.mockReset();
});

describe('High-A: the proven-send rule is the API\'s (VERIFIED or confirmed manual verification)', () => {
  it('a confirmed manual verification of a pending send proves the send; the VERIFIED-only check alone does not', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION')];
    // The old rule (hasVerifiedSendEvent) is exactly what recheck 6 caught: false here.
    expect(hasVerifiedSendEvent(events)).toBe(false);
    expect(makerPoSendProof(events, [decision('e1', 'confirmed')])).toBe('proven');
  });

  it('VERIFIED proves; rejected, absent or another paper\'s decision does not', () => {
    expect(makerPoSendProof([send('e1', 'VERIFIED')], [])).toBe('proven');
    expect(makerPoSendProof([send('e1', 'PENDING_MANUAL_VERIFICATION')], [decision('e1', 'rejected')])).toBe('unproven');
    expect(makerPoSendProof([send('e1', 'PENDING_MANUAL_VERIFICATION')], [])).toBe('unproven');
    expect(makerPoSendProof([send('e1', 'PENDING_MANUAL_VERIFICATION')], [decision('other-paper-event', 'confirmed')])).toBe('unproven');
    expect(makerPoSendProof([], [])).toBe('unproven');
  });

  it('a pending send whose decision records could not be read is unknown — never 未送信', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION')];
    expect(makerPoSendProof(events, [], new Set(['e1']))).toBe('unknown');
    // A readable confirmation still wins over an unread sibling.
    expect(makerPoSendProof([...events, send('e2', 'PENDING_MANUAL_VERIFICATION')], [decision('e2', 'confirmed')], new Set(['e1']))).toBe('proven');
    expect(cancelSendStateCopy('unknown', true).status).not.toContain('未送信');
  });

  it('the acknowledgement work follows the same judgement (CANCELLED + proven or unknown)', () => {
    expect(cancellationAcknowledgementMayBeRequired('CANCELLED', 'proven')).toBe(true);
    expect(cancellationAcknowledgementMayBeRequired('CANCELLED', 'unknown')).toBe(true);
    expect(cancellationAcknowledgementMayBeRequired('CANCELLED', 'unproven')).toBe(false);
    expect(cancellationAcknowledgementMayBeRequired('MAKER_PO_SENT_MANUALLY', 'proven')).toBe(false);
  });

  it('the cancel box and the dialog say the same thing, per judgement', () => {
    const proven = cancelSendStateCopy('proven', false);
    expect(proven.tone).toBe('danger');
    for (const text of [proven.status, proven.dialog]) {
      expect(text).toContain('送信ずみ');
      expect(text).toContain('取り消し承認（メーカー取消確認）');
      expect(text).toContain('送信の手動確認');
      expect(text).not.toContain('未送信');
      expect(text).not.toContain('すぐに');
    }
    const unsent = cancelSendStateCopy('unproven', false);
    expect(unsent.tone).toBe('ok');
    for (const text of [unsent.status, unsent.dialog]) expect(text).toContain('未送信');
    const pending = cancelSendStateCopy('unproven', true);
    expect(pending.tone).toBe('warning');
    for (const text of [pending.status, pending.dialog]) {
      expect(text).toContain('手動確認待ち');
      expect(text).not.toContain('未送信');
    }
    const unknown = cancelSendStateCopy('unknown', false);
    expect(unknown.tone).toBe('warning');
    expect(unknown.dialog).toContain('判定できません');
  });
});

describe('High-A: the capped project audit read is backed by a per-event read', () => {
  it('only pending sends without a known decision are asked about', () => {
    const events = [send('a', 'PENDING_MANUAL_VERIFICATION'), send('b', 'PENDING_MANUAL_VERIFICATION'), send('c', 'VERIFIED'),
      { id: 'd', eventType: 'MAKER_PO_CANCELLED' }];
    // A confirmation settles it; a rejection does not (the API allows a later confirm, review M2).
    expect(sendEventsWithoutKnownDecision(events, [decision('a', 'confirmed')])).toEqual(['b']);
    expect(sendEventsWithoutKnownDecision(events, [decision('a', 'rejected')])).toEqual(['a', 'b']);
  });

  it('reads one event by entityId; a confirmed row is a decision, a failed or trimmed read is unread', async () => {
    const auditRow = (eventId: string, afterState: Record<string, unknown> | undefined) => ({
      id: `audit-${eventId}`, action: 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', entityType: 'maker_po_event',
      entityId: eventId, occurredAt: '2026-11-18T01:00:01.000Z', actor: null,
      ...(afterState === undefined ? {} : { afterState })
    });
    callApi.mockImplementation(async (apiPath: string) => {
      const entityId = new URL(apiPath, 'http://x').searchParams.get('entityId');
      if (entityId === 'confirmed') {
        return { ok: true, status: 200, error: null, data: { events: [auditRow('confirmed', { makerPoEventId: 'confirmed', result: 'confirmed' })] } };
      }
      if (entityId === 'none') return { ok: true, status: 200, error: null, data: { events: [] } };
      if (entityId === 'trimmed') return { ok: true, status: 200, error: null, data: { events: [auditRow('trimmed', {})] } };
      return { ok: false, status: 500, error: 'down', data: null };
    });
    const read = await loadManualVerificationsForEvents('p/1', ['confirmed', 'none', 'trimmed', 'failed', 'confirmed']);
    expect(read.verifications.map((verification) => [verification.makerPoEventId, verification.result])).toEqual([['confirmed', 'confirmed']]);
    expect([...read.unreadEventIds].sort()).toEqual(['failed', 'trimmed']);
    // One request per distinct event, scoped by entityId, project id encoded.
    expect(callApi).toHaveBeenCalledTimes(4);
    expect(callApi.mock.calls.map((call) => String(call[0]))).toContain(
      '/api/projects/p%2F1/audit-history?entityType=maker_po_event&entityId=confirmed&limit=500'
    );
  });
});

describe('Low-6: the 取り消し承認 evidence choices', () => {
  const doc = (id: string, overrides: Record<string, unknown>) => ({
    id, documentType: 'acceptance_evidence', verificationStatus: 'verified', filmSupplyOrderId: 'order', makerPurchaseOrderId: 'po', ...overrides
  });
  it('only a verified acceptance evidence bound to the same order AND the same maker PO', () => {
    const documents = [
      doc('ok', {}),
      doc('other-po', { makerPurchaseOrderId: 'po-2' }),
      doc('order-only', { makerPurchaseOrderId: null }),
      doc('other-order', { filmSupplyOrderId: 'order-2' }),
      doc('unverified', { verificationStatus: 'unverified' }),
      doc('mismatch', { verificationStatus: 'mismatch' }),
      doc('send-evidence', { documentType: 'send_evidence' })
    ];
    expect(acknowledgementEvidenceDocuments(documents, 'order', 'po').map((document) => document.id)).toEqual(['ok']);
  });
});

describe('CANCELLED film order: badge tone, progress', () => {
  it('every film order status the API can answer has a deliberate tone; CANCELLED is ✕ blocked', () => {
    for (const status of [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES, FILM_ORDER_CANCELLATION_STATE]) {
      expect(statusTone('filmOrder', status), status).not.toBe('neutral');
    }
    expect(statusTone('filmOrder', 'CANCELLED')).toBe('blocked');
    expect(Object.keys(FILM_ORDER_STATUS_TONES)).toHaveLength(18);
  });

  it('progress of a cancelled order: its own phase, no step claimed', () => {
    const progress = orderProgress({ status: 'CANCELLED', statusHidden: false, lastNormalStatus: 'MAKER_PO_READY' });
    expect(progress).toMatchObject({ phase: 'cancelled', status: 'CANCELLED', currentStep: null, interruptedStep: null });
    expect(progress.marks.every((mark) => mark === 'unmarked')).toBe(true);
  });
});

describe('hold / cancellation review actions: required reason, dedicated endpoints', () => {
  it('a hold carries its reason; other targets send none', async () => {
    callApi.mockResolvedValue({ ok: true, status: 200, error: null, data: {} });
    expect(await transitionFilmSupplyOrderAction(null, form({ orderId: 'o', to: 'ON_HOLD', holdReason: '  ' })))
      .toEqual({ ok: false, message: '保留にする理由は必須です。' });
    expect(callApi).not.toHaveBeenCalled();
    await transitionFilmSupplyOrderAction(null, form({ orderId: 'o', to: 'ON_HOLD', holdReason: '確認待ち' }));
    await transitionFilmSupplyOrderAction(null, form({ orderId: 'o', to: 'CHANGE_REVIEW', holdReason: 'ignored' }));
    expect(callApi.mock.calls).toEqual([
      ['/api/film-supply-orders/o/transitions', { method: 'POST', body: { to: 'ON_HOLD', holdReason: '確認待ち' } }],
      ['/api/film-supply-orders/o/transitions', { method: 'POST', body: { to: 'CHANGE_REVIEW' } }]
    ]);
  });

  it('release posts the reason (the server picks the origin); resolve posts outcome + reason; a legacy target only when picked', async () => {
    callApi.mockResolvedValue({ ok: true, status: 200, error: null, data: {} });
    // The length is the API's to judge after its own normalisation (review L4):
    // a long multi-line reason is passed through, never refused here.
    const longReason = `${'保'.repeat(990)}\n${'留'.repeat(20)}`;
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: 'o', reason: longReason, resumeStatus: '' }))).toMatchObject({ ok: true });
    expect(await resolveCancellationReviewAction(null, form({ orderId: 'o', outcome: 'cancel', reason: '顧客都合', resumeStatus: 'DRAFT' }))).toMatchObject({ ok: true });
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: 'o2', reason: '古い保留', resumeStatus: 'PROOF_READY' }))).toMatchObject({ ok: true });
    expect(await resolveCancellationReviewAction(null, form({ orderId: 'o2', outcome: 'resume', reason: '再開', resumeStatus: 'PROOF_READY' }))).toMatchObject({ ok: true });
    expect(await resolveCancellationReviewAction(null, form({ orderId: 'o', outcome: '', reason: '顧客都合' })))
      .toEqual({ ok: false, message: '処理（再開する／取消で終了する）を選択してください。' });
    expect(await resolveCancellationReviewAction(null, form({ orderId: 'o', outcome: 'resume', reason: '' })))
      .toEqual({ ok: false, message: '取消確認の処理理由は必須です。' });
    expect(callApi.mock.calls).toEqual([
      ['/api/film-supply-orders/o/hold-release', { method: 'POST', body: { reason: longReason } }],
      // cancel never carries a resume target
      ['/api/film-supply-orders/o/cancellation-review-resolve', { method: 'POST', body: { outcome: 'cancel', reason: '顧客都合' } }],
      ['/api/film-supply-orders/o2/hold-release', { method: 'POST', body: { reason: '古い保留', resumeStatus: 'PROOF_READY' } }],
      ['/api/film-supply-orders/o2/cancellation-review-resolve', { method: 'POST', body: { outcome: 'resume', reason: '再開', resumeStatus: 'PROOF_READY' } }]
    ]);
  });

  it('the API refusal is shown verbatim (e.g. staff 403)', async () => {
    callApi.mockResolvedValue({ ok: false, status: 403, error: '権限がありません', data: null });
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: 'o', reason: '理由' }))).toMatchObject({ ok: false, message: '権限がありません', messageKo: null, code: null });
  });
});
