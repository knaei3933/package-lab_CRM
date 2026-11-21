import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/**
 * UI batch E2 (demo-eml/ui-batch-e2/REPORT.md) — web side of server follow-up
 * db4bd88 (demo-eml/server-batch-e2/API_CONTRACT.md):
 * - staff now reads a document's originalFilename and issuerEntity (the
 *   redaction mirror itself is pinned against the API's own list by
 *   tests/web-redaction-labels.test.ts; the workspace reading by
 *   tests/web-workspace-redaction.test.ts);
 * - the 422 DELIVERY_UNIT_MISMATCH refusal reaches the screen in Japanese and
 *   marks the 単位 field.
 * The real-API parity of both is in tests/web-ui-batch-e-parity.test.tsx (E2).
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

const { recordDeliveryAction } = await import('../apps/web/src/app/actions.js');
const { fieldForActionMessage, resolveActionFieldError } = await import('../apps/web/src/lib/form-messages.js');
const { STAFF_VISIBLE_STATE_KEYS, VIEWER_VISIBLE_STATE_KEYS, isFieldHiddenByRole, displayText, HIDDEN_BY_ROLE_LABEL } =
  await import('../apps/web/src/lib/redaction.js');
const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', 'project'); // P0 R03: the form was drawn for the selected project
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const mismatch = (lineUnit: string) => ({
  ok: false,
  status: 422,
  data: { error: `納品単位は明細単位（${lineUnit}）と一致させてください`, code: 'DELIVERY_UNIT_MISMATCH' },
  error: `納品単位は明細単位（${lineUnit}）と一致させてください`
});

beforeEach(() => {
  callApi.mockReset();
});

describe('E2: staff reads the document file name and issuer (db4bd88)', () => {
  it('the staff mirror carries both keys; the viewer mirror gains no document identity', () => {
    expect(STAFF_VISIBLE_STATE_KEYS).toEqual(expect.arrayContaining(['originalFilename', 'issuerEntity']));
    // UI batch E3: the 支払条件 joined the viewer list by the representative's decision.
    expect([...VIEWER_VISIBLE_STATE_KEYS]).toEqual(['status', 'readinessState', 'isReady', 'paymentTerms']);
    expect(VIEWER_VISIBLE_STATE_KEYS).not.toContain('originalFilename');
    expect(VIEWER_VISIBLE_STATE_KEYS).not.toContain('issuerEntity');
    // Amounts, hashes, storage paths and the viewer's order code stay off.
    for (const key of ['sha256', 'storagePath', 'byteSize', 'amount', 'unitPrice']) {
      expect(STAFF_VISIBLE_STATE_KEYS).not.toContain(key);
    }
    expect(VIEWER_VISIBLE_STATE_KEYS).not.toContain('code');
  });

  it('a staff-shaped DOCUMENT_CREATED answer reads the file name and issuer, not 閲覧権限なし', () => {
    const staffAnswer = {
      afterState: { id: 'd1', documentType: 'proof', issuerEntity: 'kanei', originalFilename: 'proof-v1.pdf', verificationStatus: 'unverified' }
    };
    expect(displayText(staffAnswer, 'originalFilename', '（ファイル名未記録）')).toBe('proof-v1.pdf');
    expect(isFieldHiddenByRole(staffAnswer, 'issuerEntity')).toBe(false);
    // The note and the sha256 are still trimmed from staff.
    expect(isFieldHiddenByRole(staffAnswer, 'note')).toBe(true);
    expect(isFieldHiddenByRole({ afterState: { id: 'v1', documentId: 'd1', originalFilename: 'a.pdf', versionNumber: 1 } }, 'sha256')).toBe(true);
    // The viewer answer carries no document identity at all.
    expect(displayText({}, 'originalFilename', '（ファイル名未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(isFieldHiddenByRole({}, 'issuerEntity')).toBe(true);
  });
});

describe('E2: DELIVERY_UNIT_MISMATCH reaches the screen in Japanese', () => {
  it('film: both units are named in Japanese with the one fix; the API unit code is not shown', async () => {
    callApi.mockResolvedValueOnce(mismatch('sheets'));
    const state = await recordDeliveryAction(null, form({
      kind: 'film', orderId: 'o1', lineId: 'l1', unit: 'rolls', deliveredQuantity: '10'
    }));
    expect(state).toMatchObject({
      ok: false,
      message: '納品単位（ロール）が明細の単位（枚）と異なります。単位を明細と同じ単位に直して、もう一度記録してください。'
    });
    expect(state.message).not.toContain('sheets');
    expect(callApi).toHaveBeenCalledWith('/api/film-supply-orders/o1/deliveries', {
      method: 'POST', body: { filmSupplyOrderLineId: 'l1', unit: 'rolls', deliveredQuantity: 10 }
    });
  });

  it('filling: the same, for ポッド/個', async () => {
    callApi.mockResolvedValueOnce(mismatch('pods'));
    const state = await recordDeliveryAction(null, form({
      kind: 'filling', orderId: 'f1', lineId: 'fl1', unit: 'pieces', deliveredQuantity: '5'
    }));
    expect(state.message).toBe('納品単位（個）が明細の単位（ポッド）と異なります。単位を明細と同じ単位に直して、もう一度記録してください。');
  });

  it('an unreadable message still gives the fix (no unit names); other refusals keep the API message', async () => {
    callApi.mockResolvedValueOnce({ ok: false, status: 422, data: { error: 'unit mismatch', code: 'DELIVERY_UNIT_MISMATCH' }, error: 'unit mismatch' });
    expect((await recordDeliveryAction(null, form({ kind: 'film', orderId: 'o1', lineId: 'l1', unit: 'rolls', deliveredQuantity: '1' }))).message)
      .toBe('納品単位が明細の単位と異なります。単位を明細と同じ単位に直して、もう一度記録してください。');
    callApi.mockResolvedValueOnce({ ok: false, status: 422, data: { error: '単位が不正です', code: 'UNIT_DOMAIN_MISMATCH' }, error: '単位が不正です' });
    expect(await recordDeliveryAction(null, form({ kind: 'film', orderId: 'o1', lineId: 'l1', unit: 'pods', deliveredQuantity: '1' })))
      .toMatchObject({ ok: false, message: '単位が不正です', messageKo: null, code: null });
  });

  it('the refusal marks and focuses the 単位 field of the delivery form', () => {
    const message = '納品単位（ロール）が明細の単位（枚）と異なります。単位を明細と同じ単位に直して、もう一度記録してください。';
    expect(fieldForActionMessage(message)).toBe('unit');
    expect(fieldForActionMessage('納品単位が明細の単位と異なります。単位を明細と同じ単位に直して、もう一度記録してください。')).toBe('unit');
    expect(resolveActionFieldError({ ok: false, message }, (field) => field === 'unit')).toEqual({ kind: 'field', field: 'unit', message });
  });

  it('the 単位 select is a named feedback field (label, aria wiring) and no warning shows before a line is chosen', () => {
    const html = renderToStaticMarkup(createElement(DeliveryRecordForm, {
      action: async () => ({ ok: true, message: '' }),
      kind: 'film',
      orders: [{ id: 'o1', code: 'FSO-E2', lines: [{ value: 'l1', label: '明細1：本体（1000.000枚）', unit: 'sheets' }] }],
      unitChoices: [{ value: 'rolls', label: 'ロール' }, { value: 'meters', label: 'メートル' }, { value: 'sheets', label: '枚' }]
    }));
    expect(html).toMatch(/<select name="unit"[^>]*data-feedback-label="単位"/);
    expect(html).not.toContain('違う単位では記録できません');
  });
});
