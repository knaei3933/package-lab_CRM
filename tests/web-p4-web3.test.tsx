import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * p4/web3 (base p4/int2 5920ac1 + the p4/web2b merge 6bf5ba9): the web half of the p4/server2 contract —
 * (a) the approval card's evidence lines, (b) the evidence-set 409, (c) the 未定 row → 支払条件, (d) the
 * assignee directory and the session's own name, (e) the completion basis — and the review leftovers
 * (web2a L-3, web2b L-1…L-7). One describe per item; each holds a test that fails on 6bf5ba9
 * (evidence: demo-eml/p4-web3/evidence/2*-base-*.log). Real components are rendered (no CSS text is
 * read). Server rules, amounts (staff / viewer / auditor see none), the idempotency semantics and P-7
 * (Japanese-only screens carry no Hangul) are not touched — the API is mocked and still decides.
 */
const state = vi.hoisted(() => ({
  user: { id: 'u-admin', role: 'admin', displayName: '代表' } as { id: string; role: string; displayName?: string | null } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>,
  cookies: new Map<string, string>(),
  cookieWrites: [] as Array<{ op: 'set' | 'delete'; name: string; value?: string; options?: Record<string, unknown> }>
}));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => state.user,
  loadSession: async () => ({ kind: 'user', user: state.user }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: state.projects, error: null })
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      state.cookies.set(name, value);
      state.cookieWrites.push({ op: 'set', name, value, options });
    },
    delete: (name: string) => {
      state.cookies.delete(name);
      state.cookieWrites.push({ op: 'delete', name });
    }
  }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
/** A module this change adds: on the base commit the import is empty and only the tests needing it fail. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (load: () => Promise<any>): Promise<any> => load().catch(() => ({}));

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { ProjectAssignmentsPanel } = await import('../apps/web/src/components/ProjectAssignmentsPanel.js');
const { AssignmentRequest } = await import('../apps/web/src/components/AssignmentRequest.js');
const { QueueRowExtras } = await import('../apps/web/src/components/QueueRowExtras.js');
const { DeliveryReceiptStep } = await import('../apps/web/src/components/DeliveryReceiptStep.js');
const { PaymentTermsChange, OrderTermsSection } = await import('../apps/web/src/components/OrderTermsSection.js');
const { ProjectProgress } = await import('../apps/web/src/components/ProjectProgress.js');
const approvalActions = await import('../apps/web/src/app/approval-actions.js');
const assignmentActions = await import('../apps/web/src/app/assignment-actions.js');
const actions = await import('../apps/web/src/app/actions.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const cardLib = await import('../apps/web/src/lib/approval-card.js');
const queueLib = await import('../apps/web/src/lib/representative-queue.js');
const assignmentsLib = await import('../apps/web/src/lib/assignments.js');
const bindingLib = await import('../apps/web/src/lib/binding-conflict.js');
const noticeLib = await optional(() => import('../apps/web/src/lib/approval-notice.js'));
const noticeServer = await optional(() => import('../apps/web/src/lib/approval-notice-server.js'));
const closureLib = await optional(() => import('../apps/web/src/lib/receipt-closure.js'));
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { GUIDE_TERMS } = await import('../apps/web/src/lib/guide.js');
const { webErrorText } = await import('../apps/web/src/lib/error-dictionary.js');

const SHA = 'a'.repeat(64);
const PO_ID = '0192a000-0000-7000-8000-0000000000f1';
const USER_A = '0192a000-0000-7000-8000-00000000000a';
const USER_B = '0192a000-0000-7000-8000-00000000000b';
const USER_C = '0192a000-0000-7000-8000-00000000000c';
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const ok = (data: unknown = {}, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null, failure: null });
const fail = (status: number, code: string, data: Record<string, unknown> = {}) => ({
  ok: false, status, data: { code, ...data }, error: `dictionary text for ${code}`, errorKo: null, code, failure: null
});
function form(entries: Record<string, string | string[]>, key: string | null = 'form-key-0001'): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'proj-1');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) for (const one of Array.isArray(value) ? value : [value]) data.append(name, one);
  return data;
}
const inContext = (node: ReactNode, korean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'proj-1', showKorean: korean }}>{node}</RenderedContextProvider>
);
/** Resolves async server components so a static render can print them. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolve(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  const resolved = await resolve(children);
  return Array.isArray(resolved) ? cloneElement(element, undefined, ...resolved) : cloneElement(element, undefined, resolved);
}
const submitLabels = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => match[1]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim());

beforeEach(() => {
  callApi.mockReset();
  revalidatePath.mockReset();
  state.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
  state.projects = [];
  state.cookies = new Map();
  state.cookieWrites = [];
});

// =============================================================================================
// (a) the approval card draws the server's evidence lines (server2 §1(4)) — never a hard-coded 「申告どおり」
// =============================================================================================
const line = (code: string, tone: string, label: string) => ({ code, tone, label });
/** One organization of the server card (contract §2-1 + server2 §1(4)). */
function serverOrg(over: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) {
  return {
    state: 'approved', approvalEventId: 'ev-c1', decision: 'APPROVE', eventTime: '2026-11-20T01:00:00Z',
    evidence: {
      documentVersionId: 'ver-c1', filename: 'approval-customer.eml', sha256: SHA, issuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated',
      issuerMatchesOrganization: true, uploadedAt: '2026-11-20T00:59:00Z', uploadedBy: { id: USER_A, displayName: '佐藤' },
      fromAddress: 'boss@evil-rev.example',
      senderDomainCheck: { status: 'mismatch', fromAddress: 'boss@evil-rev.example', fromDomain: 'evil-rev.example', registeredDomain: 'customer-rev.example' },
      senderVerdict: line('mismatch', 'warning', '差出人のドメインが登録先と一致しません'),
      declarationLine: line('sender_domain_mismatch', 'warning', '申告は承認組織と一致・差出人のドメインは不一致'),
      warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: 'x', fromDomain: 'evil-rev.example', registeredDomain: 'customer-rev.example' }],
      evidenceSource: 'email', identifierStatus: 'verified_in_document', ...evidence
    },
    ...over
  };
}
const SEVEN_OK = () => serverOrg({ approvalEventId: 'ev-s1' }, {
  documentVersionId: 'ver-s1', filename: 'approval-seven.eml', issuerEntity: 'seven', expectedIssuerEntity: 'seven', fromAddress: 'po@seven.example',
  senderDomainCheck: { status: 'match', fromAddress: 'po@seven.example', fromDomain: 'seven.example', registeredDomain: 'seven.example' },
  senderVerdict: line('match', 'ok', '差出人のドメインが登録先と一致'),
  declarationLine: line('declared_and_sender_match', 'ok', '申告どおり（差出人のドメインも一致）'),
  warnings: [], uploadedBy: { id: USER_B, displayName: '鈴木' }
});
function serverCard(designs: unknown[] = [{ designKey: '表面A', currentRevisionNo: 2, organizations: { customer: serverOrg(), seven: SEVEN_OK() } }], over: Record<string, unknown> = {}) {
  return {
    makerPurchaseOrder: { id: PO_ID, status: 'DRAFT', displayNumber: 'MPO-2026-0007', approvalSnapshotSha256: SHA },
    order: { id: 'ord-1', code: 'FSO-1', paymentTerms: 'prepaid' },
    snapshot: { amounts: { currency: 'JPY', totalAmount: '312000', display: '¥312,000' }, items: [], artworkFiles: [], recipient: { address: 'order@maker.example', isEmail: true } },
    approvals: { dualApproved: true, designs },
    sevenPurchaseOrder: null, blockers: [], warnings: [], canApprove: true, canReturn: true,
    ...over
  };
}
const viewOf = (data: unknown) => cardLib.cardFromServer(PO_ID, data)!;
const renderCard = (view: unknown, korean = false) => inContext(<ApprovalCard card={view as never} korean={korean} />, korean);
const slot = (html: string, name: string) => new RegExp(`<div class="p1-seal-slot[^"]*" data-seal="${name}">[\\s\\S]*?</div>(?=<div class="p1-seal-slot|</div>)`).exec(html)?.[0] ?? '';

describe('(a) the approval card says what the server decided about each evidence (declarationLine · senderVerdict · warnings)', () => {
  it('cardFromServer keeps the server\'s lines, the uploader, the From address, the version and the warnings', () => {
    const view = viewOf(serverCard());
    const customer = view.designs[0]!.customer;
    expect(customer.approvalEventId).toBe('ev-c1');
    expect(customer.evidence).toMatchObject({
      documentVersionId: 'ver-c1', uploadedBy: '佐藤', fromAddress: 'boss@evil-rev.example', senderStatus: 'mismatch',
      senderVerdict: { code: 'mismatch', tone: 'warning' },
      declarationLine: { code: 'sender_domain_mismatch', tone: 'warning', label: '申告は承認組織と一致・差出人のドメインは不一致' }
    });
    expect(customer.evidence!.warnings!.map((warning: { code: string }) => warning.code)).toEqual(['EVIDENCE_SENDER_DOMAIN_MISMATCH']);
  });

  it('a foreign-domain mail (web2b review M-1): the customer slot warns — no 「申告どおり」 — and shows From, uploader and the warning', () => {
    const html = renderCard(viewOf(serverCard()));
    const customer = slot(html, '顧客');
    expect(customer).toContain('p4w3-seal--warning');
    expect(customer).toContain('data-declaration="sender_domain_mismatch"');
    expect(customer).toContain('申告は承認組織と一致・差出人のドメインは不一致');
    expect(customer).not.toContain('申告どおり');
    expect(customer).toContain('差出人 <span translate="no">boss@evil-rev.example</span>');
    expect(customer).toContain('data-sender="mismatch"');
    expect(customer).toContain('登録した人 佐藤');
    expect(customer).toContain('data-warning="EVIDENCE_SENDER_DOMAIN_MISMATCH"');
    expect(customer).toContain('approval-customer.eml');
  });

  it('a matching mail: 「申告どおり（差出人のドメインも一致）」 with ✓, no warning on that slot', () => {
    const seven = slot(renderCard(viewOf(serverCard())), 'セブン化学');
    expect(seven).toContain('data-declaration="declared_and_sender_match"');
    expect(seven).toContain('data-tone="ok"');
    expect(seven).toMatch(/<span aria-hidden="true">✓ <\/span>申告どおり（差出人のドメインも一致）/);
    expect(seven).not.toContain('data-warning');
    expect(seven).not.toContain('p4w3-seal--warning');
    expect(seven).toContain('登録した人 鈴木');
  });

  it('an older API (no declarationLine): a declared match reads 「差出人は照合していません」, never 「申告どおり」', () => {
    const old = serverOrg({}, { declarationLine: undefined, senderVerdict: undefined, warnings: undefined, senderDomainCheck: undefined, fromAddress: undefined, uploadedBy: undefined });
    const html = renderCard(viewOf(serverCard([{ designKey: '表面A', currentRevisionNo: 2, organizations: { customer: old, seven: SEVEN_OK() } }])));
    const customer = slot(html, '顧客');
    expect(customer).toContain('data-declaration="declared_only"');
    expect(customer).toContain('申告は承認組織と一致（差出人は照合していません）');
    expect(customer).not.toContain('申告どおり');
  });

  it('several From lines: the slot says 「差出人（1件目）」 and the unverifiable warning', () => {
    const two = serverOrg({}, {
      fromAddress: 'boss@customer-rev.example', senderDomainCheck: { status: 'multiple_from', fromAddress: 'boss@customer-rev.example', fromDomain: null, registeredDomain: 'customer-rev.example' },
      senderVerdict: line('unverifiable', 'warning', '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）'),
      declarationLine: line('sender_unverifiable', 'warning', '申告は承認組織と一致・差出人を確認できません'),
      warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: 'y' }]
    });
    const customer = slot(renderCard(viewOf(serverCard([{ designKey: '表面A', currentRevisionNo: 2, organizations: { customer: two, seven: SEVEN_OK() } }]))), '顧客');
    expect(customer).toContain('差出人（1件目） <span translate="no">boss@customer-rev.example</span>');
    expect(customer).toContain('data-warning="EVIDENCE_SENDER_UNVERIFIABLE"');
  });

  it('a warning on the SECOND design (the 押印欄 shows the first) is said under the slots', () => {
    const html = renderCard(viewOf(serverCard([
      { designKey: '表面A', currentRevisionNo: 2, organizations: { customer: SEVEN_OK(), seven: SEVEN_OK() } },
      { designKey: '裏面B', currentRevisionNo: 1, organizations: { customer: serverOrg(), seven: SEVEN_OK() } }
    ])));
    expect(html).toContain('data-warning-design="裏面B-customer"');
    expect(html).toContain('デザイン 裏面B の顧客の証跡: 申告は承認組織と一致・差出人のドメインは不一致');
  });

  it('a server label is printed as text (markup and control characters never pass), and a malformed line is dropped', () => {
    expect(cardLib.evidenceLineFrom({ code: 'x', tone: 'loud', label: 'a' })).toBeNull();
    expect(cardLib.evidenceLineFrom({ code: 'x', tone: 'ok' })).toBeNull();
    const evil = serverOrg({}, { declarationLine: line('sender_domain_mismatch', 'warning', '<img src=x onerror=alert(1)>\u0007') });
    const html = renderCard(viewOf(serverCard([{ designKey: '表面A', currentRevisionNo: 2, organizations: { customer: evil, seven: SEVEN_OK() } }])));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('\u0007');
  });

  it('P-7: the Japanese card has no Hangul; the bilingual card adds the Korean line of the warning', () => {
    const view = viewOf(serverCard());
    expect(renderCard(view)).not.toMatch(HANGUL);
    expect(renderCard(view, true)).toContain('lang="ko"');
  });
});

// =============================================================================================
// (b) the evidence set moved after the card was drawn (409 MAKER_PO_SNAPSHOT_CHANGED, server2 §9)
// =============================================================================================
describe('(b) a 409 MAKER_PO_SNAPSHOT_CHANGED re-reads the card and says why (the evidence changed)', () => {
  const drawn = () => cardLib.approvalEvidenceStamp(viewOf(serverCard()));
  const approveForm = (extra: Record<string, string> = {}) => form({ poId: PO_ID, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, expectedEvidenceStamp: drawn()!, ...extra });
  const changedCard = () => serverCard([{ designKey: '表面A', currentRevisionNo: 2, organizations: { customer: serverOrg({ approvalEventId: 'ev-c2' }, { documentVersionId: 'ver-c2' }), seven: SEVEN_OK() } }]);
  const calls = (suffix: string) => callApi.mock.calls.filter((call) => String(call[0]).endsWith(suffix));

  it('the stamp is the sorted set of (design, organization, event, version); a web card or a card without event ids has none', () => {
    expect(drawn()).toBe('表面A:customer:ev-c1:ver-c1|表面A:seven:ev-s1:ver-s1');
    expect(cardLib.approvalEvidenceStamp(viewOf(changedCard()))).not.toBe(drawn());
    expect(cardLib.approvalEvidenceStamp({ source: 'web', designs: viewOf(serverCard()).designs })).toBeNull();
    const noIds = serverCard([{ designKey: '表面A', organizations: { customer: { state: 'missing' }, seven: { state: 'missing' } } }]);
    expect(cardLib.approvalEvidenceStamp(viewOf(noIds))).toBeNull();
  });

  it('the approve form carries the stamp the card was drawn with', () => {
    const html = renderCard(viewOf(serverCard()));
    expect(html).toContain(`name="expectedEvidenceStamp" value="${drawn()}"`);
  });

  it('evidence changed: the card is read again, the reason is the evidence, the key is renewed, the screen redraws — nothing is sent again', async () => {
    callApi.mockImplementation(async (url: string) => url.endsWith('/ceo-approval')
      ? fail(409, 'MAKER_PO_SNAPSHOT_CHANGED')
      : url.endsWith('/approval-card') ? ok(changedCard()) : ok({}));
    const result = await approvalActions.approveFromCardAction(null, approveForm());
    expect(result).toMatchObject({ ok: false, code: 'MAKER_PO_SNAPSHOT_CHANGED', settled: true });
    expect(result.message).toContain('承認証跡が変わりました');
    expect(result.message).toContain('承認は記録されていません');
    expect(calls('/ceo-approval')).toHaveLength(1);
    expect(calls('/approval-card')).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
    const notice = noticeLib.decodeApprovalNotice(state.cookies.get('kanei_approval_notice'), PO_ID);
    expect(notice?.reason).toBe('evidence_changed');
    expect(state.cookieWrites[0]?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('the same evidence set: the paper itself changed (明細・版)', async () => {
    callApi.mockImplementation(async (url: string) => url.endsWith('/ceo-approval')
      ? fail(409, 'MAKER_PO_SNAPSHOT_CHANGED')
      : url.endsWith('/approval-card') ? ok(serverCard()) : ok({}));
    const result = await approvalActions.approveFromCardAction(null, approveForm());
    expect(result.message).toContain('発注書の内容（明細・版）が変わりました');
    expect(noticeLib.decodeApprovalNotice(state.cookies.get('kanei_approval_notice'), PO_ID)?.reason).toBe('content_changed');
  });

  it('the amount typed on the card meets the same 409 (PATCH …/amounts): no approval is sent', async () => {
    callApi.mockImplementation(async (url: string) => url.endsWith('/amounts')
      ? fail(409, 'MAKER_PO_SNAPSHOT_CHANGED')
      : url.endsWith('/approval-card') ? ok(changedCard()) : ok({}));
    const result = await approvalActions.approveFromCardAction(null, approveForm({ totalAmount: '480000', currency: 'JPY' }));
    expect(result.message).toContain('承認証跡が変わりました');
    expect(calls('/ceo-approval')).toHaveLength(0);
  });

  it('the redrawn card says it at the top (role=alert) while the paper is a draft; another paper\'s or a malformed notice is none', () => {
    const notice = { poId: PO_ID, reason: 'evidence_changed', at: '2026-11-23T05:00:00.000Z' };
    const html = renderCard({ ...viewOf(changedCard()), notice });
    expect(html).toMatch(/<p class="p1-banner p4w3-notice" role="alert" data-notice="evidence_changed">/);
    expect(html).toContain('の代表承認は止まりました');
    expect(renderCard({ ...viewOf(changedCard()), status: 'CEO_APPROVED', notice })).not.toContain('data-notice');
    expect(noticeLib.decodeApprovalNotice(noticeLib.encodeApprovalNotice(notice), USER_A)).toBeNull();
    expect(noticeLib.decodeApprovalNotice(`${PO_ID}|evil|2026-11-23T05:00:00.000Z`)).toBeNull();
    expect(noticeLib.decodeApprovalNotice(`${PO_ID}|evidence_changed|2026-11-23T05:00:00.000Z|x`)).toBeNull();
  });

  it('the order screen\'s reader gives the card its own paper\'s notice only', async () => {
    state.cookies.set('kanei_approval_notice', `${PO_ID}|content_changed|2026-11-23T05:00:00.000Z`);
    expect((await noticeServer.readApprovalNotice(PO_ID))?.reason).toBe('content_changed');
    expect(await noticeServer.readApprovalNotice(USER_A)).toBeNull();
  });

  it('an approval that goes through ends the notice', async () => {
    state.cookies.set('kanei_approval_notice', `${PO_ID}|evidence_changed|2026-11-23T05:00:00.000Z`);
    callApi.mockResolvedValue(ok({}));
    const result = await approvalActions.approveFromCardAction(null, approveForm());
    expect(result.ok).toBe(true);
    expect(state.cookies.has('kanei_approval_notice')).toBe(false);
  });

  it('web2b review L-1: the API\'s own 422 AMOUNT_REQUIRED survives the redraw as the card\'s notice', async () => {
    callApi.mockResolvedValue(fail(422, 'AMOUNT_REQUIRED'));
    const result = await approvalActions.approveFromCardAction(null, approveForm());
    expect(result).toMatchObject({ ok: false, code: 'AMOUNT_REQUIRED' });
    expect(noticeLib.decodeApprovalNotice(state.cookies.get('kanei_approval_notice'), PO_ID)?.reason).toBe('amount_required');
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});

// =============================================================================================
// (c) the home 「止まっている」 未定 row opens the order's 支払条件 (deepLink.step = payment_terms)
// =============================================================================================
const blockedRow = (over: Record<string, unknown> = {}) => ({
  key: 'payment_terms_undetermined:ord-1', kind: 'payment_terms_undetermined',
  project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'ord-1', code: 'PRJ-1-FILM-001', status: 'DRAFT', paymentTerms: 'undetermined', requestedDeliveryDate: null, plannedDeliveryDate: null },
  reason: { code: 'PAYMENT_TERMS_UNDETERMINED', message: '支払条件が「未定」です。' }, fixableBy: ['admin', 'staff'],
  paymentTermsEditable: true, paymentTermsLock: null, waitingSince: '2026-11-23T01:00:00Z',
  deepLink: { step: 'payment_terms', projectCode: 'PRJ-1', orderCode: 'PRJ-1-FILM-001', projectId: 'proj-1', orderId: 'ord-1', subjectId: 'ord-1', action: { method: 'PATCH', path: '/api/film-supply-orders/ord-1/payment-terms' } },
  ...over
});
async function home(blocked: unknown[]) {
  state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
  callApi.mockResolvedValue(ok({ items: [], blocked }));
  const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
  return renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
}

describe('(c) a 未定 row opens 「支払条件を変更する」 on the order screen (a DRAFT has not reached step 7)', () => {
  it('taskFromServerItem keeps deepLink.step payment_terms and the server\'s editable / lock', () => {
    const task = queueLib.taskFromServerItem(blockedRow(), true)!;
    expect(task).toMatchObject({ deepLinkStep: 'payment_terms', paymentTermsEditable: true, step: null });
    const locked = queueLib.taskFromServerItem(blockedRow({ paymentTermsEditable: false, paymentTermsLock: { code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen', message: '保留中のため支払条件は変更できません。' } }), true)!;
    expect(locked.paymentTermsLock).toEqual({ code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen', message: '保留中のため支払条件は変更できません。' });
  });

  it('an editable row: 「支払条件を決める」 → /p/PRJ-1/o/PRJ-1-FILM-001#payment-terms (no ?step=7)', async () => {
    const html = await home([blockedRow()]);
    expect(html).toMatch(/<a class="p1-button p1-button--quiet p1-inbox-go" href="\/p\/PRJ-1\/o\/PRJ-1-FILM-001#payment-terms">支払条件を決める/);
    expect(html).not.toContain('?step=7');
  });

  it('a locked row says why and only opens the order (no fix button that the PATCH would refuse)', async () => {
    const html = await home([blockedRow({ order: { id: 'ord-1', code: 'PRJ-1-FILM-001', status: 'ON_HOLD' }, paymentTermsEditable: false, paymentTermsLock: { code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen', message: '保留中のため支払条件は変更できません。' } })]);
    expect(html).toContain('data-lock="order_frozen"');
    expect(html).toContain('いまは変更できません: 保留中のため支払条件は変更できません。');
    expect(html).not.toContain('支払条件を決める');
    expect(html).toMatch(/href="\/p\/PRJ-1\/o\/PRJ-1-FILM-001#payment-terms">発注を開く/);
  });

  const order = (over: Record<string, unknown> = {}) => ({ id: 'ord-1', code: 'FSO-1', paymentTerms: 'undetermined', paymentTermsUndetermined: true, paymentTermsEditable: true, ...over });
  it('the order screen holds the anchor: the open form while editable, the lock reason (not a dead form) once locked', () => {
    const open = inContext(<PaymentTermsChange order={order() as never} role="staff" cancelled={false} />);
    expect(open).toMatch(/^<div id="payment-terms" class="p4w3-anchor"><details class="p4-terms-change" open="">/);
    const locked = inContext(<PaymentTermsChange order={order({ paymentTermsEditable: false }) as never} role="admin" cancelled={false} />);
    expect(locked).toContain('id="payment-terms"');
    expect(locked).toContain('data-lock="payment-terms"');
    expect(locked).not.toContain('name="paymentTerms"');
    expect(inContext(<PaymentTermsChange order={order() as never} role="viewer" cancelled={false} />)).toBe('');
  });

  it('an approved paper (the section\'s own lock) with a 未定 still gives the anchor its reason', () => {
    const facts = { state: 'read', facts: { orderedQuantity: '1000', orderedUnit: 'meters', quantityDisplay: '1,000 メートル', amount: null } };
    const html = inContext(<OrderTermsSection order={{ ...order(), requestedDeliveryDate: null, plannedDeliveryDate: null, deliveryDatesRead: true, sevenPurchaseOrderId: 'po-1', lines: [] } as never} role="admin" facts={facts as never} lock={{ state: 'locked', paper: { displayNumber: 'MPO-2026-0001' } } as never} projectCode="PRJ-1" cancelled={false} />);
    expect(html).toContain('<p id="payment-terms" class="field-warning p4w3-lock" data-lock="payment-terms"');
  });
});

// =============================================================================================
// (d) the 担当者 field reads GET /api/assignable-users; the name is GET /api/me's displayName
// =============================================================================================
const assignmentsView = (rows: Array<Record<string, unknown>> = []) => ({
  assignments: rows.map((row) => ({ id: `as-${row.userId}`, role: 'staff', isActive: true, assignedAt: null, ...row })), assignableRoles: ['staff', 'viewer', 'auditor'], error: null
});
async function overview(role: string, directory: (url: string) => unknown = () => ok({ users: [{ id: USER_A, displayName: '佐藤', role: 'staff' }, { id: USER_B, displayName: '鈴木', role: 'viewer' }, { id: USER_C, displayName: '高橋', role: 'auditor' }], assignableRoles: ['staff', 'viewer', 'auditor'], limit: 200, truncated: false })) {
  vi.resetModules();
  vi.doMock('../apps/web/src/lib/dashboard-data.js', () => ({
    loadDashboardData: async () => ({
      board: {
        workspace: {
          labels: { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] },
          filmOrders: [], sevenPurchaseOrders: [], revisions: [], revisionsWithheld: 0, documents: [], deliveries: [], readiness: null,
          project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, projectRefused: false, error: null
        },
        boards: []
      },
      activity: []
    })
  }));
  state.user = { id: 'u', role, displayName: 'X' };
  state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }, { id: 'proj-2', code: 'PRJ-2', name: '案件B', status: 'ACTIVE' }];
  callApi.mockImplementation(async (url: string) => {
    if (url === '/api/projects/proj-1/assignments') return ok({ assignments: [{ id: 'a1', userId: USER_A, displayName: '佐藤', role: 'staff', isActive: true, assignedAt: null }], assignableRoles: ['staff', 'viewer', 'auditor'] });
    if (url === '/api/assignable-users') return directory(url);
    if (url === '/api/representative-queue') return ok({ items: [], blocked: [] });
    return ok({});
  });
  const { ProjectOverviewScreen } = await import('../apps/web/src/screens/ProjectOverviewScreen.js');
  const { RenderedContextProvider: Provider } = await import('../apps/web/src/components/RenderedContext.js');
  const tree = await ProjectOverviewScreen({ projectId: 'proj-1', projectCode: 'PRJ-1' } as never);
  return renderToStaticMarkup(<Provider value={{ projectId: 'proj-1', showKorean: false }}>{(await resolve(tree)) as ReactElement}</Provider>);
}
const options = (html: string) => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((match) => `${match[1]}=${match[2]}`);

describe('(d) 担当者: picked by name from GET /api/assignable-users (the pasted-ID detour is gone)', () => {
  it('the representative\'s overview reads the directory (not the other projects) and offers everyone not yet assigned, by name', async () => {
    const html = await overview('admin');
    expect(callApi.mock.calls.some((call) => call[0] === '/api/assignable-users')).toBe(true);
    expect(callApi.mock.calls.some((call) => call[0] === '/api/projects/proj-2/assignments')).toBe(false);
    expect(options(html)).toEqual(['=（選ぶ）', `${USER_B}=鈴木（閲覧）`, `${USER_C}=高橋（監査）`]);
    expect(html).not.toContain('name="typedUserId"');
    expect(html).toMatch(/<select name="candidateUserId" required=""/);
  });

  it('a list the server cut short (truncated) offers the 利用者ID field for the rest', async () => {
    const html = await overview('admin', () => ok({ users: [{ id: USER_B, displayName: '鈴木', role: 'viewer' }], assignableRoles: ['staff', 'viewer', 'auditor'], limit: 1, truncated: true }));
    expect(html).toContain('name="typedUserId"');
    expect(html).toContain('さらにいます。一覧にない人は、本人の画面に出る利用者IDを貼り付けてください。');
  });

  it('a directory that cannot be read says so — and offers no form to guess with', async () => {
    const html = await overview('admin', () => fail(503, 'API_UNAVAILABLE'));
    expect(html).toContain('data-directory="error"');
    expect(html).not.toContain('担当者に割り当てる');
  });

  it.each(['staff', 'viewer', 'auditor'])('%s: the web never asks for the directory', async (role) => {
    await overview(role);
    expect(callApi.mock.calls.some((call) => call[0] === '/api/assignable-users')).toBe(false);
  });

  it('assignableCandidatesFrom drops the assigned, the malformed, a role the server does not list, and keeps the server\'s order', () => {
    const data = { users: [{ id: USER_C, displayName: '高橋', role: 'auditor' }, { id: USER_A, displayName: '佐藤', role: 'staff' }, { id: 'nope', displayName: 'x', role: 'staff' }, { id: USER_B, displayName: '管理', role: 'admin' }, { id: USER_C, displayName: '高橋', role: 'auditor' }], assignableRoles: ['staff', 'viewer', 'auditor'], truncated: false };
    expect(assignmentsLib.assignableCandidatesFrom(data, [{ userId: USER_A }])).toEqual({ candidates: [{ userId: USER_C, displayName: '高橋', role: 'auditor' }], truncated: false });
  });

  it('the 割り当て request names the person by /api/me\'s displayName (no login cookie needed) under an h2', async () => {
    state.user = { id: USER_A, role: 'staff', displayName: '新人 太郎' };
    state.projects = [];
    callApi.mockResolvedValue(ok({ events: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
    expect(html).toContain('data-section="assignment-request"');
    expect(html).toContain('名前: 新人 太郎');
    expect(html).toContain(`利用者ID: ${USER_A}`);
    expect(html).toContain('<h2 id="assignment-request-title"');
  });

  it('a blank /api/me name falls back to the name remembered at login', async () => {
    const { requesterOf } = await import('../apps/web/src/lib/requester.js');
    const { DISPLAY_NAME_COOKIE, encodeDisplayNameCookie } = await import('../apps/web/src/lib/session-display.js');
    state.cookies.set(DISPLAY_NAME_COOKIE, encodeDisplayNameCookie(USER_A, '佐藤')!);
    expect(await requesterOf({ id: USER_A, role: 'staff', displayName: ' ' })).toEqual({ id: USER_A, role: 'staff', displayName: '佐藤' });
    expect(await requesterOf({ id: USER_A, role: 'staff', displayName: '佐藤 花子' })).toEqual({ id: USER_A, role: 'staff', displayName: '佐藤 花子' });
  });

  it('the representative never sees the request block on /home (they open every project)', async () => {
    state.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
    state.projects = [];
    callApi.mockResolvedValue(ok({ items: [], blocked: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    expect(renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement)).not.toContain('data-section="assignment-request"');
  });
});

// =============================================================================================
// (e) the completion basis (server2 §10): receiptClosure / closureBasis
// =============================================================================================
const delivery = (over: Record<string, unknown> = {}) => ({ id: 'del-1', kind: 'film', orderId: 'ord-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliveredAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', confirmed: true, confirmationHidden: false, detailsHidden: false, ...over });
const receiptStep = (closure: unknown, completed = false, deliveries = [delivery()]) => inContext(
  <DeliveryReceiptStep
    order={{ id: 'ord-1', code: 'FSO-1', sevenPurchaseOrderId: 'po-1' } as never}
    projectCode="PRJ-1" role="admin" documents={[]} completed={completed}
    context={{ deliveries: deliveries as never, userId: 'u-admin', filmOnly: true, readiness: null, readinessLabel: (key: string) => key, closure: closure as never }}
  />
);

describe('(e) 納品の完了: the server says what it rests on (確認済みの納品 / 証跡なしの同意)', () => {
  it('receiptClosureFrom: pending while 納品済み, recorded once completed (no basis recorded = evidence-free, before P4); an older answer is null', () => {
    expect(closureLib.receiptClosureFrom({ receiptClosure: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, receiptAssumption: null }))
      .toEqual({ pending: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, recorded: null });
    expect(closureLib.receiptClosureFrom({ receiptClosure: null, receiptAssumption: { assumedAt: '2026-11-23T01:00:00Z', assumedBy: { id: 'u', displayName: '代表' }, note: 'n' } }))
      .toEqual({ pending: null, recorded: { basis: 'evidence_free_acknowledgment', at: '2026-11-23T01:00:00Z', by: '代表' } });
    expect(closureLib.receiptClosureFrom({ status: 'FILM_DELIVERED' })).toBeNull();
  });

  it('every delivery confirmed: 「確認済みの納品で完了する」, no 「証跡なし」 agreement, the basis in the form', () => {
    const html = receiptStep({ pending: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, recorded: null });
    expect(submitLabels(html)).toContain('確認済みの納品で完了する');
    expect(html).toContain('name="closureBasis" value="delivery_confirmations"');
    expect(html).not.toContain('name="acknowledgeNoEvidence"');
  });

  it('the server says the completion rests on no confirmed delivery: the agreement stays, said as 「証跡なし」', () => {
    const html = receiptStep({ pending: { basis: 'evidence_free_acknowledgment', acknowledgeNoEvidenceRequired: true }, recorded: null });
    expect(html).toContain('data-closure="evidence_free_acknowledgment"');
    expect(submitLabels(html)).toContain('証跡なしで問題なしとして完了する');
    expect(html).toContain('name="acknowledgeNoEvidence"');
    expect(html).not.toContain('name="closureBasis"');
  });

  it('a completed order says what its completion rested on', () => {
    const html = receiptStep({ pending: null, recorded: { basis: 'delivery_confirmations', at: '2026-11-23T01:00:00Z', by: '代表' } }, true);
    expect(html).toContain('data-closure-basis="delivery_confirmations"');
    expect(html).toContain('完了の根拠: 確認済みの納品（受領証跡で数量を確認）');
  });

  it('the action: on confirmed deliveries it sends {note} only; otherwise the agreement is required and sent', async () => {
    callApi.mockResolvedValue(ok({ closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false }));
    const done = await actions.assumeFilmReceiptAction(null, form({ orderId: 'ord-1', note: '受領書で確認', closureBasis: 'delivery_confirmations' }));
    expect(done).toMatchObject({ ok: true, message: '発注を完了しました（完了の根拠: 確認済みの納品）。' });
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: { note: '受領書で確認' } });
    expect((callApi.mock.calls[0]![1] as { body: Record<string, unknown> }).body).not.toHaveProperty('acknowledgeNoEvidence');
    callApi.mockReset();
    const refused = await actions.assumeFilmReceiptAction(null, form({ orderId: 'ord-1', note: 'n' }));
    expect(refused.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
    callApi.mockResolvedValue(ok({ closureBasis: 'evidence_free_acknowledgment' }));
    const free = await actions.assumeFilmReceiptAction(null, form({ orderId: 'ord-1', note: 'n', acknowledgeNoEvidence: 'on' }));
    expect(free.message).toBe('発注を完了しました（完了の根拠: 証跡なしで問題なしとして完了）。');
    expect(callApi.mock.calls[0]![1]).toMatchObject({ body: { note: 'n', acknowledgeNoEvidence: true } });
  });

  it('a delivery added meanwhile (the server re-judges under its lock: 422): the refusal says so and the screen redraws with the agreement', async () => {
    callApi.mockResolvedValue(fail(422, 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED'));
    const result = await actions.assumeFilmReceiptAction(null, form({ orderId: 'ord-1', note: 'n', closureBasis: 'delivery_confirmations' }));
    expect(result).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED', settled: true });
    expect(result.message).toContain('確認されていない納品があるため');
    expect(revalidatePath).toHaveBeenCalled();
  });
});

// =============================================================================================
// Stage 1: the merge keeps both sides on one inbox row
// =============================================================================================
describe('merge (web2a target + web2b organization / evidence / 希望納期): one inbox row keeps both', () => {
  it('a delivery confirmation (web2a) reads 「納品の確認（明細1／500 m）」 and still gets web2b\'s 希望納期 line; two lines are two keys', async () => {
    const item = (line: number) => ({ kind: 'delivery_confirmation', label: '納品の確認', project: { id: 'proj-1', code: 'PRJ-1' }, order: { id: 'ord-1', code: 'FSO-1', requestedDeliveryDate: '2099-12-15' }, detail: { delivery: { line: { lineNumber: line }, display: '500 m' } } });
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [item(1), item(2)], blocked: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
    expect(html).toContain('<p class="p1-inbox-work">納品の確認（明細1／500 m）</p>');
    expect(html).toContain('納品の確認（明細2／500 m）');
    expect(html).toMatch(/data-due="ok">希望納期 12\/15（/);
    const [a, b] = [item(1), item(2)].map((row) => queueLib.taskFromServerItem(row)!);
    expect(queueLib.queueRowKey(a!)).not.toBe(queueLib.queueRowKey(b!));
  });
});

// =============================================================================================
// web2a review L-3, web2b review Lows (L-2 … L-7)
// =============================================================================================
describe('web2a L-3: the progress rows\' order links and 「完了した発注」 are 44px targets', () => {
  it('ProjectProgress draws the target classes on the real markup', () => {
    const order = (id: string, status: string) => ({ id, code: `FSO-${id}`, status, lineCount: 1, lines: [], detailsHidden: false, statusHidden: false, lastNormalStatus: status, paymentTerms: 'prepaid', paymentTermsHidden: false, hold: null, sevenPurchaseOrderId: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
    const workspace = {
      error: null, project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, labels: null, filmOrders: [order('1', 'MAKER_PO_READY'), order('2', 'FILM_RECEIPT_ASSUMED_NO_ISSUE')], fillingOrders: [],
      sevenPurchaseOrders: [], documents: [], revisions: [], approvalEvents: [], deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
    const html = inContext(<ProjectProgress workspace={workspace as never} role="staff" currentPath={null} projectCode="PRJ-1" />);
    expect(html).toMatch(/<a class="progress-code p4w3-target" href="\/p\/PRJ-1\/o\/FSO-1">/);
    expect(html).toContain('<summary class="p4w3-target-summary">完了した発注 1件</summary>');
  });
});

describe('web2a L-3: the overview\'s 「証跡の一覧」 link is a 44px target too (live w06 measured it at 24px)', () => {
  it('on the real overview screen', async () => {
    const html = await overview('staff');
    expect(html).toMatch(/<p class="p1-order-links"><a class="p4w3-target" href="\/p\/PRJ-1\/evidence">証跡の一覧<\/a><\/p>/);
  });
});

describe('web2b review Lows', () => {
  it('L-3: the inbox row says the declared issuer itself (detail.evidenceIssuerEntity), then what a declaration is', () => {
    const task = queueLib.taskFromServerItem({
      kind: 'approval_evidence_verification', label: '承認証跡の確認', project: { id: 'p', code: 'PRJ-1' }, order: { id: 'o', code: 'FSO-1' }, organization: 'customer', designKey: '表面A',
      detail: { evidenceIssuerEntity: 'customer_generated', evidence: { filename: 'a.eml', fromAddress: 'x@customer.example', senderDomainCheck: { status: 'multiple_from' } }, warnings: [] }
    })!;
    const html = inContext(<QueueRowExtras task={task} now={new Date('2026-11-23T03:00:00Z')} />);
    expect(html).toContain('発行元（登録時の申告）: 顧客作成');
    // L-2: the first of several From lines is said to be the first.
    expect(html).toContain('差出人（1件目） <span translate="no">x@customer.example</span>');
  });

  it('L-4: the approve and return forms keep no draft (a redrawn card never gets an old amount back)', () => {
    const html = renderCard(viewOf(serverCard()));
    expect(html).toContain('を代表承認する');
    expect(html).toContain('差し戻す');
    expect(html).not.toContain('p1-draft-anchor');
  });

  it('L-5 (R4): a keyless automatic 発注コード stops before the API and keeps the submit open (settled: false)', async () => {
    const result = await stepActions.startFilmOrderAction(null, form({ projectCode: 'PRJ-1', poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', code: '', paymentTerms: 'prepaid', lines: '[]' }, null));
    expect(result).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', settled: false });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('L-5 (R11): the existing 発注コード / デザイン名 of a binding conflict is cut at 64 characters', () => {
    const long = 'X'.repeat(80);
    const binding = bindingLib.existingBindingOf('DOCUMENT_BINDING_CONFLICT', { existing: { orderCode: long, designKey: 'ok' } });
    expect(binding?.orderCode).toHaveLength(64);
  });

  it('L-5 (R13): the old 「金額未入力」 warning is not repeated next to the amount the card asks for', () => {
    const html = renderCard({ ...viewOf(serverCard()), amountDisplay: null, canApprove: false, blockers: [{ code: 'AMOUNT_REQUIRED', message: '' }], warnings: [{ code: 'MAKER_PO_AMOUNT_MISSING', message: '金額が未入力です' }] });
    expect(html).toContain('data-need="amount"');
    // The card says a known code in the dictionary's words — neither those nor the API's own text is repeated.
    expect(html).not.toContain(webErrorText('MAKER_PO_AMOUNT_MISSING').message);
    expect(html).not.toContain('金額が未入力です');
  });

  it('L-6: 「外す」 is announced by the panel\'s status line (always on the page, filled after the removal)', async () => {
    const directory = { candidates: [{ userId: USER_B, displayName: '鈴木', role: 'viewer' }], truncated: false, error: null };
    const before = inContext(<ProjectAssignmentsPanel view={assignmentsView([{ userId: USER_A, displayName: '佐藤' }]) as never} directory={directory} />);
    expect(before).toContain('<p class="p4w3-status" role="status"></p>');
    callApi.mockResolvedValue(ok({}));
    const removed = await assignmentActions.removeAssignmentAction(null, form({ userId: USER_B }));
    expect(removed.ok).toBe(true);
    const { decodeAssignmentNotice } = await import('../apps/web/src/lib/assignment-notice.js');
    const notice = decodeAssignmentNotice(state.cookies.get('kanei_assignment_notice'), 'proj-1');
    expect(notice?.userId).toBe(USER_B);
    const after = inContext(<ProjectAssignmentsPanel view={assignmentsView([{ userId: USER_A, displayName: '佐藤' }]) as never} directory={directory} notice={notice} />);
    expect(after).toMatch(/<p class="p4w3-status" role="status" data-assignment-notice="removed">鈴木 を担当から外しました/);
    expect(decodeAssignmentNotice(state.cookies.get('kanei_assignment_notice'), 'proj-2')).toBeNull();
  });

  it('L-6 (live w04): adding the last person in the list removes the add form — the status line says the addition', async () => {
    callApi.mockResolvedValue(ok({ assignment: { userId: USER_B } }));
    const added = await assignmentActions.addAssignmentAction(null, form({ candidateUserId: USER_B }));
    expect(added.ok).toBe(true);
    const { decodeAssignmentNotice } = await import('../apps/web/src/lib/assignment-notice.js');
    const notice = decodeAssignmentNotice(state.cookies.get('kanei_assignment_notice'), 'proj-1');
    expect(notice).toMatchObject({ kind: 'added', userId: USER_B });
    const after = inContext(<ProjectAssignmentsPanel view={assignmentsView([{ userId: USER_B, displayName: '鈴木', role: 'viewer' }]) as never} directory={{ candidates: [], truncated: false, error: null }} notice={notice} />);
    expect(after).not.toContain('担当者に割り当てる');
    expect(after).toMatch(/<p class="p4w3-status" role="status" data-assignment-notice="added">鈴木 を担当者に割り当てました/);
  });

  it('L-6: the request block is an h2 (it sits under the screen\'s h1)', () => {
    const html = inContext(<AssignmentRequest requester={{ id: USER_A, role: 'staff', displayName: '佐藤' }} />);
    expect(html).toContain('<h2 id="assignment-request-title"');
    expect(html).not.toContain('<h3');
  });

  it('L-6: narrow-screen fields draw their size from --control-h / --control-text (set to 44px / 16px under 600px)', () => {
    const html = renderCard({ ...viewOf(serverCard()), amountDisplay: null, canApprove: false, blockers: [{ code: 'AMOUNT_REQUIRED', message: '' }] });
    const amount = html.match(/<input[^>]*name="totalAmount"[^>]*>/)?.[0] ?? '';
    expect(amount).toContain('min-height:var(--control-h, 40px)');
    expect(amount).toContain('font-size:var(--control-text, 15px)');
    expect(readSrc('app/layout.tsx')).toContain("import './p4-web3.css'");
  });

  it('L-7: the section is 「割り当て」 (not the role label 「担当者」), and the guide names both final states', () => {
    const html = inContext(<ProjectAssignmentsPanel view={assignmentsView([]) as never} directory={{ candidates: [], truncated: false, error: null }} />);
    expect(html).toContain('<h2 id="project-assignments-title" class="p1-section-title">割り当て（この案件を開ける人）</h2>');
    const term = GUIDE_TERMS.find((entry: { term: string }) => entry.term === 'フィルム発注') as { meaning: string };
    expect(term.meaning).toContain('問題なしで完了');
    expect(term.meaning).toContain('取消で終了');
  });
});
