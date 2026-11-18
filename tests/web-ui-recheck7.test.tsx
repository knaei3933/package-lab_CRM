import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { japaneseStatusSurface } from '@kanei/core';

/**
 * Recheck 7 (demo-eml/server-rules-recheck7/RECHECK_REPORT.md) — web unit rules:
 * Medium-1 (no ③′ for a cancelled paper, no per-event audit read for it),
 * Medium-3 (cleanup-only cards, the 「これ以上の作業はありません」 wording only
 * when the maker paper is settled, the CR warning), Low-7 (a)–(f).
 * The real-API parity of the same rules is tests/web-ui-recheck7-parity.test.tsx.
 */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project',
  loadSessionUser: async () => null
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const {
  acknowledgementBlocksCreation,
  acknowledgementOwed,
  cancellationAcknowledgementFlags,
  cancelSendStateCopy,
  cleanupNextActionForStatus,
  loadMakerPaperCleanup,
  makerPaperCleanupSummary,
  makerPoOrderClosure,
  makerPoSendProof,
  pendingManualVerificationEvents,
  unsettledSendsOfCancelledPaper
} = await import('../apps/web/src/lib/maker-po-data.js');
const { makerPoStages, stageHeadline } = await import('../apps/web/src/lib/maker-po-stage.js');
const { nextActionForOrder } = await import('../apps/web/src/lib/project-data.js');
const {
  CANCELLED_ORDER_CLEANUP_NOTICE,
  CANCELLED_ORDER_NOTICE,
  CANCELLED_ORDER_UNREAD_NOTICE,
  transitionChoicesFor
} = await import('../apps/web/src/lib/transitions.js');
const { transitionFilmSupplyOrderAction } = await import('../apps/web/src/app/actions.js');
const { fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');
const { ChoiceDisclosure, ChoiceToneActionForm } = await import('../apps/web/src/components/ChoiceDrivenForm.js');

type EventRow = Parameters<typeof makerPoSendProof>[0][number];
type Verification = Parameters<typeof makerPoSendProof>[1][number];
type AuditRow = Parameters<typeof cancellationAcknowledgementFlags>[0][number];

const send = (id: string, verificationStatus: string): EventRow =>
  ({ id, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus });
const cancelEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_PO_CANCELLED', verificationStatus: 'UNVERIFIED' });
const ackEvent = (id: string): EventRow => ({ id, eventType: 'MAKER_CANCELLATION_ACKNOWLEDGED', verificationStatus: 'UNVERIFIED' });
const decision = (makerPoEventId: string, result: 'confirmed' | 'rejected'): Verification => ({
  makerPoEventId, result, verifierName: '代表者', verifiedAt: '2026-11-18T01:00:00.000Z', reasonNote: '原本確認', recordedAt: '2026-11-18T01:00:01.000Z'
});
const cancelAudit = (entityId: string, flag: unknown): AuditRow => ({
  id: `a-${entityId}`, action: 'MAKER_PO_CANCELLED', entityType: 'maker_po_event', entityId,
  beforeState: { status: 'APPROVED_FOR_MANUAL_SEND' },
  afterState: { status: 'CANCELLED', newMakerPoRequiresCancellationAcknowledgement: flag },
  occurredAt: '2026-11-18T02:00:00.000Z', requestMetadata: null, actor: null
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  callApi.mockReset();
});

describe('Medium-1: a cancelled paper never offers ③′', () => {
  it('pending sends of a cancelled paper are not ③′ work; they are listed read-only', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')];
    expect(pendingManualVerificationEvents(events, [], 'CANCELLED')).toEqual([]);
    expect(unsettledSendsOfCancelledPaper(events, [], 'CANCELLED').map((event) => event.id)).toEqual(['e1']);
    // A live paper keeps ③′ exactly as before; nothing is listed read-only.
    expect(pendingManualVerificationEvents(events, [], 'APPROVED_FOR_MANUAL_SEND').map((event) => event.id)).toEqual(['e1']);
    expect(unsettledSendsOfCancelledPaper(events, [], 'APPROVED_FOR_MANUAL_SEND')).toEqual([]);
    // A decision recorded before the cancel settles it: no note.
    expect(unsettledSendsOfCancelledPaper(events, [decision('e1', 'rejected')], 'CANCELLED')).toEqual([]);
  });

  it('the API\'s own cancel classification and the 取り消し承認 settle a cancelled paper\'s proof without a per-event read', () => {
    const events = [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')];
    const flags = cancellationAcknowledgementFlags([cancelAudit('c1', true), cancelAudit('c2', false), cancelAudit('c3', 'yes')]);
    expect([...flags.entries()]).toEqual([['c1', true], ['c2', false]]);
    expect(makerPoSendProof(events, [], new Set(), flags)).toBe('proven');
    // A false flag is not proof of "unsent" by itself (pre-cc9144f cancels ignored manual checks)…
    expect(makerPoSendProof(events, [], new Set(), new Map([['c1', false]]))).toBe('unproven');
    expect(makerPoSendProof(events, [decision('e1', 'confirmed')], new Set(), new Map([['c1', false]]))).toBe('proven');
    // …and an unread decision stays unknown.
    expect(makerPoSendProof(events, [], new Set(['e1']), new Map([['c1', false]]))).toBe('unknown');
    // Recheck 8 Medium-B: since 7bd0bca an acknowledgement event does not prove a
    // send (decision (a) stores the post-delivery confirmation under it too).
    expect(makerPoSendProof([...events, ackEvent('k1')], [])).toBe('unproven');
  });
});

describe('Medium-3: cleanup of a cancelled or frozen order', () => {
  it('closure: CANCELLED is cancelled; ON_HOLD, CHANGE_REVIEW, CANCELLATION_REVIEW are frozen; the maker chain is neither', () => {
    expect(makerPoOrderClosure('CANCELLED')).toBe('cancelled');
    for (const status of ['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW']) expect(makerPoOrderClosure(status)).toBe('frozen');
    for (const status of ['MAKER_PO_READY', 'MAKER_PO_SENT_MANUALLY', 'FILM_DELIVERED']) expect(makerPoOrderClosure(status)).toBeNull();
    expect(makerPoOrderClosure(null)).toBeNull();
  });

  it('live paper, or a cancelled proven send without its 取り消し承認, is cleanup; settled paper is none; an unread proof is unknown', () => {
    const live = { status: 'APPROVED_FOR_MANUAL_SEND', sendProof: 'unproven', acknowledgementRecorded: false } as const;
    const owed = { status: 'CANCELLED', sendProof: 'proven', acknowledgementRecorded: false } as const;
    const acked = { status: 'CANCELLED', sendProof: 'proven', acknowledgementRecorded: true } as const;
    const internal = { status: 'CANCELLED', sendProof: 'unproven', acknowledgementRecorded: false } as const;
    const unread = { status: 'CANCELLED', sendProof: 'unknown', acknowledgementRecorded: false } as const;
    expect(acknowledgementOwed(owed)).toBe('required');
    expect(acknowledgementOwed(unread)).toBe('maybe');
    expect(acknowledgementOwed(acked)).toBeNull();
    expect(acknowledgementOwed(internal)).toBeNull();
    expect(makerPaperCleanupSummary([live, internal])).toMatchObject({ state: 'cleanup', livePapers: 1, cancellablePapers: 1, acknowledgementPapers: 0 });
    expect(makerPaperCleanupSummary([owed])).toMatchObject({ state: 'cleanup', livePapers: 0, acknowledgementPapers: 1 });
    expect(makerPaperCleanupSummary([acked, internal])).toMatchObject({ state: 'none', livePapers: 0, acknowledgementPapers: 0 });
    expect(makerPaperCleanupSummary([unread]).state).toBe('unknown');
    expect(makerPaperCleanupSummary([], true).state).toBe('unknown');
    expect(makerPaperCleanupSummary([]).state).toBe('none');
    // Low-7 (f): only a required acknowledgement blocks creation (unknown is left to the API).
    expect(acknowledgementBlocksCreation([owed])).toBe(true);
    expect(acknowledgementBlocksCreation([unread, acked, internal])).toBe(false);
  });

  it('loadMakerPaperCleanup reads the list, the cancelled trails, and the audit only when a send needs it', async () => {
    callApi.mockImplementation(async (path: string) => {
      if (path === '/api/film-supply-orders/o-live/maker-purchase-orders') {
        return { ok: true, status: 200, data: { makerPurchaseOrders: [{ id: 'p-live', status: 'APPROVED_FOR_MANUAL_SEND' }] }, error: null };
      }
      if (path === '/api/film-supply-orders/o-done/maker-purchase-orders') {
        return { ok: true, status: 200, data: { makerPurchaseOrders: [{ id: 'p-int', status: 'CANCELLED' }, { id: 'p-ack', status: 'CANCELLED' }] }, error: null };
      }
      if (path === '/api/film-supply-orders/o-fail/maker-purchase-orders') return { ok: false, status: 403, data: null, error: '権限がありません' };
      if (path === '/api/maker-purchase-orders/p-int') {
        return { ok: true, status: 200, data: { purchaseOrder: { id: 'p-int', status: 'CANCELLED' }, events: [send('e1', 'PENDING_MANUAL_VERIFICATION'), cancelEvent('c1')] }, error: null };
      }
      if (path === '/api/maker-purchase-orders/p-ack') {
        return { ok: true, status: 200, data: { purchaseOrder: { id: 'p-ack', status: 'CANCELLED' }, events: [send('e2', 'VERIFIED'), cancelEvent('c2'), ackEvent('k2')] }, error: null };
      }
      if (path.startsWith('/api/projects/project/audit-history?entityType=maker_po_event&limit=200')) {
        return { ok: true, status: 200, data: { events: [cancelAudit('c1', false)] }, error: null };
      }
      throw new Error(`unexpected read ${path}`);
    });
    const summary = await loadMakerPaperCleanup('project', ['o-live', 'o-done', 'o-fail']);
    expect(summary['o-live']).toMatchObject({ state: 'cleanup', livePapers: 1 });
    expect(summary['o-done']).toMatchObject({ state: 'none', livePapers: 0, acknowledgementPapers: 0 });
    expect(summary['o-fail']?.state).toBe('unknown');
    // The window came back whole (1 < 200): no per-event read for e1.
    expect(callApi.mock.calls.map(([path]) => path).filter((path: string) => path.includes('entityId='))).toEqual([]);
  });

  it('次にやること for CANCELLED says 「これ以上の作業はありません」 only when the maker paper is settled', () => {
    const labels = japaneseStatusSurface();
    const order = { id: 'o1', code: 'FSO-C', status: 'CANCELLED', sevenPurchaseOrderId: null, lineCount: 1, lines: [],
      detailsHidden: false, statusHidden: false, lastNormalStatus: null, createdAt: '', updatedAt: '' };
    const workspace = (cleanup?: Record<string, ReturnType<typeof makerPaperCleanupSummary>>) =>
      ({ labels, sevenPurchaseOrders: [], revisions: [], makerPaperCleanup: cleanup });
    const settled = nextActionForOrder(order, workspace({ o1: makerPaperCleanupSummary([]) }), 'admin');
    expect(settled.text).toBe('この発注は取消で終了しています。これ以上の作業はありません。');
    const left = nextActionForOrder(order, workspace({
      o1: makerPaperCleanupSummary([{ status: 'MAKER_PO_SENT_MANUALLY', sendProof: 'proven', acknowledgementRecorded: false }])
    }), 'admin');
    expect(left).toMatchObject({ owner: '代表者', screens: ['/maker-po'], operation: 'maker_po:cancel' });
    expect(left.text).toContain('メーカー発注書の整理が残っています（取り消されていない発注書 1件）');
    expect(left.text).not.toContain('これ以上の作業はありません');
    const unread = nextActionForOrder(order, workspace(), 'staff');
    expect(unread.text).toContain('残っていないかは、メーカー発注画面で確認してください');
    expect(unread.text).not.toContain('これ以上の作業はありません');
  });

  it('the transition cell of a CANCELLED order: the plain notice only when settled', () => {
    const label = (key: string) => key;
    expect(transitionChoicesFor('CANCELLED', label, null, 'none').emptyReason).toBe(CANCELLED_ORDER_NOTICE);
    expect(transitionChoicesFor('CANCELLED', label, null, 'cleanup').emptyReason).toBe(CANCELLED_ORDER_CLEANUP_NOTICE);
    expect(transitionChoicesFor('CANCELLED', label, null, 'unknown').emptyReason).toBe(CANCELLED_ORDER_UNREAD_NOTICE);
    expect(transitionChoicesFor('CANCELLED', label).emptyReason).toBe(CANCELLED_ORDER_UNREAD_NOTICE);
    expect(CANCELLED_ORDER_CLEANUP_NOTICE).not.toContain('これ以上進める先はありません');
  });

  it('cancel copy on a closed order never promises the ordering step re-opens', () => {
    for (const closure of ['cancelled', 'frozen'] as const) {
      for (const [proof, pending] of [['proven', false], ['unproven', true], ['unproven', false], ['unknown', false]] as const) {
        const copy = cancelSendStateCopy(proof, pending, closure);
        expect(copy.status + copy.dialog, `${closure}/${proof}/${pending}`).not.toContain('再度開きます');
      }
    }
    // A pending send on a closed order: ③′ cannot be recorded first (the API refuses it there).
    expect(cancelSendStateCopy('unproven', true, 'frozen').status).toContain('送信の手動確認を記録できず');
    expect(cancelSendStateCopy('unproven', true, 'frozen').status).not.toContain('先に「③′ 送信の手動確認」を記録');
    // Unchanged on a live order.
    expect(cancelSendStateCopy('unproven', false).status).toContain('すぐに発注書の作成ステップが再度開きます');
  });

  it('the paper rows of a closed order name the cleanup, not a replacement paper', () => {
    expect(cleanupNextActionForStatus('CANCELLED', 'admin', 'cancelled')).toContain('新しい発注書は作成しません');
    expect(cleanupNextActionForStatus('CANCELLED', 'admin', 'cancelled')).not.toContain('訂正後の発注書を新しく作成');
    expect(cleanupNextActionForStatus('APPROVED_FOR_MANUAL_SEND', 'admin', 'frozen')).toContain('発注書の取り消しだけを記録できます');
    expect(cleanupNextActionForStatus('SEND_UNVERIFIED', 'admin', 'cancelled')).toContain('この画面から取り消せません');
  });
});

describe('Low-7', () => {
  it('(b) the hold next action names the MAKER_PO_READY recovery; a frozen order with cleanup links the maker screen', () => {
    const labels = japaneseStatusSurface();
    const order = { id: 'o1', code: 'FSO-H', status: 'ON_HOLD', sevenPurchaseOrderId: null, lineCount: 1, lines: [],
      detailsHidden: false, statusHidden: false, lastNormalStatus: 'MAKER_PO_SENT_MANUALLY', createdAt: '', updatedAt: '' };
    const plain = nextActionForOrder(order, { labels, sevenPurchaseOrders: [], revisions: [] }, 'admin');
    expect(plain.text).toContain('残っている発注書がない場合は「製造先発注準備完了」に戻ります');
    expect(plain.screens).toEqual(['/orders']);
    const withCleanup = nextActionForOrder(order, {
      labels, sevenPurchaseOrders: [], revisions: [],
      makerPaperCleanup: { o1: makerPaperCleanupSummary([{ status: 'APPROVED_FOR_MANUAL_SEND', sendProof: 'unproven', acknowledgementRecorded: false }]) }
    }, 'admin');
    expect(withCleanup.screens).toEqual(['/orders', '/maker-po']);
    expect(withCleanup.text).toContain('解除の前でも、メーカー発注画面で取り消し・取り消し承認を記録できます');
  });

  it('(c) the API\'s Korean hold-reason refusals reach the screen in Japanese (by code)', async () => {
    callApi.mockResolvedValueOnce({
      ok: false, status: 422, data: { error: '보류 사유는 1000자 이하로 입력해야 합니다', code: 'HOLD_REASON_TOO_LONG' }, error: '보류 사유는 1000자 이하로 입력해야 합니다'
    });
    const state = await transitionFilmSupplyOrderAction(null, form({ orderId: 'o1', to: 'ON_HOLD', holdReason: 'x' }));
    expect(state).toEqual({ ok: false, message: '保留にする理由は1000字以内で入力してください。' });
    callApi.mockResolvedValueOnce({ ok: false, status: 422, data: { error: 'その他', code: 'OTHER' }, error: 'その他' });
    expect(await transitionFilmSupplyOrderAction(null, form({ orderId: 'o1', to: 'ON_HOLD', holdReason: 'x' })))
      .toEqual({ ok: false, message: 'その他' });
  });

  it('(d) both hold-reason refusals name the folded field, so the form opens and focuses it', () => {
    expect(fieldForActionMessage('保留にする理由は必須です。')).toBe('holdReason');
    expect(fieldForActionMessage('保留にする理由は1000字以内で入力してください。')).toBe('holdReason');
  });

  it('(d) the hold-reason disclosure renders folded and optional until 「保留中」 is chosen (server markup)', () => {
    const html = renderToStaticMarkup(createElement(ChoiceDisclosure, {
      selectName: 'to', value: 'ON_HOLD', fieldName: 'holdReason', summary: '理由',
      children: createElement('textarea', { name: 'holdReason' })
    }));
    expect(html).toBe('<details><summary style="font-size:13px;cursor:pointer">理由</summary><textarea name="holdReason"></textarea></details>');
  });

  it('(e) the review form\'s button is not danger-toned before 「取消で終了する」 is chosen', () => {
    const html = renderToStaticMarkup(createElement(ChoiceToneActionForm, {
      selectName: 'outcome', dangerValue: 'cancel', action: async () => ({ ok: true, message: '' }),
      submitLabel: '処理する', confirm: { title: 't', body: 'b' },
      children: createElement('select', { name: 'outcome' })
    }));
    expect(html).toContain('background:var(--primary)');
    expect(html).not.toContain('background:var(--danger)');
  });

  it('(f) every paper cancelled and a 取り消し承認 owed: the headline asks for it, not for a new paper', () => {
    const paper = (acknowledgementOwedValue: 'required' | 'maybe' | null) => ({
      po: { id: 'p1', status: 'CANCELLED', ceoApprovedAt: '2026-11-18T00:00:00.000Z', createdAt: '2026-11-18T00:00:00.000Z' },
      events: [send('e1', 'VERIFIED'), cancelEvent('c1')],
      pendingVerification: false,
      confirmedVerification: null,
      acknowledgementOwed: acknowledgementOwedValue
    });
    const required = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('required')] });
    expect(stageHeadline(required)).toBe('取り消し済み（取り消し承認の記録待ち。新しい発注書はその後に作成）');
    expect(stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('maybe')] })))
      .toBe('取り消し済み（取り消し承認が必要かどうか確認できません）');
    expect(stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper(null)] })))
      .toBe('取り消し済み（新しい発注書の作成待ち）');
  });
});
