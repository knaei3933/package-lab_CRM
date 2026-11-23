import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P2 verifier M1 (contract §3-2, security review L1): the approval card says
 * 「承認すると、この納期・数量で固定されます」, but 納期・数量 are not in the snapshot hash.
 * The card's change stamp (order.updatedAt | orderFacts.updatedAt) goes with the form;
 * the approval re-reads the card and stops when it moved. The request itself is unchanged.
 */
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { approveFromCardAction } = await import('../apps/web/src/app/approval-actions.js');
const { cardFromServer, deliveryTermsStamp, TERMS_CHANGED_MESSAGE, TERMS_UNREADABLE_MESSAGE } = await import('../apps/web/src/lib/approval-card.js');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');

const SHA = 'ab12'.repeat(16);
const card = (orderUpdatedAt: string, factsUpdatedAt: string | null) => ({
  makerPurchaseOrder: { id: 'mpo-1', status: 'DRAFT', approvalSnapshotSha256: SHA },
  order: { code: 'FSO-1', paymentTerms: 'prepaid', requestedDeliveryDate: '2026-12-20', updatedAt: orderUpdatedAt },
  snapshot: { items: [], artworkFiles: [], amounts: null, recipient: { address: 'a@b.example', isEmail: true } },
  sevenPurchaseOrder: { id: 'po-1', poNumber: 'SC-1', orderFacts: factsUpdatedAt === null ? null : { orderedQuantity: '1000.000', orderedUnit: 'meters', updatedAt: factsUpdatedAt } }
});
const STAMP = '2026-11-21T10:00:00.000Z|2026-11-21T10:05:00.000Z';
const ok = (data: unknown = {}) => ({ ok: true, status: 200, data, error: null, code: null, failure: null });

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'proj-1');
  data.set(IDEMPOTENCY_FIELD, 'approve-key-0001');
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}
const base = { poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, };
const approvals = () => callApi.mock.calls.filter((call) => String(call[0]).endsWith('/ceo-approval'));

beforeEach(() => {
  callApi.mockReset();
  revalidatePath.mockReset();
});

describe('the change stamp of the card', () => {
  it('is order.updatedAt|orderFacts.updatedAt; empty facts part without facts; null without the order time', () => {
    expect(deliveryTermsStamp(card('2026-11-21T10:00:00.000Z', '2026-11-21T10:05:00.000Z'))).toBe(STAMP);
    expect(deliveryTermsStamp(card('2026-11-21T10:00:00.000Z', null))).toBe('2026-11-21T10:00:00.000Z|');
    expect(deliveryTermsStamp({ order: { code: 'x' } })).toBeNull();
    expect(deliveryTermsStamp(null)).toBeNull();
  });

  it('the server card carries it; a card without the order time has none (older API / P1 tests)', () => {
    expect(cardFromServer('mpo-1', card('2026-11-21T10:00:00.000Z', '2026-11-21T10:05:00.000Z'))?.termsStamp).toBe(STAMP);
    const older = card('x', null) as Record<string, any>;
    delete older.order.updatedAt;
    expect(cardFromServer('mpo-1', older)).not.toHaveProperty('termsStamp');
  });
});

describe('approveFromCardAction re-checks 納期・数量 before approving', () => {
  it('unchanged: approves with exactly the P1 body (payment terms + the drawn hash)', async () => {
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card') ? ok(card('2026-11-21T10:00:00.000Z', '2026-11-21T10:05:00.000Z')) : ok()));
    const result = await approveFromCardAction(null, form({ ...base, expectedTermsStamp: STAMP }));
    expect(result.ok).toBe(true);
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]![1].body).toEqual({ expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA });
  });

  it('the quantity changed after the card was drawn: nothing is approved, the screen is read again', async () => {
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card') ? ok(card('2026-11-21T10:00:00.000Z', '2026-11-21T10:09:00.000Z')) : ok()));
    const result = await approveFromCardAction(null, form({ ...base, expectedTermsStamp: STAMP }));
    expect(result).toMatchObject({ ok: false, message: TERMS_CHANGED_MESSAGE, settled: true });
    expect(approvals()).toHaveLength(0);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('a date changed (order.updatedAt moved): nothing is approved', async () => {
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card') ? ok(card('2026-11-21T10:08:00.000Z', '2026-11-21T10:05:00.000Z')) : ok()));
    expect((await approveFromCardAction(null, form({ ...base, expectedTermsStamp: STAMP }))).ok).toBe(false);
    expect(approvals()).toHaveLength(0);
  });

  it('the card cannot be read again: fail closed, nothing is approved', async () => {
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card') ? { ok: false, status: 0, data: null, error: 'x', code: 'API_TIMEOUT', failure: 'timeout' } : ok()));
    const result = await approveFromCardAction(null, form({ ...base, expectedTermsStamp: STAMP }));
    expect(result).toMatchObject({ ok: false, message: TERMS_UNREADABLE_MESSAGE });
    expect(approvals()).toHaveLength(0);
  });

  it('the check runs before the representative\'s amount is saved', async () => {
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card') ? ok(card('2026-11-21T10:00:00.000Z', '2026-11-21T10:09:00.000Z')) : ok({ approvalSnapshotSha256: SHA })));
    await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, totalAmount: '298000', currency: 'JPY', expectedTermsStamp: STAMP }));
    expect(callApi.mock.calls.map((call) => String(call[0]))).toEqual(['/api/maker-purchase-orders/mpo-1/approval-card']);
  });

  it('a form without a stamp (web fallback card) approves as before, without the extra read', async () => {
    callApi.mockResolvedValue(ok());
    expect((await approveFromCardAction(null, form(base))).ok).toBe(true);
    expect(callApi.mock.calls.some((call) => String(call[0]).endsWith('/approval-card'))).toBe(false);
  });
});

describe('the approval form carries the stamp the card showed', () => {
  it('renders expectedTermsStamp next to the unchanged hash and payment terms', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
    const view = cardFromServer('mpo-1', { ...card('2026-11-21T10:00:00.000Z', '2026-11-21T10:05:00.000Z'), canApprove: true, canReturn: true })!;
    const html = renderToStaticMarkup(<ApprovalCard card={view} korean={false} />);
    expect(html).toContain(`name="expectedTermsStamp" value="${STAMP}"`);
    expect(html).toContain(`name="expectedSnapshotSha256" value="${SHA}"`);
    expect(html).toContain('name="expectedPaymentTerms" value="prepaid"');
  });
});
