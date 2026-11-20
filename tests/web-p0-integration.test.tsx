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
const { SHARED_EVIDENCE_REASON_MESSAGE, fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');

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
