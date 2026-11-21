import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_DICTIONARY } from '../apps/web/src/lib/error-dictionary-data.js';

/**
 * P2 R30 / P-8 (contract v1.2 §3, DESIGN §1–§3): 「発注の条件」 on the order
 * screen, its three server actions, the approval card's 条件ブロック and the
 * optional dates of both create forms. The API is mocked (lib/api callApi /
 * loadSessionUser); the markup is rendered statically.
 */
const session = vi.hoisted(() => ({ user: null as { id: string; role: string } | null }));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => session.user,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, usePathname: () => '/p/PRJ-1/o/FSO-1', useRouter: () => ({ refresh: () => undefined }) }));
// The order screen test isolates 「発注の条件」: the step panel (another lane's file) is a stub,
// and the board / gate / card loaders answer fixtures.
const board = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../apps/web/src/components/StepPanel.js', () => ({ StepPanelView: () => null }));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => board.value,
  loadMakerPoDetail: async () => ({ purchaseOrder: null, events: [], error: null })
}));
vi.mock('../apps/web/src/lib/approval-card.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/approval-card.js')>()),
  loadApprovalCard: async () => null
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadApprovalGate: async () => null
}));

const actions = await import('../apps/web/src/app/order-terms-actions.js');
const terms = await import('../apps/web/src/lib/order-terms.js');
const { OrderTermsSection } = await import('../apps/web/src/components/OrderTermsSection.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { cardFromServer, cardFromWeb } = await import('../apps/web/src/lib/approval-card.js');
const { NewOrderForm } = await import('../apps/web/src/components/NewOrderForm.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { OrderDetailScreen } = await import('../apps/web/src/screens/OrderDetailScreen.js');

const KEY = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c01';

function form(entries: Record<string, string>, project: string | null = 'project-a'): FormData {
  const data = new FormData();
  if (project !== null) data.set(RENDERED_PROJECT_FIELD, project);
  data.set(IDEMPOTENCY_FIELD, KEY);
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null });
const refused = (status: number, code: string) => ({
  ok: false, status, data: { code }, error: ERROR_DICTIONARY[code]?.ja ?? code, errorKo: ERROR_DICTIONARY[code]?.ko ?? null, code
});

beforeEach(() => {
  session.user = { id: 'u-admin', role: 'admin' };
  callApi.mockReset();
  revalidatePath.mockReset();
});

// ---------------------------------------------------------------------------
describe('updateDeliveryDatesAction: PATCH delivery-dates with the changed fields only', () => {
  it('sends the typed date and null for an emptied one, with the key and the rendered project', async () => {
    callApi.mockResolvedValue(ok({ id: 'order-1' }));
    const result = await actions.updateDeliveryDatesAction(null, form({
      orderId: 'order-1',
      requestedDeliveryDate: '2026/12/01', requestedDeliveryDateBefore: '',
      plannedDeliveryDate: '', plannedDeliveryDateBefore: '2026-11-30'
    }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith('/api/film-supply-orders/order-1/delivery-dates', {
      method: 'PATCH',
      body: { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null },
      idempotencyKey: KEY,
      expectedProjectId: 'project-a'
    });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('leaves an unchanged field out of the body', async () => {
    callApi.mockResolvedValue(ok());
    await actions.updateDeliveryDatesAction(null, form({
      orderId: 'order-1',
      requestedDeliveryDate: '2026-12-01', requestedDeliveryDateBefore: '2026-12-01',
      plannedDeliveryDate: '20261215', plannedDeliveryDateBefore: '2026-12-10'
    }));
    expect(callApi.mock.calls[0]![1].body).toEqual({ plannedDeliveryDate: '2026-12-15' });
  });

  it('refuses when nothing changed (empty → empty), API not called', async () => {
    const result = await actions.updateDeliveryDatesAction(null, form({
      orderId: 'order-1', requestedDeliveryDate: '', requestedDeliveryDateBefore: '', plannedDeliveryDate: '', plannedDeliveryDateBefore: ''
    }));
    expect(result).toEqual({ ok: false, message: terms.NO_CHANGE_MESSAGE });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a date that does not exist (2026/02/30), API not called', async () => {
    const result = await actions.updateDeliveryDatesAction(null, form({ orderId: 'order-1', requestedDeliveryDate: '2026/02/30' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('希望納期は 2026/12/01 の形');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a form without the rendered project (fail closed), API not called', async () => {
    const result = await actions.updateDeliveryDatesAction(null, form({ orderId: 'order-1', requestedDeliveryDate: '2026/12/01' }, null));
    expect(result.code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('DELIVERY_TERMS_LOCKED: shows the dictionary sentence, ends the submit and reads the screen again', async () => {
    callApi.mockResolvedValue(refused(409, 'DELIVERY_TERMS_LOCKED'));
    const result = await actions.updateDeliveryDatesAction(null, form({ orderId: 'order-1', requestedDeliveryDate: '2026/12/01' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DELIVERY_TERMS_LOCKED');
    expect(result.message).toBe(ERROR_DICTIONARY.DELIVERY_TERMS_LOCKED!.ja);
    expect(result.settled).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});

describe('saveOrderQuantityAction: PUT order-facts with the quantity pair only', () => {
  it('sends the quantity as a string with its unit, never an amount key', async () => {
    callApi.mockResolvedValue(ok());
    const result = await actions.saveOrderQuantityAction(null, form({ poId: 'po-1', orderedQuantity: '１,０００', orderedUnit: 'meters', totalAmount: '999', currency: 'JPY' }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledWith('/api/seven-purchase-orders/po-1/order-facts', {
      method: 'PUT',
      body: { orderedQuantity: '1000', orderedUnit: 'meters' },
      idempotencyKey: KEY,
      expectedProjectId: 'project-a'
    });
    const body = callApi.mock.calls[0]![1].body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['orderedQuantity', 'orderedUnit']);
  });

  it('clears both when both are empty', async () => {
    callApi.mockResolvedValue(ok());
    await actions.saveOrderQuantityAction(null, form({ poId: 'po-1', orderedQuantity: '', orderedUnit: '' }));
    expect(callApi.mock.calls[0]![1].body).toEqual({ orderedQuantity: null, orderedUnit: null });
  });

  it.each([
    ['0', 'meters', terms.QUANTITY_INVALID_MESSAGE],
    ['12.3456', 'meters', terms.QUANTITY_INVALID_MESSAGE],
    ['-5', 'rolls', terms.QUANTITY_INVALID_MESSAGE],
    ['1000', '', terms.QUANTITY_PAIR_MESSAGE],
    ['', 'rolls', terms.QUANTITY_PAIR_MESSAGE],
    ['10', 'liters', terms.UNIT_INVALID_MESSAGE]
  ])('refuses quantity %j / unit %j on the web, API not called', async (orderedQuantity, orderedUnit, message) => {
    const result = await actions.saveOrderQuantityAction(null, form({ poId: 'po-1', orderedQuantity, orderedUnit }));
    expect(result).toEqual({ ok: false, message });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('accepts 3 decimals', async () => {
    callApi.mockResolvedValue(ok());
    await actions.saveOrderQuantityAction(null, form({ poId: 'po-1', orderedQuantity: '12.125', orderedUnit: 'pods' }));
    expect(callApi.mock.calls[0]![1].body).toEqual({ orderedQuantity: '12.125', orderedUnit: 'pods' });
  });

  it('DELIVERY_TERMS_LOCKED from the API reaches the form', async () => {
    callApi.mockResolvedValue(refused(409, 'DELIVERY_TERMS_LOCKED'));
    const result = await actions.saveOrderQuantityAction(null, form({ poId: 'po-1', orderedQuantity: '10', orderedUnit: 'rolls' }));
    expect(result.code).toBe('DELIVERY_TERMS_LOCKED');
    expect(revalidatePath).toHaveBeenCalled();
  });
});

describe('saveOrderAmountAction: admin only, PUT order-facts with the amount pair only', () => {
  it('admin: sends the normalized amount and currency, never a quantity key', async () => {
    callApi.mockResolvedValue(ok());
    const result = await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount: '¥312,000', currency: 'JPY', orderedQuantity: '5', orderedUnit: 'rolls' }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledWith('/api/seven-purchase-orders/po-1/order-facts', {
      method: 'PUT',
      body: { totalAmount: '312000', currency: 'JPY' },
      idempotencyKey: KEY,
      expectedProjectId: 'project-a'
    });
  });

  it('admin: 2 decimals pass, an empty amount clears both', async () => {
    callApi.mockResolvedValue(ok());
    await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount: '312000.50', currency: 'USD' }));
    await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount: '', currency: 'JPY' }));
    expect(callApi.mock.calls[0]![1].body).toEqual({ totalAmount: '312000.50', currency: 'USD' });
    expect(callApi.mock.calls[1]![1].body).toEqual({ totalAmount: null, currency: null });
  });

  it.each([['staff'], ['viewer'], ['auditor']])('%s: refused with SEVEN_PO_AMOUNT_ADMIN_ONLY, API not called', async (role) => {
    session.user = { id: `u-${role}`, role };
    const result = await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount: '312000', currency: 'JPY' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SEVEN_PO_AMOUNT_ADMIN_ONLY');
    expect(result.message).toBe(ERROR_DICTIONARY.SEVEN_PO_AMOUNT_ADMIN_ONLY!.ja);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('no session (role unknown): refused, API not called', async () => {
    session.user = null;
    const result = await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount: '312000', currency: 'JPY' }));
    expect(result.code).toBe('SEVEN_PO_AMOUNT_ADMIN_ONLY');
    expect(callApi).not.toHaveBeenCalled();
  });

  it.each([
    ['1.234', 'JPY', terms.AMOUNT_INVALID_MESSAGE],
    ['-1', 'JPY', terms.AMOUNT_INVALID_MESSAGE],
    ['312000円', 'JPY', terms.AMOUNT_INVALID_MESSAGE],
    ['312000', 'EUR', terms.CURRENCY_INVALID_MESSAGE]
  ])('admin: refuses amount %j / currency %j on the web, API not called', async (totalAmount, currency, message) => {
    const result = await actions.saveOrderAmountAction(null, form({ poId: 'po-1', totalAmount, currency }));
    expect(result).toEqual({ ok: false, message });
    expect(callApi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('loadOrderFacts / orderFactsFromApi', () => {
  const answer = { poNumber: 'SC-1', sevenPurchaseOrderId: 'po-1', orderedQuantity: '1000', orderedUnit: 'meters', orderedQuantityDisplay: '1,000 m', updatedAt: null };

  it('a viewer is never asked (hidden, no call); no PO is unlinked', async () => {
    expect(await terms.loadOrderFacts('po-1', 'viewer')).toEqual({ state: 'hidden' });
    expect(await terms.loadOrderFacts(null, 'admin')).toEqual({ state: 'unlinked' });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('403 reads as hidden (quiet), another failure as failed', async () => {
    callApi.mockResolvedValueOnce(refused(403, 'FORBIDDEN'));
    expect(await terms.loadOrderFacts('po-1', 'auditor')).toEqual({ state: 'hidden' });
    callApi.mockResolvedValueOnce({ ok: false, status: 503, data: null, error: 'x', code: 'DB_UNAVAILABLE' });
    expect(await terms.loadOrderFacts('po-1', 'staff')).toEqual({ state: 'failed' });
    expect(callApi).toHaveBeenCalledWith('/api/seven-purchase-orders/po-1/order-facts');
  });

  it('copies the amount for admin only, even if another role were answered one', async () => {
    callApi.mockResolvedValue(ok({ ...answer, totalAmount: '312000', currency: 'JPY' }));
    const staff = await terms.loadOrderFacts('po-1', 'staff');
    expect(staff.state === 'read' && 'amount' in staff.facts).toBe(false);
    const admin = await terms.loadOrderFacts('po-1', 'admin');
    expect(admin).toEqual({ state: 'read', facts: { orderedQuantity: '1000', orderedUnit: 'meters', quantityDisplay: '1,000 メートル', updatedAt: null, amount: { totalAmount: '312000', currency: 'JPY' } } });
  });

  it('shows a date with its weekday and refuses a non-date', () => {
    expect(terms.deliveryDateDisplay('2026-12-01')).toBe('2026/12/01（火）');
    expect(terms.deliveryDateDisplay('2026-02-30')).toBeNull();
    expect(terms.deliveryDateDisplay(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
const baseOrder = {
  id: 'order-1', code: 'FSO-1', status: 'DUAL_APPROVED', sevenPurchaseOrderId: 'po-1', lineCount: 1, lines: [],
  detailsHidden: false, statusHidden: false, lastNormalStatus: null,
  requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null, deliveryDatesRead: true,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z'
};

const facts = (amount: { totalAmount: string; currency: string } | null | undefined) => ({
  state: 'read' as const,
  facts: { orderedQuantity: '1000', orderedUnit: 'meters', quantityDisplay: '1,000 メートル', updatedAt: null, ...(amount === undefined ? {} : { amount }) }
});

const paper = (over: Record<string, unknown> = {}) => ({ id: 'mpo-1', status: 'DRAFT', displayNumber: 'MPO-2026-0007', ceoApprovedAt: null, ...over });

function section(props: { role: string | null; facts?: unknown; lock?: unknown; order?: Record<string, unknown>; cancelled?: boolean }) {
  return renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'project-a', showKorean: props.role === 'admin' }}>
      <OrderTermsSection
        order={{ ...baseOrder, ...(props.order ?? {}) } as never}
        role={props.role}
        facts={(props.facts ?? facts(props.role === 'admin' ? { totalAmount: '312000', currency: 'JPY' } : undefined)) as never}
        lock={(props.lock ?? { state: 'open' }) as never}
        projectCode="PRJ-1"
        cancelled={props.cancelled ?? false}
      />
    </RenderedContextProvider>
  );
}

const AMOUNT_TRACES = ['金額', 'totalAmount', 'name="currency"', '¥312,000', '312000'];

describe('OrderTermsSection: what each role sees', () => {
  it('admin: dates, quantity and amount, three separate forms', () => {
    const html = section({ role: 'admin' });
    expect(html).toContain('id="order-terms"');
    expect(html).toContain('2026/12/01（火）');
    expect(html).toContain('未記録');
    expect(html).toContain('1,000 メートル');
    expect(html).toContain('セブン化学発注書の金額');
    expect(html).toContain('¥312,000');
    expect(html.match(/<form/g)?.length).toBe(3);
    expect(html).toContain('name="requestedDeliveryDate"');
    expect(html).toContain('name="plannedDeliveryDate"');
    expect(html).toContain('name="requestedDeliveryDateBefore" value="2026-12-01"');
    expect(html).toContain('name="orderedQuantity"');
    expect(html).toContain('name="orderedUnit"');
    expect(html).toContain('name="totalAmount"');
    expect(html).toContain('name="currency"');
    expect(html).toContain('代表が承認すると、この納期・数量で固定されます');
    // The amount form is its own form: the quantity form carries no amount field.
    const quantityForm = html.slice(html.indexOf('数量を保存する') - 2000, html.indexOf('数量を保存する'));
    expect(quantityForm).not.toContain('name="totalAmount"');
  });

  it('staff: dates and quantity forms; no amount label, field or text anywhere', () => {
    const html = section({ role: 'staff' });
    expect(html.match(/<form/g)?.length).toBe(2);
    expect(html).toContain('name="requestedDeliveryDate"');
    expect(html).toContain('name="orderedQuantity"');
    for (const trace of AMOUNT_TRACES) expect(html).not.toContain(trace);
  });

  it('staff: an amount the facts somehow carried is still not drawn', () => {
    const html = section({ role: 'staff', facts: facts({ totalAmount: '312000', currency: 'JPY' }) });
    for (const trace of AMOUNT_TRACES) expect(html).not.toContain(trace);
  });

  it('viewer: reads the dates, the quantity says 閲覧権限では表示されません, no form, no amount', () => {
    const html = section({ role: 'viewer', facts: { state: 'hidden' } });
    expect(html).toContain('2026/12/01（火）');
    expect(html).toContain('閲覧権限では表示されません');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    for (const trace of AMOUNT_TRACES) expect(html).not.toContain(trace);
  });

  it('auditor: reads the quantity, no form, no amount', () => {
    const html = section({ role: 'auditor' });
    expect(html).toContain('1,000 メートル');
    expect(html).not.toContain('<form');
    for (const trace of AMOUNT_TRACES) expect(html).not.toContain(trace);
  });

  it('role unknown (null): no form', () => {
    expect(section({ role: null, facts: { state: 'hidden' } })).not.toContain('<form');
  });

  it('dates not readable: says so, never 未記録, and no date form', () => {
    const html = section({ role: 'staff', order: { deliveryDatesRead: false, requestedDeliveryDate: null } });
    expect(html).toContain('読み込めませんでした。再読み込みしてください。');
    expect(html).not.toContain('未記録');
    expect(html).not.toContain('name="requestedDeliveryDate"');
    expect(html).toContain('name="orderedQuantity"');
  });

  it('no セブン化学発注書: says it is not linked, no quantity form', () => {
    const html = section({ role: 'staff', facts: { state: 'unlinked' }, order: { sevenPurchaseOrderId: null } });
    expect(html).toContain('セブン化学発注書が紐付いていません');
    expect(html).not.toContain('name="orderedQuantity"');
  });

  it('a draft maker paper: warns that the card changes too', () => {
    expect(section({ role: 'staff', lock: { state: 'draft', paper: paper() } })).toContain('下書きのメーカー発注書があります');
  });

  it('cancelled order: no form, says why', () => {
    const html = section({ role: 'admin', cancelled: true });
    expect(html).toContain('取消で終了した発注のため、条件は変更できません。');
    expect(html).not.toContain('<form');
  });
});

describe('OrderTermsSection: locked by an approved maker paper', () => {
  const lock = { state: 'locked', paper: paper({ status: 'APPROVED_FOR_MANUAL_SEND', ceoApprovedAt: '2026-11-20T00:00:00Z' }) };

  it('admin: no date / quantity form, the lock notice with the way out, the amount form stays', () => {
    const html = section({ role: 'admin', lock });
    expect(html).toContain('納期と数量は固定されています（MPO-2026-0007 が代表承認済み）');
    expect(html).toContain('メーカー発注書を取り消して作り直し');
    expect(html).toContain('href="/p/PRJ-1/maker-po#maker-order-order-1"');
    expect(html).not.toContain('name="requestedDeliveryDate"');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).toContain('name="totalAmount"');
    expect(html).toContain('承認で固定される対象に入りません');
  });

  it('staff: no form at all, the representative cancels', () => {
    const html = section({ role: 'staff', lock });
    expect(html).not.toContain('<form');
    expect(html).toContain('取り消しは代表が行います。');
    for (const trace of AMOUNT_TRACES) expect(html).not.toContain(trace);
  });

  it('deliveryTermsLock: approved live paper locks, draft warns, cancelled-only is open', () => {
    expect(terms.deliveryTermsLock([paper({ status: 'MAKER_PO_SENT_MANUALLY' }) as never]).state).toBe('locked');
    expect(terms.deliveryTermsLock([paper({ ceoApprovedAt: '2026-11-20T00:00:00Z' }) as never]).state).toBe('locked');
    expect(terms.deliveryTermsLock([paper() as never]).state).toBe('draft');
    expect(terms.deliveryTermsLock([paper({ status: 'CANCELLED', ceoApprovedAt: '2026-11-20T00:00:00Z' }) as never]).state).toBe('open');
    expect(terms.deliveryTermsLock([]).state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
const SHA = 'a'.repeat(64);

function serverCard(over: { order?: Record<string, unknown>; recipient?: Record<string, unknown>; seven?: unknown; status?: string } = {}) {
  return {
    makerPurchaseOrder: { id: 'mpo-1', displayNumber: 'MPO-2026-0007', status: over.status ?? 'DRAFT', approvalSnapshotSha256: SHA },
    order: { id: 'order-1', code: 'FSO-1', paymentTerms: 'prepaid', requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null, ...(over.order ?? {}) },
    snapshot: {
      items: [], artworkFiles: [], amounts: { currency: 'JPY', totalAmount: '480000', display: '¥480,000' },
      recipient: { address: 'order@maker.example', isEmail: true, inMakerMaster: true, ...(over.recipient ?? {}) }
    },
    sevenPurchaseOrder: over.seven === undefined
      ? { poNumber: 'SC-1', orderFacts: { sevenPurchaseOrderId: 'po-1', orderedQuantity: '1000', orderedUnit: 'meters', orderedQuantityDisplay: '1,000 m', totalAmount: '312000', currency: 'JPY', updatedAt: null } }
      : over.seven,
    approvals: { dualApproved: true, designs: [] },
    blockers: [], warnings: [], canApprove: true, canReturn: true
  };
}

function renderCard(card: unknown) {
  return renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'project-a', showKorean: true }}>
      <ApprovalCard card={card as never} korean />
    </RenderedContextProvider>
  );
}

describe('ApprovalCard: 条件ブロック, the fixing notice and the recipient source', () => {
  it('server card: dates, quantity and amount rows; the placeholder row is gone', () => {
    const html = renderCard(cardFromServer('mpo-1', serverCard()));
    expect(html).not.toContain('納期の記録欄はまだありません');
    expect(html).toContain('希望納期');
    expect(html).toContain('2026/12/01（火）');
    expect(html).toContain('納品予定日');
    expect(html).toContain('承認前に<a href="#order-terms">発注の条件</a>で記録できます');
    expect(html).toContain('1,000 メートル');
    expect(html).toContain('セブン化学発注書の金額');
    expect(html).toContain('¥312,000');
    expect(html).toContain('承認すると、この納期・数量で固定されます。変えるにはメーカー発注書を取り消して作り直します。');
    expect(html).toContain('lang="ko"');
    expect(html).toContain('MPO-2026-0007');
  });

  it('keeps the approval form exactly: expectedPaymentTerms and expectedSnapshotSha256', () => {
    const html = renderCard(cardFromServer('mpo-1', serverCard()));
    expect(html).toContain('name="expectedPaymentTerms" value="prepaid"');
    expect(html).toContain(`name="expectedSnapshotSha256" value="${SHA}"`);
  });

  it('after approval the notice says the terms are fixed', () => {
    const html = renderCard(cardFromServer('mpo-1', serverCard({ status: 'APPROVED_FOR_MANUAL_SEND' })));
    expect(html).toContain('納期・数量は代表承認で固定されています。');
    expect(html).not.toContain('承認すると、この納期・数量で固定されます');
  });

  it('inMakerMaster true: メーカーマスターの宛先; false: the visible typed-address warning', () => {
    const master = renderCard(cardFromServer('mpo-1', serverCard()));
    expect(master).toContain('メーカーマスターの宛先');
    expect(master).not.toContain('直接入力の宛先');
    const typed = renderCard(cardFromServer('mpo-1', serverCard({ recipient: { inMakerMaster: false } })));
    expect(typed).toContain('field-warning');
    expect(typed).toContain('直接入力の宛先（メーカーマスター外）');
    expect(typed).not.toContain('メーカーマスターの宛先');
    // The approval stays possible (both are allowed).
    expect(typed).toContain('name="expectedSnapshotSha256"');
  });

  it('an older card without inMakerMaster says nothing about the source', () => {
    const html = renderCard(cardFromServer('mpo-1', serverCard({ recipient: { inMakerMaster: undefined } })));
    expect(html).not.toContain('メーカーマスター');
  });

  it('no セブン化学発注書: quantity and amount say it is not linked', () => {
    const card = cardFromServer('mpo-1', serverCard({ seven: null }));
    expect(card?.deliveryTerms?.sevenPo).toBe('unlinked');
    expect(renderCard(card)).toContain('セブン化学発注書が紐付いていません');
  });

  it('web fallback card: every term is 「—」, never 未記録 or an invented value', () => {
    const card = cardFromWeb({
      paper: { id: 'mpo-1', status: 'DRAFT', snapshot: { amounts: { currency: 'JPY', totalAmount: '480000' }, recipient: { address: 'order@maker.example' } } },
      orderCode: 'FSO-1', paymentTerms: 'prepaid', gate: null, sevenPo: null
    });
    expect(card.deliveryTerms).toBeNull();
    const html = renderCard(card);
    const block = html.slice(html.indexOf('希望納期'), html.indexOf('明細'));
    expect(block.match(/<dd>—<\/dd>/g)?.length).toBe(4);
    expect(block).not.toContain('未記録');
    expect(html).not.toContain('メーカーマスター');
  });
});

// ---------------------------------------------------------------------------
describe('create forms: the optional 希望納期・納品予定日', () => {
  const noop = async () => ({ ok: true, message: '' });

  it('NewOrderForm has both optional date inputs (text, not required)', () => {
    const html = renderToStaticMarkup(
      <NewOrderForm action={noop} projectCode="PRJ-1" unitChoices={[{ value: 'rolls', label: 'ロール' }]} paymentTermsChoices={[]} existingPoChoices={[]} unverifiedPoIds={[]} />
    );
    for (const name of ['requestedDeliveryDate', 'plannedDeliveryDate']) {
      const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
      expect(input).toContain('type="text"');
      expect(input).not.toContain('required');
    }
    expect(html).toContain('希望納期（任意）');
    expect(html).toContain('納品予定日（任意）');
  });

  it('OrderCreateForm (film) has them; the filling form does not', () => {
    const film = renderToStaticMarkup(<OrderCreateForm action={noop} orderKind="film" unitChoices={[{ value: 'rolls', label: 'ロール' }]} />);
    expect(film).toContain('name="requestedDeliveryDate"');
    expect(film).toContain('name="plannedDeliveryDate"');
    const filling = renderToStaticMarkup(<OrderCreateForm action={noop} orderKind="filling" unitChoices={[{ value: 'pods', label: 'ポッド' }]} />);
    expect(filling).not.toContain('DeliveryDate');
  });
});

// ---------------------------------------------------------------------------
describe('OrderDetailScreen: 「発注の条件」 in place, the MPO number in the header', () => {
  function workspaceWith(makerPurchaseOrders: unknown[]) {
    const order = { ...baseOrder, status: 'MAKER_PO_READY', lines: [] };
    return {
      workspace: {
        error: null, project: null, labels: null, filmOrders: [order], fillingOrders: [], sevenPurchaseOrders: [],
        documents: [], revisions: [], approvalEvents: [], deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
      },
      boards: [{ order, closure: null, makerPurchaseOrders, makerPoError: null, paymentGate: null, paymentGateError: null }]
    };
  }

  async function screen(role: string, makerPurchaseOrders: unknown[]) {
    session.user = { id: `u-${role}`, role };
    board.value = workspaceWith(makerPurchaseOrders);
    callApi.mockImplementation(async (path: string) => path.endsWith('/order-facts')
      ? ok({ orderedQuantity: '1000', orderedUnit: 'meters', updatedAt: null, ...(role === 'admin' ? { totalAmount: '312000', currency: 'JPY' } : {}) })
      : ok({ events: [] }));
    const element = await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started: false } as never);
    return renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'project-a', showKorean: false }}>{element}</RenderedContextProvider>
    );
  }

  it('staff with an approved paper: the MPO number in the header meta, the section locked, no amount', async () => {
    const html = await screen('staff', [paper({ status: 'APPROVED_FOR_MANUAL_SEND', ceoApprovedAt: '2026-11-20T00:00:00Z' })]);
    expect(html).toMatch(/<span>メーカー発注書 <span translate="no" class="p1-figure">MPO-2026-0007<\/span><\/span>/);
    expect(html).toContain('href="#order-terms"');
    expect(html).toContain('id="order-terms"');
    expect(html).toContain('納期と数量は固定されています（MPO-2026-0007 が代表承認済み）');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).not.toContain('セブン化学発注書の金額');
    expect(callApi).toHaveBeenCalledWith('/api/seven-purchase-orders/po-1/order-facts');
  });

  it('admin before a paper exists: no MPO in the header, the forms and the amount', async () => {
    const html = await screen('admin', []);
    expect(html).not.toContain('MPO-');
    expect(html).toContain('name="requestedDeliveryDate"');
    expect(html).toContain('¥312,000');
  });

  it('viewer: the quantity is never asked for', async () => {
    const html = await screen('viewer', []);
    expect(html).toContain('閲覧権限では表示されません');
    expect(callApi).not.toHaveBeenCalledWith('/api/seven-purchase-orders/po-1/order-facts');
    expect(html).not.toContain('name="requestedDeliveryDate"');
  });
});

// Live check (demo-eml/p2-web s1): the edit boxes showed 2026-12-15 and 1000.000.
describe('P2 live fix: the edit boxes show the values as they are typed', () => {
  it('plainNumberText trims the stored decimals; dates are shown as 2026/12/15', async () => {
    const { plainNumberText } = await import('../apps/web/src/lib/order-terms.js');
    expect(plainNumberText('1000.000')).toBe('1000');
    expect(plainNumberText('12.500')).toBe('12.5');
    expect(plainNumberText('312000.00')).toBe('312000');
    expect(plainNumberText('312000.50')).toBe('312000.5');
    expect(plainNumberText('100')).toBe('100');
    expect(plainNumberText(null)).toBeUndefined();
    expect(plainNumberText('abc')).toBe('abc');
    const source = (await import('node:fs')).readFileSync(new URL('../apps/web/src/components/OrderTermsSection.tsx', import.meta.url), 'utf8');
    expect(source).toContain('defaultValue={deliveryDateText(requested)');
    expect(source).toContain('defaultValue={plainNumberText(readFacts.orderedQuantity)}');
  });
});
