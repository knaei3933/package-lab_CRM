import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * P0 integration (p0/web + p0/server): the web follows the server contract —
 * R02 issuer filter + shared-evidence exception, R11 (no verifier/time inputs,
 * nothing of the kind sent), R12 (evidenceNote kept), R01 transition warning,
 * the 支払条件 change history read from the audit rows.
 */
const state = vi.hoisted(() => ({ selected: 'project-a' as string | null }));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => state.selected,
  loadSession: async () => ({ kind: 'anonymous' }),
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));

const actions = await import('../apps/web/src/app/actions.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const { ApprovalDecisionForm, matchesOrganization } = await import('../apps/web/src/components/ApprovalDecisionForm.js');
const { RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { EXPECTED_TERMS_MISSING_MESSAGE, PAYMENT_TERMS_LOCKED_MESSAGES, SHARED_EVIDENCE_REASON_MESSAGE, fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');
const { shouldRenewSubmitKey } = await import('../apps/web/src/lib/project-context.js');
const { isSettledRefusal, refusalState } = await import('../apps/web/src/lib/action-result.js');
const { ERROR_DICTIONARY } = await import('../apps/web/src/lib/error-dictionary-data.js');

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}
const ok = (data: unknown = { id: 'x' }) => ({ ok: true, status: 200, data, error: null, code: null });
const lastBody = () => (callApi.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> } | undefined)?.body;

beforeEach(() => {
  state.selected = 'project-a';
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
});

describe('R02: approval evidence follows the approving organization', () => {
  const customerDoc = { value: 'v-c', label: 'customer.pdf', issuerEntity: 'customer_generated' };
  const sevenDoc = { value: 'v-s', label: 'seven.pdf', issuerEntity: 'seven' };
  const kaneiDoc = { value: 'v-k', label: 'kanei.pdf', issuerEntity: 'kanei' };

  it('顧客 sees only 顧客作成, セブン化学 only セブン化学; kanei never', () => {
    expect([customerDoc, sevenDoc, kaneiDoc].filter((c) => matchesOrganization(c, 'customer', false)).map((c) => c.value)).toEqual(['v-c']);
    expect([customerDoc, sevenDoc, kaneiDoc].filter((c) => matchesOrganization(c, 'seven', false)).map((c) => c.value)).toEqual(['v-s']);
  });

  it('the shared exception offers 顧客作成 and セブン化学 evidence, still never kanei', () => {
    expect([customerDoc, sevenDoc, kaneiDoc].filter((c) => matchesOrganization(c, 'seven', true)).map((c) => c.value)).toEqual(['v-c', 'v-s']);
  });

  it('the form lists only the chosen organization\'s evidence, without the old 「両組織で同じ版を引用します」 label', () => {
    const html = renderToStaticMarkup(
      <ApprovalDecisionForm
        action={async () => ({ ok: true, message: '' })}
        revisionId="rev-1"
        designKey="label-front"
        evidenceChoices={[customerDoc, sevenDoc]}
        evidenceSourceChoices={[{ value: 'email', label: 'メール' }]}
        defaultEventTime="2026-11-20T10:00"
      />
    );
    expect(html).toContain('>customer.pdf<');
    expect(html).not.toContain('>seven.pdf<');
    expect(html).not.toContain('両組織で同じ版を引用します');
    expect(html).toContain('name="sharedEvidence"');
  });

  it('sharedEvidence without a reason is refused before the API, mapped to the reason field', async () => {
    const result = await actions.recordArtworkApprovalAction(null, form({
      revisionId: 'rev-1', organization: 'seven', evidenceDocumentVersionId: 'v-c', evidenceIdentifier: 'MSG-ID-0001',
      evidenceSource: 'email', eventTime: '2026-11-20T10:00:00+09:00', sharedEvidence: 'on'
    }));
    expect(result).toEqual({ ok: false, message: SHARED_EVIDENCE_REASON_MESSAGE });
    expect(fieldForActionMessage(SHARED_EVIDENCE_REASON_MESSAGE)).toBe('sharedEvidenceReason');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('sharedEvidence with a reason is sent as the server contract asks', async () => {
    await actions.recordArtworkApprovalAction(null, form({
      revisionId: 'rev-1', organization: 'seven', evidenceDocumentVersionId: 'v-c', evidenceIdentifier: 'MSG-ID-0001',
      evidenceSource: 'email', eventTime: '2026-11-20T10:00:00+09:00', sharedEvidence: 'on', sharedEvidenceReason: '1通のメールに両社の承認'
    }));
    expect(lastBody()).toMatchObject({ sharedEvidence: true, sharedEvidenceReason: '1通のメールに両社の承認' });
  });

  it('without the tick nothing about sharing is sent', async () => {
    await actions.recordArtworkApprovalAction(null, form({
      revisionId: 'rev-1', organization: 'customer', evidenceDocumentVersionId: 'v-c', evidenceIdentifier: 'MSG-ID-0001',
      evidenceSource: 'email', eventTime: '2026-11-20T10:00:00+09:00'
    }));
    expect(lastBody()).not.toHaveProperty('sharedEvidence');
  });
});

describe('R11: the verifier and the time are the API\'s', () => {
  it('approval-evidence manual check: only result and reason are sent', async () => {
    await actions.verifyEvidenceManualAction(null, form({ approvalEventId: 'ev-1', result: 'confirmed', reasonNote: '原本に記載あり', verifierName: '偽名', verifiedAt: '2020-01-01T00:00:00+09:00' }));
    expect(lastBody()).toEqual({ result: 'confirmed', reasonNote: '原本に記載あり' });
  });

  it('send manual check: only result and reason are sent', async () => {
    await makerActions.verifyMakerPoSendAction(null, form({ eventId: 'e-1', poId: 'po-1', result: 'confirmed', reasonNote: '送信済みフォルダの原本', verifierName: '偽名' }));
    expect(lastBody()).toEqual({ result: 'confirmed', reasonNote: '送信済みフォルダの原本' });
  });

  it('a missing reason is still refused', async () => {
    const result = await actions.verifyEvidenceManualAction(null, form({ approvalEventId: 'ev-1', result: 'confirmed' }));
    expect(result.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('R12 + R01: transitions', () => {
  it('the reason to move on without evidence is sent as evidenceNote', async () => {
    await actions.transitionFilmSupplyOrderAction(null, form({ orderId: 'o-1', to: 'PROOF_READY', evidenceNote: '証跡は明日届く' }));
    expect(lastBody()).toEqual({ to: 'PROOF_READY', evidenceNote: '証跡は明日届く' });
  });

  it('no note, no evidenceNote', async () => {
    await actions.transitionFilmSupplyOrderAction(null, form({ orderId: 'o-1', to: 'PROOF_READY' }));
    expect(lastBody()).toEqual({ to: 'PROOF_READY' });
  });

  it('a PAYMENT_TERMS_UNDETERMINED warning is said in the success line', async () => {
    callApi.mockResolvedValue(ok({ id: 'o-1', warnings: [{ code: 'PAYMENT_TERMS_UNDETERMINED' }] }));
    const result = await actions.transitionFilmSupplyOrderAction(null, form({ orderId: 'o-1', to: 'SEVEN_PO_VERIFIED' }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('支払条件が「未定」です');
  });
});

const SNAP = 'ef56'.repeat(16);
describe('p0-server review contract (aac8634)', () => {
  // P4 L-3: approveMakerPoAction (the old /maker-po 代表承認 form's action) is deleted — the approval is recorded by the
  // order screen's card (approval-actions.ts, tests/web-p1-stage2-approval-actions.test.ts), which sends the terms stamp too.
  it('an upload warned SAME_CONTENT_OTHER_ISSUER says so next to 「記録しました」', async () => {
    callApi.mockResolvedValue(ok({ document: { id: 'd-1' }, version: { id: 'v-1' }, warnings: [{ code: 'SAME_CONTENT_OTHER_ISSUER', message: 'x' }] }));
    const result = await actions.uploadDocumentAction(null, form({ filename: 'a.txt', contentBase64: 'YQ==', documentType: 'film_quote_kanei', issuerEntity: 'kanei', contentType: 'text/plain' }));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^記録しました。注意: 同じ内容の承認証跡が別の発行元/);
    expect(result.changedId).toBe('d-1');
  });

  it('an upload without warnings is a plain success', async () => {
    callApi.mockResolvedValue(ok({ document: { id: 'd-2' }, version: { id: 'v-2' }, warnings: [] }));
    const result = await actions.uploadDocumentAction(null, form({ filename: 'a.txt', contentBase64: 'YQ==', documentType: 'film_quote_kanei', issuerEntity: 'kanei', contentType: 'text/plain' }));
    expect(result.message).toBe('記録しました。');
  });
});


describe('review H1: the Idempotency-Key lives until the submit is over', () => {
  it('renewed at the start, after a success and after a settled refusal; kept otherwise', () => {
    expect(shouldRenewSubmitKey(null)).toBe(true);
    expect(shouldRenewSubmitKey({ ok: true })).toBe(true);
    expect(shouldRenewSubmitKey({ ok: false, settled: true })).toBe(true);
    expect(shouldRenewSubmitKey({ ok: false })).toBe(false);
    expect(shouldRenewSubmitKey({ ok: false, settled: false })).toBe(false);
  });

  it('only an answered 4xx is settled: timeout, unreachable and 5xx keep the key', () => {
    expect(isSettledRefusal({ status: 422, failure: null })).toBe(true);
    expect(isSettledRefusal({ status: 409, failure: null })).toBe(true);
    expect(isSettledRefusal({ status: 0, failure: 'timeout' })).toBe(false);
    expect(isSettledRefusal({ status: 0, failure: 'unreachable' })).toBe(false);
    expect(isSettledRefusal({ status: 500, failure: null })).toBe(false);
    expect(isSettledRefusal({ status: 503, failure: null })).toBe(false);
    expect(refusalState({ status: 0, failure: 'timeout', error: 'x', code: 'API_TIMEOUT' }).settled).toBe(false);
    expect(refusalState({ status: 422, failure: null, error: 'x', code: 'DOCUMENT_TOO_LARGE' }).settled).toBe(true);
  });

  it('every write form path: a timed-out write (any action) is not settled', async () => {
    callApi.mockResolvedValue({ ok: false, status: 0, data: null, error: 'システムが応答していません。', errorKo: null, code: 'API_TIMEOUT', failure: 'timeout' });
    const results = [
      await actions.recordDeliveryAction(null, form({ kind: 'film', orderId: 'o-1', lineId: 'l-1', unit: 'meters', deliveredQuantity: '10' })),
      await actions.transitionFilmSupplyOrderAction(null, form({ orderId: 'o-1', to: 'PROOF_READY' })),
      await makerActions.updatePaymentTermsAction(null, form({ orderId: 'o-1', paymentTerms: 'prepaid' })),
      await makerActions.recordProvisionalAcceptanceAction(null, form({ poId: 'po-1' }))
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(shouldRenewSubmitKey(result)).toBe(false);
    }
  });

  it('a refusal made on the web (the API never asked) keeps the key too', async () => {
    const result = await actions.recordDeliveryAction(null, form({ kind: 'film', orderId: 'o-1', lineId: '', unit: 'meters', deliveredQuantity: '10' }));
    expect(result.ok).toBe(false);
    expect(shouldRenewSubmitKey(result)).toBe(false);
  });
});

describe('review M2: PAYMENT_TERMS_LOCKED says the real rule', () => {
  it('never 「下書きの間だけ」, in the dictionary or by reason', () => {
    expect(ERROR_DICTIONARY.PAYMENT_TERMS_LOCKED!.ja).not.toContain('下書き');
    expect(ERROR_DICTIONARY.PAYMENT_TERMS_LOCKED!.ja).toContain('代表承認');
  });

  it('by reason: 代表承認済み → cancel and re-create; 保留・レビュー → resolve first', async () => {
    for (const reason of ['ceo_approved', 'order_frozen'] as const) {
      callApi.mockResolvedValue({ ok: false, status: 422, data: { code: 'PAYMENT_TERMS_LOCKED', reason }, error: ERROR_DICTIONARY.PAYMENT_TERMS_LOCKED!.ja, errorKo: null, code: 'PAYMENT_TERMS_LOCKED', failure: null });
      const result = await actions.updateFilmPaymentTermsAction(null, form({ orderId: 'o-1', paymentTerms: 'prepaid' }));
      expect(result.message).toBe(PAYMENT_TERMS_LOCKED_MESSAGES[reason]);
      expect(result.settled).toBe(true);
    }
    expect(PAYMENT_TERMS_LOCKED_MESSAGES.ceo_approved).toContain('取り消して作り直して');
    expect(PAYMENT_TERMS_LOCKED_MESSAGES.order_frozen).toContain('保留');
  });
});


describe('review NM1: IDEMPOTENCY_KEY_REUSED locks the form until the operator confirms', async () => {
  const { FeedbackForm, FormFeedbackContext, FormResult, SubmitLock } = await import('../apps/web/src/components/form-feedback.js');
  const { isKeyReuseLocked, locksForKeyReuse } = await import('../apps/web/src/lib/project-context.js');
  const reused = { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', message: '前回の送信が処理済みの可能性があります。一覧で登録内容を確認してから、必要なら修正してください。', messageKo: '이전 전송이 이미 처리되었을 수 있습니다. 목록에서 등록 내용을 확인한 뒤 필요하면 수정하세요.' };

  it('not settled, key kept, the form locks', () => {
    expect(isSettledRefusal({ status: 422, failure: null, code: 'IDEMPOTENCY_KEY_REUSED' })).toBe(false);
    expect(shouldRenewSubmitKey({ ok: false, settled: true, code: 'IDEMPOTENCY_KEY_REUSED' })).toBe(false);
    expect(locksForKeyReuse(reused)).toBe(true);
    expect(locksForKeyReuse({ ok: false, code: 'API_TIMEOUT' })).toBe(false);
    expect(refusalState({ status: 422, failure: null, error: reused.message, errorKo: reused.messageKo, code: 'IDEMPOTENCY_KEY_REUSED' }).settled).toBe(false);
  });

  it('the lock holds from the render the result arrives in, until that very result is confirmed', () => {
    const later = { ...reused };
    expect(isKeyReuseLocked(reused, null)).toBe(true);
    expect(isKeyReuseLocked(reused, reused)).toBe(false); // the operator pressed 「一覧を確認しました」
    expect(isKeyReuseLocked(later, reused)).toBe(true); // a new REUSED answer locks again
    expect(isKeyReuseLocked({ ok: false, code: 'API_TIMEOUT', message: 'x' }, null)).toBe(false);
    expect(isKeyReuseLocked(null, null)).toBe(false);
  });

  it('the dictionary says 「処理済みの可能性」 (ja + ko)', () => {
    expect(ERROR_DICTIONARY.IDEMPOTENCY_KEY_REUSED!.ja).toBe(reused.message);
    expect(ERROR_DICTIONARY.IDEMPOTENCY_KEY_REUSED!.ko).toBe(reused.messageKo);
  });

  it('while locked: both languages, the confirm button, and every submit button disabled', () => {
    const html = renderToStaticMarkup(
      <FormFeedbackContext.Provider value={{ errors: {}, summaryCount: 0, keyReuseLocked: true, startNewIntent: () => undefined }}>
        <SubmitLock>{(locked) => <button type="submit" disabled={locked || undefined}>納品を記録する</button>}</SubmitLock>
        <FormResult state={reused} />
      </FormFeedbackContext.Provider>
    );
    expect(html).toContain(reused.message);
    expect(html).toContain('lang="ko"');
    expect(html).toContain(reused.messageKo);
    expect(html).toContain('一覧を確認しました（新しい入力として送信できるようにする）');
    expect(html).toMatch(/<button type="submit" disabled="">納品を記録する<\/button>/);
  });

  it('a delivery form renders the shell (FeedbackForm) every write form shares', () => {
    const html = renderToStaticMarkup(<FeedbackForm action={() => undefined} state={null}><span>x</span></FeedbackForm>);
    expect(html).toContain('<form');
  });
});
