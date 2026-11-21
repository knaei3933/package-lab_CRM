import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 R20-R23: the step actions of the order screen — the write guard (the
 * rendered project, not the cookie), input validation before any API call, the
 * issuer fixed by the organization (B2/P-1), and where each write goes.
 */
const state = vi.hoisted(() => ({ selected: 'project-COOKIE' as string | null }));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => state.selected,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect }));

const stepActions = await import('../apps/web/src/app/step-actions.js');
const { RENDERED_PROJECT_FIELD, PROJECT_CONTEXT_MISMATCH, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { RECIPIENT_EMAIL_INVALID_MESSAGE } = await import('../apps/web/src/lib/form-messages.js');

type Action = (prev: null, formData: FormData) => Promise<{ ok: boolean; message: string; code?: string | null; settled?: boolean }>;

const RENDERED = 'proj-RENDERED';
const KEY = 'step-form-key-1';
const B64 = Buffer.from('%PDF-1.7 test').toString('base64');

const actionEntries = Object.entries(stepActions)
  .filter(([name, value]) => name.endsWith('Action') && typeof value === 'function') as Array<[string, Action]>;

function form(entries: Record<string, string | string[]>, rendered: string | File | null = RENDERED): FormData {
  const data = new FormData();
  if (rendered !== null) data.set(RENDERED_PROJECT_FIELD, rendered);
  data.set(IDEMPOTENCY_FIELD, KEY);
  for (const [name, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  }
  return data;
}

const ok = () => ({
  ok: true, status: 201, error: null, code: null, failure: null,
  data: { id: 'x-1', document: { id: 'doc-1' }, version: { id: 'ver-1' }, order: { id: 'ord-1' }, revision: { id: 'rev-1' }, purchaseOrder: { id: 'po-1' } }
});

const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);
const file = { contentBase64: B64, filename: 'a.pdf', contentType: 'application/pdf' };

const startForm = (extra: Record<string, string> = {}) => ({
  poNumber: 'PO-100', officialRegisteredAt: '2026-11-01', code: 'FSO-NEW', paymentTerms: 'prepaid', lines: LINES,
  projectCode: 'PRJ-1', ...extra
});
const proofForm = (extra: Record<string, string> = {}) => ({
  orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', designKey: '表面A', currentStatus: 'ARTWORK_RECEIVED', ...file, ...extra
});
const approvalForm = (extra: Record<string, string> = {}) => ({
  orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', revisionId: 'rev-1', designKey: '表面A', organization: 'customer',
  contentBase64: B64, filename: 'ok.eml', contentType: 'message/rfc822',
  mailMessageId: '<msg-1234@customer.example>', mailDate: '2026-11-20T01:00:00.000Z', ...extra
});
const makerForm = (extra: Record<string, string> = {}) => ({
  orderId: 'ord-1', recipientAddress: 'order@maker.example', totalAmount: '480000', needsReadyTransition: 'true', ...extra
});
const acceptForm = (extra: Record<string, string> = {}) => ({
  orderId: 'ord-1', poId: 'mpo-1', sevenPurchaseOrderId: 'po-1', mode: 'provisional', ...file, ...extra
});
const deliveryForm = (extra: Record<string, string | string[]> = {}) => ({
  orderId: 'ord-1', lineId: ['line-1'], 'quantity_line-1': '10', 'unit_line-1': 'rolls', ...extra
});

/** A valid form for each exported action, so the guard test covers new actions through the list. */
const VALID: Record<string, () => Record<string, string | string[]>> = {
  startFilmOrderAction: startForm,
  submitProofStepAction: proofForm,
  recordApprovalStepAction: approvalForm,
  createMakerPoStepAction: makerForm,
  recordAcceptanceStepAction: acceptForm,
  recordDeliveryStepAction: deliveryForm
};

beforeEach(() => {
  state.selected = 'project-COOKIE';
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  redirect.mockReset();
});

describe('the step actions under test', () => {
  it('covers every exported *Action of app/step-actions.ts (a new one needs a VALID form here)', () => {
    expect(actionEntries.map(([name]) => name).sort()).toEqual(Object.keys(VALID).sort());
  });
});

describe('R20/B3 write guard: every step action', () => {
  const BAD_FIELDS: Array<[string, () => string | File | null]> = [
    ['no rendered field', () => null],
    ['an empty string', () => ''],
    ['a space', () => ' '],
    ['a path-like value (a/b)', () => 'a/b'],
    ['a value with a dot-dot', () => '../x'],
    ['65 characters', () => 'a'.repeat(65)],
    ['a File', () => new File(['x'], 'x.txt')]
  ];

  describe.each(actionEntries)('%s', (name, action) => {
    it.each(BAD_FIELDS)('refuses %s with PROJECT_CONTEXT_MISMATCH and makes no API call', async (_label, make) => {
      const result = await action(null, form(VALID[name]!(), make()));
      expect(result.ok).toBe(false);
      expect(result.code).toBe(PROJECT_CONTEXT_MISMATCH);
      expect(callApi).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    });

    it('does not refuse a valid rendered project (the guard is not what blocks a valid form)', async () => {
      const result = await action(null, form(VALID[name]!()));
      expect(result.code ?? null).not.toBe(PROJECT_CONTEXT_MISMATCH);
      expect(callApi).toHaveBeenCalled();
    });
  });

  it('a form with the rendered field but a crafted second copy uses the first value only', async () => {
    const data = form(startForm());
    data.append(RENDERED_PROJECT_FIELD, 'proj-OTHER');
    await stepActions.startFilmOrderAction(null, data);
    expect(callApi.mock.calls[0]![0]).toBe(`/api/projects/${RENDERED}/seven-purchase-orders`);
  });
});

describe('B3 in the new model: the write goes to the rendered project, whatever the cookie says', () => {
  it('startFilmOrderAction posts every project-scoped write to the rendered project', async () => {
    state.selected = 'project-COOKIE';
    await stepActions.startFilmOrderAction(null, form(startForm({ code: 'FSO-NEW' })));
    const paths = callApi.mock.calls.map((call) => call[0] as string);
    expect(paths[0]).toBe(`/api/projects/${RENDERED}/seven-purchase-orders`);
    expect(paths).toContain(`/api/projects/${RENDERED}/film-supply-orders`);
    expect(paths.filter((path) => path.startsWith('/api/projects/')).every((path) => path.startsWith(`/api/projects/${RENDERED}/`))).toBe(true);
    expect(paths.some((path) => path.includes('project-COOKIE'))).toBe(false);
  });

  it('startFilmOrderAction runs the 5 writes in order with keys .1 to .5', async () => {
    await stepActions.startFilmOrderAction(null, form(startForm({ code: 'FSO-NEW', ...file })));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      `/api/projects/${RENDERED}/seven-purchase-orders`,
      `/api/projects/${RENDERED}/documents`,
      '/api/seven-purchase-orders/x-1/verification-checklist',
      `/api/projects/${RENDERED}/film-supply-orders`,
      '/api/film-supply-orders/x-1/transitions'
    ]);
    expect(callApi.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([1, 2, 3, 4, 5].map((n) => `${KEY}.${n}`));
  });

  it('startFilmOrderAction redirects to the new order screen after success', async () => {
    await stepActions.startFilmOrderAction(null, form(startForm({ code: 'FSO-NEW' })));
    expect(redirect).toHaveBeenCalledWith('/p/PRJ-1/o/FSO-NEW?started=1');
  });

  it('startFilmOrderAction does not redirect after a refusal', async () => {
    callApi.mockResolvedValue({ ok: false, status: 409, data: null, error: '重複', code: 'DUP', failure: null });
    const result = await stepActions.startFilmOrderAction(null, form(startForm()));
    expect(result.ok).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('startFilmOrderAction with an existing PO skips the PO create, upload and checklist', async () => {
    await stepActions.startFilmOrderAction(null, form({ existingPoId: 'po-existing', code: 'FSO-2', paymentTerms: 'on_delivery', lines: LINES }));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      `/api/projects/${RENDERED}/film-supply-orders`,
      '/api/film-supply-orders/x-1/transitions'
    ]);
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ sevenPurchaseOrderId: 'po-existing', paymentTerms: 'on_delivery', code: 'FSO-2' });
  });

  it('the PO upload is bound to the seven document type and issuer', async () => {
    await stepActions.startFilmOrderAction(null, form(startForm(file)));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ documentType: 'seven_po', issuerEntity: 'seven', sevenPurchaseOrderId: 'x-1' });
  });

  it('submitProofStepAction posts the proof to the rendered project with documentType proof and issuer maker', async () => {
    await stepActions.submitProofStepAction(null, form(proofForm()));
    expect(callApi.mock.calls[0]![0]).toBe(`/api/projects/${RENDERED}/documents`);
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ documentType: 'proof', issuerEntity: 'maker', filmSupplyOrderId: 'ord-1', designKey: '表面A' });
  });

  it('submitProofStepAction from ARTWORK_RECEIVED makes 4 writes, from PROOF_READY 3, from another state 2', async () => {
    await stepActions.submitProofStepAction(null, form(proofForm({ currentStatus: 'ARTWORK_RECEIVED' })));
    expect(callApi).toHaveBeenCalledTimes(4);
    callApi.mockClear();
    await stepActions.submitProofStepAction(null, form(proofForm({ currentStatus: 'PROOF_READY' })));
    expect(callApi).toHaveBeenCalledTimes(3);
    expect(callApi.mock.calls[2]![1].body).toEqual({ to: 'APPROVAL_PENDING' });
    callApi.mockClear();
    await stepActions.submitProofStepAction(null, form(proofForm({ currentStatus: 'APPROVAL_PENDING' })));
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('submitProofStepAction sends the lot marking only when typed', async () => {
    await stepActions.submitProofStepAction(null, form(proofForm({ lotMarking: 'LOT-7' })));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ lotMarking: 'LOT-7', fileDocumentVersionId: 'ver-1' });
    callApi.mockClear();
    await stepActions.submitProofStepAction(null, form(proofForm()));
    expect(callApi.mock.calls[1]![1].body).not.toHaveProperty('lotMarking');
  });

  it('recordAcceptanceStepAction posts the evidence to the rendered project', async () => {
    await stepActions.recordAcceptanceStepAction(null, form(acceptForm()));
    expect(callApi.mock.calls[0]![0]).toBe(`/api/projects/${RENDERED}/documents`);
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ documentType: 'acceptance_evidence', issuerEntity: 'maker', makerPurchaseOrderId: 'mpo-1' });
  });

  it('the maker paper and delivery actions address the order, not a project path', async () => {
    await stepActions.createMakerPoStepAction(null, form(makerForm()));
    await stepActions.recordDeliveryStepAction(null, form(deliveryForm()));
    for (const call of callApi.mock.calls) expect(call[0]).toMatch(/^\/api\/film-supply-orders\/ord-1\//);
  });
});

describe('R23 chains of the other steps', () => {
  it('createMakerPoStepAction makes the READY transition only when asked, then the paper with the amount', async () => {
    await stepActions.createMakerPoStepAction(null, form(makerForm({ needsReadyTransition: 'true', currency: 'USD', totalAmount: '１，２００．５' })));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      '/api/film-supply-orders/ord-1/transitions',
      '/api/film-supply-orders/ord-1/maker-purchase-orders'
    ]);
    expect(callApi.mock.calls[0]![1].body).toEqual({ to: 'MAKER_PO_READY' });
    expect(callApi.mock.calls[1]![1].body).toEqual({ recipientAddress: 'order@maker.example', amounts: { currency: 'USD', totalAmount: '1200.5' } });
    callApi.mockClear();
    await stepActions.createMakerPoStepAction(null, form(makerForm({ needsReadyTransition: 'false' })));
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![1].body.amounts).toEqual({ currency: 'JPY', totalAmount: '480000' });
  });

  it('recordAcceptanceStepAction provisional: upload then provisional acceptance (2 writes)', async () => {
    await stepActions.recordAcceptanceStepAction(null, form(acceptForm({ mode: 'provisional' })));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      `/api/projects/${RENDERED}/documents`,
      '/api/maker-purchase-orders/mpo-1/provisional-acceptance'
    ]);
  });

  it('recordAcceptanceStepAction final with a new file: upload, verify, accept-evidence', async () => {
    await stepActions.recordAcceptanceStepAction(null, form(acceptForm({ mode: 'final' })));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      `/api/projects/${RENDERED}/documents`,
      '/api/documents/doc-1/verify',
      '/api/maker-purchase-orders/mpo-1/accept-evidence'
    ]);
    expect(callApi.mock.calls[2]![1].body).toEqual({ evidenceDocumentVersionId: 'ver-1' });
  });

  it('recordAcceptanceStepAction final with an existing verified evidence only accepts it', async () => {
    await stepActions.recordAcceptanceStepAction(null, form({
      orderId: 'ord-1', poId: 'mpo-1', mode: 'final', evidenceDocumentVersionId: 'ver-9', evidenceDocumentId: 'doc-9', evidenceVerified: 'true'
    }));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual(['/api/maker-purchase-orders/mpo-1/accept-evidence']);
  });

  it('recordAcceptanceStepAction final with an existing unverified evidence verifies it first', async () => {
    await stepActions.recordAcceptanceStepAction(null, form({
      orderId: 'ord-1', poId: 'mpo-1', mode: 'final', evidenceDocumentVersionId: 'ver-9', evidenceDocumentId: 'doc-9', evidenceVerified: 'false'
    }));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual(['/api/documents/doc-9/verify', '/api/maker-purchase-orders/mpo-1/accept-evidence']);
  });

  it('recordDeliveryStepAction records each line then FILM_DELIVERED, with quantities normalized', async () => {
    await stepActions.recordDeliveryStepAction(null, form({
      orderId: 'ord-1', lineId: ['l1', 'l2'], quantity_l1: '１，２００', unit_l1: 'rolls', quantity_l2: '2.5', unit_l2: 'meters', deliveredAt: '2026-11-21'
    }));
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      '/api/film-supply-orders/ord-1/deliveries', '/api/film-supply-orders/ord-1/deliveries', '/api/film-supply-orders/ord-1/transitions'
    ]);
    expect(callApi.mock.calls[0]![1].body).toEqual({ filmSupplyOrderLineId: 'l1', unit: 'rolls', deliveredQuantity: 1200, deliveredAt: '2026-11-21' });
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ deliveredQuantity: 2.5, unit: 'meters' });
    expect(callApi.mock.calls[2]![1].body).toEqual({ to: 'FILM_DELIVERED' });
  });

  it('a failure of the second delivery line is not settled and names the line', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ ok: false, status: 422, data: null, error: '数量が多すぎます', code: 'X', failure: null });
    const result = await stepActions.recordDeliveryStepAction(null, form({ orderId: 'ord-1', lineId: ['l1', 'l2'], quantity_l1: '1', unit_l1: 'rolls', quantity_l2: '1', unit_l2: 'rolls' }));
    expect(result.settled).toBe(false);
    expect(result.message.startsWith('「明細2の納品」で止まりました')).toBe(true);
  });
});

describe('input validation: nothing reaches the API', () => {
  const refuse = async (action: Action, entries: Record<string, string | string[]>, expectedText?: string | RegExp) => {
    const result = await action(null, form(entries));
    expect(result.ok).toBe(false);
    expect(result.code ?? null).not.toBe(PROJECT_CONTEXT_MISMATCH);
    expect(callApi).not.toHaveBeenCalled();
    if (expectedText) expect(result.message).toMatch(expectedText);
    return result;
  };

  describe('submitProofStepAction', () => {
    const run = stepActions.submitProofStepAction as Action;
    it('refuses no file', async () => { await refuse(run, proofForm({ contentBase64: '', filename: '' }), 'ファイルを選択'); });
    it('refuses a file name without content', async () => { await refuse(run, proofForm({ contentBase64: '' }), 'ファイルを選択'); });
    it('refuses an unsupported content type', async () => { await refuse(run, proofForm({ contentType: 'application/zip' }), 'この形式'); });
    it('refuses a content type that only looks allowed', async () => { await refuse(run, proofForm({ contentType: 'application/pdf; x=1' }), 'この形式'); });
    it('refuses a missing design name', async () => { await refuse(run, proofForm({ designKey: '  ' }), 'デザイン名'); });
    it('refuses a missing order and a missing PO', async () => {
      await refuse(run, proofForm({ orderId: '' }));
      await refuse(run, proofForm({ sevenPurchaseOrderId: '' }));
    });
  });

  describe('recordApprovalStepAction', () => {
    const run = stepActions.recordApprovalStepAction as Action;
    it('refuses a PDF with a short typed identifier', async () => {
      await refuse(run, approvalForm({ contentType: 'application/pdf', filename: 'a.pdf', mailMessageId: '', evidenceIdentifier: 'abc' }), '8文字以上');
    });
    it('refuses a PDF with no identifier', async () => {
      await refuse(run, approvalForm({ contentType: 'application/pdf', filename: 'a.pdf', mailMessageId: '' }), '8文字以上');
    });
    it('does not take a posted mailMessageId for a PDF identifier', async () => {
      await refuse(run, approvalForm({ contentType: 'application/pdf', filename: 'a.pdf' }), '8文字以上');
    });
    it('refuses a mail whose Message-ID could not be read and no typed id', async () => {
      await refuse(run, approvalForm({ mailMessageId: '' }), 'Message-ID');
    });
    it('refuses a mail with a short Message-ID', async () => {
      await refuse(run, approvalForm({ mailMessageId: 'short' }), 'Message-ID');
    });
    it.each(['', 'maker', 'ceo', 'Customer', 'customer_generated'])('refuses organization %j', async (organization) => {
      await refuse(run, approvalForm({ organization }), '承認組織が不正');
    });
    it('refuses without a revision, design or order', async () => {
      await refuse(run, approvalForm({ revisionId: '' }));
      await refuse(run, approvalForm({ designKey: '' }));
      await refuse(run, approvalForm({ orderId: '' }));
    });
    it('refuses an unsupported file', async () => {
      await refuse(run, approvalForm({ contentType: 'application/x-msdownload' }), 'この形式');
    });
  });

  describe('createMakerPoStepAction', () => {
    const run = stepActions.createMakerPoStepAction as Action;
    it.each(['', 'not-an-email', 'a@b', 'a b@c.example', '<a@b.example>', 'a@b.example,c@d.example'])('refuses recipient %j', async (recipientAddress) => {
      await refuse(run, makerForm({ recipientAddress }), RECIPIENT_EMAIL_INVALID_MESSAGE);
    });
    it.each(['', '  ', 'abc', '-5', '480000円', '1,2,3', '1e5'])('refuses amount %j', async (totalAmount) => {
      await refuse(run, makerForm({ totalAmount }), '金額');
    });
    it('refuses a missing order', async () => { await refuse(run, makerForm({ orderId: '' })); });
  });

  describe('recordDeliveryStepAction', () => {
    const run = stepActions.recordDeliveryStepAction as Action;
    it.each(['0', '-1', '', 'abc', '０'])('refuses quantity %j', async (quantity) => {
      await refuse(run, deliveryForm({ 'quantity_line-1': quantity }), '納品数量');
    });
    it('refuses when any one line is bad even if the first is fine', async () => {
      await refuse(run, { orderId: 'ord-1', lineId: ['l1', 'l2'], quantity_l1: '5', unit_l1: 'rolls', quantity_l2: '0', unit_l2: 'rolls' }, '明細2');
    });
    it('refuses a form without lines', async () => { await refuse(run, { orderId: 'ord-1' }, '明細'); });
    it('refuses a missing order', async () => { await refuse(run, deliveryForm({ orderId: '' })); });
  });

  describe('recordAcceptanceStepAction', () => {
    const run = stepActions.recordAcceptanceStepAction as Action;
    it('refuses without a file and without an existing evidence version', async () => {
      await refuse(run, acceptForm({ contentBase64: '', filename: '' }), 'ファイル');
    });
    it('refuses an unsupported file', async () => { await refuse(run, acceptForm({ contentType: 'application/zip' }), 'この形式'); });
    it('refuses a missing maker paper', async () => { await refuse(run, acceptForm({ poId: '' }), 'メーカー発注書'); });
  });

  describe('startFilmOrderAction', () => {
    const run = stepActions.startFilmOrderAction as Action;
    it('refuses a missing PO number and registration date for a new PO', async () => {
      await refuse(run, startForm({ poNumber: '' }), '発注番号');
      await refuse(run, startForm({ officialRegisteredAt: '' }), '本登録日');
    });
    it('refuses a missing order code', async () => { await refuse(run, startForm({ code: '' }), '発注コード'); });
    it.each(['', 'later', 'Prepaid'])('refuses payment terms %j', async (paymentTerms) => {
      await refuse(run, startForm({ paymentTerms }), '支払条件');
    });
    it.each([
      ['not json', '{'],
      ['an empty list', '[]'],
      ['a missing description', JSON.stringify([{ description: ' ', orderedQuantity: '1', unit: 'rolls' }])],
      ['a zero quantity', JSON.stringify([{ description: 'a', orderedQuantity: '0', unit: 'rolls' }])],
      ['a negative quantity', JSON.stringify([{ description: 'a', orderedQuantity: '-1', unit: 'rolls' }])],
      ['an unknown unit', JSON.stringify([{ description: 'a', orderedQuantity: '1', unit: 'furlongs' }])]
    ])('refuses lines with %s', async (_name, lines) => {
      await refuse(run, startForm({ lines }));
    });
    it('refuses an unsupported attached file', async () => {
      await refuse(run, startForm({ ...file, contentType: 'application/zip' }), 'この形式');
    });
  });
});

describe('B2/P-1: the issuer is fixed by the organization, never by the form', () => {
  const run = stepActions.recordApprovalStepAction as Action;
  const evidenceBody = () => callApi.mock.calls[0]![1].body as Record<string, unknown>;

  it('customer approval uploads the evidence as customer_generated', async () => {
    await run(null, form(approvalForm({ organization: 'customer' })));
    expect(evidenceBody()).toMatchObject({ documentType: 'approval_evidence', issuerEntity: 'customer_generated' });
  });

  it('seven approval uploads the evidence as seven', async () => {
    await run(null, form(approvalForm({ organization: 'seven' })));
    expect(evidenceBody()).toMatchObject({ issuerEntity: 'seven' });
  });

  it.each(['issuerEntity', 'issuer', 'issuer_entity', 'documentType'])('a crafted %s field cannot choose the issuer or type', async (field) => {
    await run(null, form(approvalForm({ organization: 'customer', [field]: 'seven' })));
    expect(evidenceBody()).toMatchObject({ documentType: 'approval_evidence', issuerEntity: 'customer_generated' });
  });

  it('the approval record carries the organization of the slot', async () => {
    await run(null, form(approvalForm({ organization: 'seven' })));
    expect(callApi.mock.calls[1]![0]).toBe('/api/artwork-revisions/rev-1/approvals');
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ organization: 'seven', decision: 'APPROVE', evidenceDocumentVersionId: 'ver-1' });
  });

  it('an .eml uses the mail Message-ID and Date and evidenceSource email', async () => {
    await run(null, form(approvalForm({ evidenceIdentifier: 'typed-identifier-1' })));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({
      evidenceIdentifier: '<msg-1234@customer.example>', evidenceSource: 'email', eventTime: '2026-11-20T01:00:00.000Z'
    });
  });

  it('an .eml with no readable Message-ID falls back to a typed identifier', async () => {
    await run(null, form(approvalForm({ mailMessageId: '', evidenceIdentifier: 'typed-identifier-1' })));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ evidenceIdentifier: 'typed-identifier-1', evidenceSource: 'email' });
  });

  it('a PDF uses the typed identifier and evidenceSource signed_document', async () => {
    await run(null, form(approvalForm({ contentType: 'application/pdf', filename: 'a.pdf', mailMessageId: '<ignored@x.example>', mailDate: '2000-01-01T00:00:00.000Z', evidenceIdentifier: 'SEAL-2026-0001', eventTime: '2026-11-19T00:00:00.000Z' })));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({
      evidenceIdentifier: 'SEAL-2026-0001', evidenceSource: 'signed_document', eventTime: '2026-11-19T00:00:00.000Z'
    });
  });

  it('a PDF without a typed event time gets a current ISO time, not the mail date', async () => {
    await run(null, form(approvalForm({ contentType: 'application/pdf', filename: 'a.pdf', mailDate: '2000-01-01T00:00:00.000Z', evidenceIdentifier: 'SEAL-2026-0001' })));
    const eventTime = (callApi.mock.calls[1]![1].body as { eventTime: string }).eventTime;
    expect(eventTime).not.toBe('2000-01-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(eventTime))).toBe(false);
  });

  it('sends the approver name only when typed', async () => {
    await run(null, form(approvalForm({ approverName: '山田' })));
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ externalApproverName: '山田' });
    callApi.mockClear();
    await run(null, form(approvalForm()));
    expect(callApi.mock.calls[1]![1].body).not.toHaveProperty('externalApproverName');
  });

  it('the evidence is bound to the order, the PO and the design the slot shows', async () => {
    await run(null, form(approvalForm({ orderId: 'ord-7', sevenPurchaseOrderId: 'po-7', designKey: '裏面B' })));
    expect(evidenceBody()).toMatchObject({ filmSupplyOrderId: 'ord-7', sevenPurchaseOrderId: 'po-7', designKey: '裏面B' });
  });
});
