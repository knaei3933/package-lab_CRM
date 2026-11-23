import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P5 int (base p4/rc a5dd052): the web half of R1 (却下 dead end), N4(b) (a mail from another domain waits
 * for the representative's check), R5 (取引先の連絡先), R3 (監査履歴の根拠), R6 (the refused chain's
 * registered document), R8 (the delivery row's issuer drawn as given). Every block renders the real
 * components and actions with the API mocked (the API still decides; tests/p5-int.test.ts pins the server).
 * No CSS text is read. The tests that pin new behaviour fail on the base commit (demo-eml/p5-int/evidence).
 */
const session = vi.hoisted(() => ({
  user: null as { id: string; role: string; displayName?: string | null } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>
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
  loadSessionUser: async () => session.user,
  loadSession: async () => (session.user ? { kind: 'user', user: session.user } : { kind: 'anonymous' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));
const board = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => board.value,
  loadMakerPoDetail: async () => ({ purchaseOrder: null, events: [], error: null })
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: session.projects, error: null })
}));

/** A module / export this change adds: on the base commit the import is empty and only the tests needing it fail. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (load: () => Promise<any>): Promise<any> => load().catch(() => ({}));

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { PendingVerificationSection } = await import('../apps/web/src/components/EvidenceVerificationSection.js');
const flowLib = await import('../apps/web/src/lib/order-flow.js');
const myWork = await import('../apps/web/src/lib/my-work.js');
const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const realData = await vi.importActual<typeof import('../apps/web/src/lib/project-data.js')>('../apps/web/src/lib/project-data.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const navigation = await import('../apps/web/src/lib/navigation.js');
const partners = await optional(() => import('../apps/web/src/components/PartnerContacts.js'));
const partnerLib = await optional(() => import('../apps/web/src/lib/partner-contacts.js'));
const partnerActions = await optional(() => import('../apps/web/src/app/partners/actions.js'));
const partnersPage = await optional(() => import('../apps/web/src/app/partners/page.js'));

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const KEY = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c02';
const render = (node: ReactNode, showKorean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean }}>{node}</RenderedContextProvider>
).replaceAll('<!-- -->', '');
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const submitLabels = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => match[1]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim());
const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null, failure: null });
const fail = (status: number, code: string, error = `dictionary text for ${code}`) => ({
  ok: false, status, data: { code }, error, errorKo: null, code, failure: null
});
function form(entries: Record<string, string>, key: string | null = KEY): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}
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
const home = async (showKorean = false) => render((await resolve(await HomeScreen())) as ReactElement, showKorean);

const PO = { id: 'po-1', poNumber: 'SC-1', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
function order(status: string) {
  return {
    id: 'order-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: 'PROOF_READY', paymentTerms: 'prepaid', paymentTermsHidden: false,
    hold: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z'
  };
}
const REASON = '押印欄の会社名がセブン化学ではない';
/** One organization's gate state as GET …/approval-gate answers it (before the web reads it). */
const rawSlot = (organization: string, kind: 'approved' | 'pending' | 'rejected' | 'rejected_old_api' | 'open') => ({
  organization,
  valid: kind === 'approved',
  latestDecision: kind === 'open' ? null : 'APPROVE',
  revoked: false,
  invalidatedByNewerRevision: false,
  pendingEvidenceIdentifier: kind === 'pending' || kind.startsWith('rejected'),
  ...(kind === 'rejected' ? { rejected: true } : kind === 'rejected_old_api' ? {} : { rejected: false }),
  manualVerification: kind.startsWith('rejected')
    ? { result: 'rejected', verifierName: '合成代表者', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', ...(kind === 'rejected' ? { reasonNote: REASON } : {}) }
    : null
});
function rawPending(over: Record<string, unknown> = {}) {
  return {
    approvalEventId: 'ev-1', revisionId: 'rev-1', designKey: '表面A', revisionNo: 1, organization: 'seven',
    evidenceDocumentVersionId: 'ver-9', evidenceIdentifier: 'SEAL-0001-ID', approvedFileSha256: 'ab'.repeat(32),
    eventTime: '2026-11-20T00:00:00Z', recordedAt: '2026-11-20T00:00:10Z', manualVerification: null,
    evidenceIssuerEntity: 'seven', expectedIssuerEntity: 'seven', issuerMatchesOrganization: true,
    sharedEvidenceException: null, confirmable: true, sameContentUsedByOtherOrganization: false, recordedAsPending: true,
    ...over
  };
}
const rawGate = (customer: ReturnType<typeof rawSlot>, seven: ReturnType<typeof rawSlot>, pending: unknown[] = []) => ({
  orderId: 'order-1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [],
  designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer, seven, dualApproved: false }],
  pendingManualVerifications: pending
});
/** The raw gate → the web's own read (the real loadApprovalGate). */
async function gateFrom(raw: unknown) {
  callApi.mockImplementation(async (url: string) => (url.endsWith('/approval-gate') ? ok(raw) : ok()));
  const gate = await realData.loadApprovalGate('order-1');
  expect(gate).not.toBeNull();
  return gate!;
}
function flowFor(role: string, gate: unknown) {
  return flowLib.buildOrderFlow({
    order: order('APPROVAL_PENDING') as never, role, po: PO as never, documents: [] as never, revisions: [], gate: gate as never,
    makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: []
  });
}
function panel(role: string, gate: unknown, showKorean = false) {
  const flow = flowFor(role, gate);
  return render(
    <StepPanelView
      flow={flow} order={order('APPROVAL_PENDING') as never} projectCode="PRJ-1" role={role} po={PO as never} gate={gate as never}
      maker={null} makerEvents={[]} documents={[] as never} stateLabel={(key) => key}
    />,
    showKorean
  );
}

beforeEach(() => {
  session.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
  session.projects = [];
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  board.value = null;
});

// =============================================================================================
// R1 — 却下 dead end
// =============================================================================================
describe('R1: a rejected slot says so and takes a new approval (staff and representative)', () => {
  it('core → web: the slot state is 「rejected」 (the server flag; an older API: the manual check\'s result)', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected')));
    expect(flowLib.approvalSlots(gate)[0]).toMatchObject({ customer: 'approved', seven: 'rejected', rejections: { seven: { verifierName: '合成代表者', reasonNote: REASON } } });
    const old = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected_old_api')));
    expect(flowLib.approvalSlots(old)[0]!.seven).toBe('rejected');
    const waiting = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending')));
    expect(flowLib.approvalSlots(waiting)[0]!.seven).toBe('pending_check');
  });

  it('staff (round 2 H-2): the slot reads the fixed 「却下されました。理由は代表にご確認ください」 — never the written reason, even if an older API sent it', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected')));
    const html = panel('staff', gate);
    const text = visibleText(html);
    expect(html).toContain('data-slot-state="rejected"');
    expect(text).toContain('セブン化学の承認証跡は却下されました。理由は代表にご確認ください（合成代表者・2026/11/22 10:00 JST）。別の承認書類を登録してください。');
    expect(html).not.toContain(REASON);
    expect(text).not.toContain('代表の確認を待っています');
    expect(text).toContain('却下（差し替えが必要）');
    expect(submitLabels(html)).toContain('別の書類でセブン化学の承認を記録し直す');
    expect(html).toContain('name="organization" value="seven"');
    expect(html).toContain('name="revisionId" value="rev-1"');
    expect(HANGUL.test(html)).toBe(false);
  });

  it('the representative reads the written reason; markup in it is printed as text (escaped), never as an element', async () => {
    const raw = rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected'));
    expect(visibleText(panel('admin', await gateFrom(raw)))).toContain(`（理由: ${REASON}／合成代表者・2026/11/22 10:00 JST）`);
    (raw.designs[0]!.seven.manualVerification as Record<string, unknown>).reasonNote = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const html = panel('admin', await gateFrom(raw));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('the representative: the rejected slot is open for a new approval, and the 「確認」 form of the rejected evidence is NOT on the screen', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected'),
      [rawPending({ manualVerification: { result: 'rejected', verifierName: '合成代表者', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', reasonNote: REASON } })]));
    const flow = flowFor('admin', gate);
    expect(flow.panel.action.kind).toBe('approvals');
    const html = panel('admin', gate, true);
    expect(submitLabels(html)).toContain('別の書類でセブン化学の承認を記録し直す');
    expect(submitLabels(html)).not.toContain('手動確認を記録する');
    expect(html).toContain('세븐화학 승인 증빙이 각하되었습니다');
  });

  it('the check list (step 6 and the old list) shows a rejected evidence with its result only — no 「確認」 form; an open one keeps its form', () => {
    const rejected = { ...rawPending({ approvalEventId: 'ev-r' }), manualVerification: { result: 'rejected', verifierName: '合成代表者', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', reasonNote: REASON } };
    const open = rawPending({ approvalEventId: 'ev-o', organization: 'customer', evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated' });
    const html = render(
      <PendingVerificationSection pending={[rejected, open] as never} role="admin" canVerify evidenceLabel={() => 'seal.pdf'} organizationText={(key) => (key === 'seven' ? 'セブン化学' : '顧客')} />
    );
    const blocks = html.split('data-check-state=');
    const rejectedBlock = blocks.find((block) => block.startsWith('"rejected"'))!;
    const openBlock = blocks.find((block) => block.startsWith('"open"'))!;
    expect(rejectedBlock).toBeDefined();
    expect(rejectedBlock).toContain('却下済み');
    expect(rejectedBlock).toContain(`理由: ${REASON}`);
    expect(rejectedBlock).toContain('却下した証跡は確認できません');
    expect(submitLabels(rejectedBlock)).toEqual([]);
    expect(rejectedBlock).not.toContain('name="result"');
    expect(submitLabels(openBlock)).toEqual(['手動確認を記録する']);
  });

  it('a pending check list made only of rejected entries never turns the panel into the check (the slot is what is open)', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'),
      [rawPending({ manualVerification: { result: 'rejected', verifierName: 'x', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z' } })]));
    // A gate whose slot still reads pending but whose only check is decided: no 「確認」 list, the approvals panel.
    expect(flowFor('admin', gate).panel.action.kind).toBe('approvals');
    const open = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending()]));
    expect(flowFor('admin', open).panel.action).toEqual({ kind: 'evidence_check', count: 1 });
  });

  it('a rejected slot next to an open check: the representative re-records first (the slot\'s form), and the other slot says the check comes after it', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'pending'), rawSlot('seven', 'rejected'),
      [rawPending({ approvalEventId: 'ev-c', organization: 'customer', evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated' }),
        rawPending({ approvalEventId: 'ev-r', manualVerification: { result: 'rejected', verifierName: '合成代表者', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z' } })]));
    expect(flowFor('admin', gate).panel.action.kind).toBe('approvals');
    const html = panel('admin', gate);
    expect(submitLabels(html)).toContain('別の書類でセブン化学の承認を記録し直す');
    expect(visibleText(html)).toContain('証跡の確認が必要です。セブン化学の承認が別の書類で記録し直されると、この画面で確認できます');
    expect(visibleText(html)).not.toContain('確認の欄が出ないときは、画面を再読み込みしてください');
  });

  it('staff 「自分の作業」: the order is いま進められる with 「却下された承認証跡を差し替える（セブン化学・デザイン 表面A）」', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    board.value = {
      workspace: { error: null, filmOrders: [order('APPROVAL_PENDING')], sevenPurchaseOrders: [PO], documents: [], revisions: [], deliveries: [], labels: {} },
      boards: []
    };
    const raw = rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected'));
    callApi.mockImplementation(async (url: string) => (url.endsWith('/approval-gate') ? ok(raw) : ok()));
    const work = await myWork.loadMyWork(session.projects as never, 'staff');
    expect(work.rows).toHaveLength(1);
    expect(work.rows[0]).toMatchObject({ group: 'now', orderCode: 'FSO-1', step: 6, text: '却下された承認証跡を差し替える（セブン化学・デザイン 表面A）' });
    expect(callApi.mock.calls.some(([url]) => String(url) === '/api/film-supply-orders/order-1/approval-gate')).toBe(true);
    const html = await home();
    expect(visibleText(html)).toContain('却下された承認証跡を差し替える（セブン化学・デザイン 表面A）');
    expect(HANGUL.test(html)).toBe(false);
  });

  it('the representative\'s 承認箱: the rejected evidence is a 「止まっている」 row that opens step 6 — not silently gone', async () => {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({
      items: [],
      blocked: [{
        key: 'approval_evidence_rejected:ev-1', kind: 'approval_evidence_rejected', label: '却下した承認証跡の差し替え',
        organization: 'seven', designKey: '表面A',
        project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'order-1', code: 'FSO-1', status: 'APPROVAL_PENDING', paymentTerms: 'prepaid' },
        reason: { code: 'APPROVAL_EVIDENCE_REJECTED', message: 'セブン化学の承認証跡（デザイン 表面A）は却下されました。別の承認書類でセブン化学の承認を記録し直すまで進めません' },
        fixableBy: ['admin', 'staff'], waitingSince: '2026-11-22T01:00:00Z',
        deepLink: { step: 'approval', projectCode: 'PRJ-1', orderCode: 'FSO-1', action: { method: 'POST', path: '/api/artwork-revisions/rev-1/approvals' } }
      }]
    }));
    const html = await home(true);
    expect(visibleText(html)).toContain('セブン化学の承認証跡（デザイン 表面A）は却下されました');
    expect(html).toContain('href="/p/PRJ-1/o/FSO-1?step=6"');
    expect(html).toContain('각하한 승인 증빙의 교체');
  });
});

// =============================================================================================
// N4(b) — a mail from another domain waits for the representative
// =============================================================================================
describe('N4(b): the check and the 承認箱 say why a mail waits (「差出人のドメインが登録先と違います」)', () => {
  const REASON_LINE = '差出人のドメインが登録先と違います';
  it('the step-6 check shows 「確認が必要な理由」 from the gate, and 「確認」 stays offered', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'pending'), rawSlot('seven', 'approved'),
      [rawPending({ organization: 'customer', evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', manualCheckReason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: REASON_LINE } })]));
    expect(gate.pendingManualVerifications[0]!.manualCheckReason).toEqual({ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: REASON_LINE });
    const html = panel('admin', gate);
    expect(html).toContain('data-manual-check-reason="EVIDENCE_SENDER_DOMAIN_MISMATCH"');
    expect(visibleText(html)).toContain(`確認が必要な理由 ${REASON_LINE}`);
    expect(visibleText(html)).toContain('差出人のドメインが登録先と違うメール');
    expect(submitLabels(html)).toContain('手動確認を記録する');
  });

  it('the 承認箱 row of the check carries the reason line', async () => {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({
      items: [{
        key: 'approval_evidence_verification:ev-1', kind: 'approval_evidence_verification', label: '承認証跡の確認', organization: 'seven', designKey: '表面A',
        project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'order-1', code: 'FSO-1', status: 'APPROVAL_PENDING', paymentTerms: 'prepaid' },
        subjectId: 'ev-1', waitingSince: '2026-11-22T01:00:00Z',
        reason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: REASON_LINE },
        detail: { evidenceIssuerEntity: 'seven', evidence: { filename: 'approval.eml', fromAddress: 'boss@customer.example', senderDomainCheck: { status: 'mismatch' } }, warnings: [] },
        deepLink: { step: 'approval', projectCode: 'PRJ-1', orderCode: 'FSO-1' }
      }],
      blocked: []
    }));
    const html = await home();
    expect(html).toContain('data-reason=""');
    expect(visibleText(html)).toContain(`確認が必要な理由: ${REASON_LINE}`);
  });

  it('the staff\'s success line says the mail waits for the representative (not counted yet) when the server holds it', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    callApi.mockImplementation(async (url: string) => (url.endsWith('/documents')
      ? ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } }, 201)
      : ok({ approvalEvent: { id: 'ev-1' }, countsTowardDualApproval: false, evidenceIdentifierStatus: 'pending_manual_verification',
        warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: 'x', fromDomain: 'customer.example', registeredDomain: 'seven.example' }] }, 201)));
    const result = await stepActions.recordApprovalStepAction(null, form({
      orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', revisionId: 'rev-1', designKey: '表面A', organization: 'seven',
      contentBase64: Buffer.from('From: a@customer.example\r\n\r\nx').toString('base64'), filename: 'ok.eml', contentType: 'message/rfc822',
      mailMessageId: '<msg-1234@customer.example>', mailDate: '2026-11-20T01:00:00.000Z'
    }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('差出人のドメインが登録先と違うため、代表の確認を待ちます（まだ承認には数えられません）');
    // A counted mail keeps its line.
    callApi.mockImplementation(async (url: string) => (url.endsWith('/documents')
      ? ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } }, 201)
      : ok({ approvalEvent: { id: 'ev-1' }, countsTowardDualApproval: true, warnings: [] }, 201)));
    const counted = await stepActions.recordApprovalStepAction(null, form({
      orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', revisionId: 'rev-1', designKey: '表面A', organization: 'seven',
      contentBase64: Buffer.from('x').toString('base64'), filename: 'ok.eml', contentType: 'message/rfc822',
      mailMessageId: '<msg-1235@seven.example>', mailDate: '2026-11-20T01:00:00.000Z'
    }, '1f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c03'));
    expect(counted.message).toBe('セブン化学の承認を記録しました（メールの識別子は原本で確認されます）。');
  });
});

// =============================================================================================
// R6 — the refused chain's document is named
// =============================================================================================
describe('R6: when the approval is refused after the evidence was registered, the screen says the document stays (unused)', () => {
  const approvalForm = () => form({
    orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', revisionId: 'rev-1', designKey: '表面A', organization: 'seven',
    contentBase64: Buffer.from('%PDF-1.4 x').toString('base64'), filename: 'seal-customer.pdf', contentType: 'application/pdf',
    evidenceIdentifier: 'SEAL-2026-0001'
  });
  it('the refusal names the file and says it was not used; the key rule is unchanged (a partly stored chain keeps its key)', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    callApi.mockImplementation(async (url: string) => (url.endsWith('/documents')
      ? ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } }, 201)
      : fail(422, 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS', 'この承認証跡はもう一方の組織の承認にすでに使われています。組織ごとに別の承認書類を登録してください')));
    const result = await stepActions.recordApprovalStepAction(null, approvalForm());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('「承認の記録」で止まりました（その前の手順は記録済みです）。');
    expect(result.message).toContain('登録した書類「seal-customer.pdf」は証跡の一覧に残っています（この承認には使われていません）。');
    expect(result.settled).toBe(false);
    expect(HANGUL.test(result.message ?? '')).toBe(false);
  });
  it('a refusal of the first write (nothing stored) says nothing about a registered document', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    callApi.mockResolvedValue(fail(422, 'DOCUMENT_BINDING_CONFLICT'));
    const result = await stepActions.recordApprovalStepAction(null, approvalForm());
    expect(result.message).not.toContain('証跡の一覧に残っています');
  });
});

// =============================================================================================
// R3 — 監査履歴 根拠
// =============================================================================================
describe('R3: the auditor\'s 根拠 column draws the cited evidence, the result and the reason; a 代表承認 its paper', () => {
  const event = (id: string, action: string, basis: unknown, afterState: Record<string, unknown> = {}) => ({
    id, action, entityType: 'x', entityId: `e-${id}`, beforeState: null, afterState, occurredAt: `2026-11-22T0${id}:00:00Z`, requestMetadata: null,
    actor: { id: 'u-admin', displayName: '合成代表者', role: 'admin' }, ...(basis ? { basis } : {})
  });
  it('rows that used to read 「記録のみ（証跡なし）」 now show their file, 「結果: 却下（理由は代表にご確認ください）」 and the MPO number', async () => {
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => {
      if (url.includes('/audit-history')) {
        return ok({ events: [
          event('1', 'EVIDENCE_MANUAL_VERIFICATION_RECORDED', { evidenceDocumentVersionId: 'ver-pdf', result: 'rejected', reasonNote: `社名違い（見積 （金額は非表示） の書類）` }, { evidenceDocumentVersionId: 'ver-pdf' }),
          event('2', 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', { evidenceDocumentVersionId: 'ver-eml', result: 'confirmed', reasonNote: null }),
          event('3', 'MAKER_PO_CEO_APPROVED', { evidenceDocumentVersionId: null, makerPurchaseOrder: { id: 'mpo-1', displayNumber: 'MPO-2026-0007' } }),
          event('4', 'FILM_DELIVERY_CONFIRMED', { evidenceDocumentVersionId: 'ver-receipt' }, { evidenceDocumentVersionId: 'ver-receipt' })
        ] });
      }
      if (url.includes('/evidence-metadata')) {
        const doc = (id: string, type: string, issuer: string, name: string) => ({ documentId: `doc-${id}`, documentType: type, issuerEntity: issuer, originalFilename: name, filenameHidden: false,
          versions: [{ versionId: `ver-${id}`, versionNumber: 1, originalFilename: name, sha256: 'ab'.repeat(32) }] });
        return ok({ documents: [doc('pdf', 'approval_evidence', 'seven', 'seal.pdf'), doc('eml', 'send_evidence', 'kanei', 'sent.eml'), doc('receipt', 'acceptance_evidence', 'customer_generated', 'receipt.pdf')] });
      }
      return ok();
    });
    const html = await home();
    const rows = html.split('<tr role="row">').slice(2);
    const cell = (index: number) => visibleText(/data-label="根拠">([\s\S]*?)<\/td>/.exec(rows[index]!)![1]!);
    // newest first: 4 delivery, 3 CEO, 2 send, 1 manual check
    expect(cell(3)).toContain('seal.pdf');
    // Round 2 (H-2): even if a feed carried a reason, the auditor's screen draws the fixed sentence only.
    expect(cell(3)).toContain('結果: 却下（理由は代表にご確認ください）');
    expect(cell(3)).not.toContain('社名違い');
    expect(cell(2)).toContain('sent.eml');
    expect(cell(2)).toContain('結果: 確認');
    expect(cell(1)).toContain('メーカー発注書の内容（承認時のスナップショット）');
    expect(cell(1)).toContain('MPO-2026-0007');
    expect(cell(0)).toContain('receipt.pdf');
    expect(visibleText(rows[0]!)).toContain('納品の確認を記録');
    for (let index = 0; index < 4; index += 1) expect(cell(index), String(index)).not.toContain('記録のみ（証跡なし）');
    const historyUrl = String(callApi.mock.calls.find(([url]) => String(url).includes('/audit-history'))![0]);
    expect(decodeURIComponent(historyUrl)).toContain('FILM_DELIVERY_CONFIRMED');
    expect(html).not.toMatch(/480,?000|totalAmount/);
    expect(HANGUL.test(html)).toBe(false);
  });
  it('a row that cites its evidence only through basis (送信の手動確認) still reads the evidence list', async () => {
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history')
      ? ok({ events: [event('1', 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED', { evidenceDocumentVersionId: 'ver-eml', result: 'confirmed', reasonNote: null })] })
      : url.includes('/evidence-metadata')
        ? ok({ documents: [{ documentId: 'doc-eml', documentType: 'send_evidence', issuerEntity: 'kanei', originalFilename: 'sent.eml', filenameHidden: false,
            versions: [{ versionId: 'ver-eml', versionNumber: 1, originalFilename: 'sent.eml', sha256: 'ab'.repeat(32) }] }] })
        : ok()));
    const text = visibleText(await home());
    expect(text).toContain('sent.eml');
    expect(text).not.toContain('証跡の情報を読み込めませんでした');
  });

  it('an older feed without basis keeps the old reading (the approval\'s own version, else 「記録のみ（証跡なし）」)', async () => {
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history')
      ? ok({ events: [event('1', 'MAKER_PO_CEO_APPROVED', null)] })
      : ok({ documents: [] })));
    expect(visibleText(await home())).toContain('記録のみ（証跡なし）');
  });
});

// =============================================================================================
// R5 — 取引先の連絡先
// =============================================================================================
describe('R5: /partners — the representative registers the customer / セブン化学 contact address', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    id: '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c10', name: '合成顧客', role: 'end_customer', externalCode: 'C-1', contactEmail: 'approvals@customer.example',
    isActive: true, projectCodes: ['PRJ-1'], updatedAt: '2026-11-22T00:00:00Z', ...over
  });
  it('the admin menu has 「取引先の連絡先」; no other role does', () => {
    expect(navigation.navHrefsForRole('admin')).toContain('/partners');
    for (const role of ['staff', 'viewer', 'auditor']) expect(navigation.navHrefsForRole(role), role).not.toContain('/partners');
    expect(navigation.screenGuideFor('/partners')?.doHere).toContain('代表者のみ');
  });
  it('the screen: one panel per account with its role, address (or 未登録) and the form; clearing asks first', async () => {
    callApi.mockResolvedValue(ok({ accounts: [account(), account({ id: '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c11', name: '合成セブン', role: 'seven', contactEmail: null, projectCodes: [] }), { id: 'bad', name: 'x', role: 'maker' }] }));
    const read = await partnerLib.loadPartnerAccounts();
    expect(read.kind).toBe('ok');
    expect(read.accounts).toHaveLength(2);
    const html = render(<partners.PartnerContactsScreen read={read} />);
    const text = visibleText(html);
    expect(text).toContain('取引先の連絡先');
    expect(text).toContain('合成顧客 顧客');
    expect(text).toContain('連絡先: approvals@customer.example');
    expect(text).toContain('連絡先: 未登録（この取引先の承認メールの差出人は照合されません）');
    expect(submitLabels(html)).toEqual(['連絡先を変更する', '連絡先を消す', '連絡先を登録する']);
    expect(html).toContain('name="contactEmail"');
    expect(html).toContain('value="approvals@customer.example"');
    expect(HANGUL.test(html)).toBe(false);
  });
  it('a non-representative gets the notice and the list is never asked for; a 403 is the same notice', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    const page = await partnersPage.default();
    expect(visibleText(render(page))).toContain('この画面は代表者だけが使います。');
    expect(callApi).not.toHaveBeenCalled();
    callApi.mockResolvedValue({ ok: false, status: 403, data: { code: 'CEO_ONLY' }, error: 'x', code: 'CEO_ONLY', failure: null });
    expect((await partnerLib.loadPartnerAccounts()).kind).toBe('forbidden');
  });
  it('the action: a malformed address is refused before the API; a good one is PATCHed with the form key; clearing sends null', async () => {
    const id = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c10';
    const bad = await partnerActions.updatePartnerContactEmailAction(null, form({ accountId: id, contactEmail: 'not-an-email' }));
    expect(bad.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
    callApi.mockResolvedValue(ok({ id, contactEmail: 'approvals@customer.example', changed: true }));
    const good = await partnerActions.updatePartnerContactEmailAction(null, form({ accountId: id, contactEmail: 'Approvals@Customer.example' }));
    expect(good).toMatchObject({ ok: true });
    expect(good.message).toContain('approvals@customer.example');
    expect(callApi).toHaveBeenLastCalledWith(`/api/partner-accounts/${id}/contact-email`, { method: 'PATCH', body: { contactEmail: 'Approvals@Customer.example' }, idempotencyKey: KEY });
    await partnerActions.updatePartnerContactEmailAction(null, form({ accountId: id, clear: 'yes' }));
    expect(callApi.mock.calls.at(-1)![1].body).toEqual({ contactEmail: null });
    expect(revalidatePath).toHaveBeenCalledWith('/partners');
    callApi.mockResolvedValue(fail(403, 'CEO_ONLY'));
    expect((await partnerActions.updatePartnerContactEmailAction(null, form({ accountId: id, contactEmail: 'a@b.example' }))).ok).toBe(false);
    expect((await partnerActions.updatePartnerContactEmailAction(null, form({ accountId: 'not-a-uuid', contactEmail: 'a@b.example' }))).ok).toBe(false);
  });
});

// =============================================================================================
// R8 — the delivery row's issuer, drawn as given
// =============================================================================================
describe('R8: the 納品の確認 row says the receipt\'s declared issuer from the server (no more 「記録なし」)', () => {
  it('detail.evidenceIssuerEntity → 「発行元（登録時の申告）: 顧客」', async () => {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({
      items: [{
        key: 'delivery_confirmation:del-1', kind: 'delivery_confirmation', label: '納品の確認', organization: null, designKey: null,
        project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'order-1', code: 'FSO-1', status: 'FILM_DELIVERED', paymentTerms: 'prepaid' },
        subjectId: 'del-1', waitingSince: '2026-11-22T01:00:00Z',
        detail: {
          delivery: { id: 'del-1', display: '500 m', line: { lineNumber: 1 } },
          reason: { code: 'SELF_VERIFICATION_FORBIDDEN', message: 'x' },
          evidenceIssuerEntity: 'customer_generated',
          evidence: [{ documentId: 'doc-1', documentVersionId: 'ver-1', issuerEntity: 'customer_generated', filename: 'receipt.pdf' }]
        },
        deepLink: { step: 'delivery', projectCode: 'PRJ-1', orderCode: 'FSO-1' }
      }],
      blocked: []
    }));
    const text = visibleText(await home());
    expect(text).toMatch(/発行元（登録時の申告）: 顧客/);
    expect(text).not.toContain('発行元（登録時の申告）: 記録なし');
  });
});

// =============================================================================================
// Round 2 (p5-int review REQUEST_CHANGES)
// =============================================================================================
describe('round 2 H-2: the 30 review texts never reach a non-representative screen', () => {
  // demo-eml/p5-int-review/work/p13-mask.mjs, verbatim.
  const NOTES = [
    '見積 480,000円 と違う', '¥480000', '480000', '金額480000', '４８００００円', '48万円', '48万', '四十八万円', '四十八万', '480 000',
    '480,000/本', '480000/ロット', '2026-480000', '480000-', '単価12.5万', '12.5万円', 'USD480', '480k', '0.48M', '480千円',
    '税込 52万8千', '1,234', '1.234.567', '4 8 0 0 0 0', '¥ 4 8 0', '480.000', '4,800', '48,0000', '総額は見積書の通り（480 thousand yen）', '五百万円'
  ];
  it.each(NOTES)('%s: not on the staff / viewer step 6 (even if sent), not on the auditor 監査履歴 (even if sent); on the representative\'s', async (note) => {
    const raw = rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'rejected'));
    (raw.designs[0]!.seven.manualVerification as Record<string, unknown>).reasonNote = note;
    const gate = await gateFrom(raw);
    const escaped = render(<>{note}</>);
    for (const role of ['staff', 'viewer']) {
      const html = panel(role, gate);
      expect(html, role).not.toContain(escaped);
      // The viewer's step 6 is a waiting line (no slots); staff read the fixed sentence in the slot.
      if (role === 'staff') expect(visibleText(html), role).toContain('理由は代表にご確認ください');
    }
    expect(panel('admin', gate)).toContain(escaped);
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history')
      ? ok({ events: [{ id: 'a1', action: 'EVIDENCE_MANUAL_VERIFICATION_RECORDED', entityType: 'artwork_approval_event', entityId: 'ev-1', beforeState: null,
          afterState: { evidenceDocumentVersionId: 'ver-x', reasonNote: note }, occurredAt: '2026-11-22T01:00:00Z', requestMetadata: null,
          actor: { id: 'u-admin', displayName: '合成代表者', role: 'admin' }, basis: { evidenceDocumentVersionId: 'ver-x', result: 'rejected', reasonNote: note } }] })
      : ok({ documents: [] })));
    const history = await home();
    expect(history).not.toContain(escaped);
    expect(visibleText(history)).toContain('結果: 却下（理由は代表にご確認ください）');
  });
});

describe('round 2 M-1 / L-4: the representative sees an earlier 却下 of the same paper, and who rejected a stuck row', () => {
  it('the step-6 check says 「前回却下した書類と同じ内容です」 with that 却下', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending({
      previouslyRejected: { approvalEventId: 'ev-0', matchedOn: 'same_content', verifierName: '合成代表者', rejectedAt: '2026-11-22T01:00:00Z', reasonNote: REASON }
    })]));
    expect(gate.pendingManualVerifications[0]!.previouslyRejected).toEqual({ matchedOn: 'same_content', verifierName: '合成代表者', rejectedAt: '2026-11-22T01:00:00Z', reasonNote: REASON });
    const html = panel('admin', gate);
    expect(html).toContain('data-previously-rejected="same_content"');
    expect(visibleText(html)).toContain('前回却下した書類と同じ内容です');
    expect(visibleText(html)).toContain(`（理由: ${REASON}）`);
    const fresh = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending()]));
    expect(panel('admin', fresh)).not.toContain('data-previously-rejected');
  });

  it('承認箱: the check row carries the line; the stuck 却下 row says who rejected, when and why', async () => {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    const base = { project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'order-1', code: 'FSO-1', status: 'APPROVAL_PENDING', paymentTerms: 'prepaid' },
      organization: 'seven', designKey: '表面A', waitingSince: '2026-11-22T01:00:00Z', deepLink: { step: 'approval', projectCode: 'PRJ-1', orderCode: 'FSO-1' } };
    callApi.mockResolvedValue(ok({
      items: [{ ...base, key: 'approval_evidence_verification:ev-2', kind: 'approval_evidence_verification', label: '承認証跡の確認', subjectId: 'ev-2',
        detail: { previouslyRejected: { approvalEventId: 'ev-0', matchedOn: 'same_version', verifierName: '合成代表者', rejectedAt: '2026-11-22T01:00:00Z', reasonNote: REASON } } }],
      blocked: [{ ...base, key: 'approval_evidence_rejected:ev-3', kind: 'approval_evidence_rejected', label: '却下した承認証跡の差し替え',
        reason: { code: 'APPROVAL_EVIDENCE_REJECTED', message: 'セブン化学の承認証跡（デザイン 表面A）は却下されました。' },
        detail: { rejection: { verifierName: '合成代表者', rejectedAt: '2026-11-22T01:00:00Z', reasonNote: '社名違い' } } }]
    }));
    const text = visibleText(await home());
    expect(text).toContain(`前回却下した書類と同じ内容です（合成代表者・2026/11/22 10:00 JST／理由: ${REASON}）`);
    expect(text).toContain('却下: 合成代表者・2026/11/22 10:00 JST（理由: 社名違い）');
  });
});

describe('round 2 M-2: the auditor reads a contact address change in 監査履歴', () => {
  it('「取引先の連絡先を変更」 with 「連絡先: 前 → 後」, and the history asks for the code', async () => {
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history')
      ? ok({ events: [{ id: 'c1', action: 'PARTNER_CONTACT_EMAIL_UPDATED', entityType: 'account', entityId: 'acc-1', beforeState: { contactEmail: 'old@seven.example' },
          afterState: { contactEmail: null }, occurredAt: '2026-11-22T01:00:00Z', requestMetadata: null, actor: { id: 'u-admin', displayName: '合成代表者', role: 'admin' } }] })
      : ok({ documents: [] })));
    const text = visibleText(await home());
    expect(text).toContain('取引先の連絡先を変更');
    expect(text).toContain('連絡先: old@seven.example → 消去');
    expect(text).not.toContain('記録のみ（証跡なし）');
    const historyUrl = String(callApi.mock.calls.find(([url]) => String(url).includes('/audit-history'))![0]);
    expect(decodeURIComponent(historyUrl)).toContain('PARTNER_CONTACT_EMAIL_UPDATED');
  });
});

describe('round 2 L-5 (Y16): a customer-side 却下 is named as the customer in 「自分の作業」', () => {
  it('「却下された承認証跡を差し替える（顧客・デザイン 表面A）」', async () => {
    session.user = { id: 'u-staff', role: 'staff' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    board.value = {
      workspace: { error: null, filmOrders: [order('APPROVAL_PENDING')], sevenPurchaseOrders: [PO], documents: [], revisions: [], deliveries: [], labels: {} },
      boards: []
    };
    const raw = rawGate(rawSlot('customer', 'rejected'), rawSlot('seven', 'approved'));
    callApi.mockImplementation(async (url: string) => (url.endsWith('/approval-gate') ? ok(raw) : ok()));
    const work = await myWork.loadMyWork(session.projects as never, 'staff');
    expect(work.rows[0]!.text).toBe('却下された承認証跡を差し替える（顧客・デザイン 表面A）');
  });
});

// =============================================================================================
// Round 3 (p5-int review2 REQUEST_CHANGES)
// =============================================================================================
describe('round 3: the not-a-mail reason, the previously-rejected form, and the check list never draws a reason for a non-representative', () => {
  it('H-R2-1: the step-6 check says 「メールとして確認できないため、代表の確認が必要です」 for a text / PDF evidence', async () => {
    const gate = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending({
      manualCheckReason: { code: 'EVIDENCE_NOT_A_MAIL', message: 'メールとして確認できないため、代表の確認が必要です' }
    })]));
    const html = panel('admin', gate);
    expect(html).toContain('data-manual-check-reason="EVIDENCE_NOT_A_MAIL"');
    expect(visibleText(html)).toContain('確認が必要な理由 メールとして確認できないため、代表の確認が必要です');
  });

  it('L-R2-1: with 「前回却下した書類と同じ内容です」 the result has no preselected 「確認」 (blank, required); otherwise unchanged', async () => {
    const flagged = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending({
      previouslyRejected: { approvalEventId: 'ev-0', matchedOn: 'same_version', verifierName: '合成代表者', rejectedAt: '2026-11-22T01:00:00Z', reasonNote: REASON }
    })]));
    const select = (html: string) => /<select name="result"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[0] ?? '';
    const flaggedSelect = select(panel('admin', flagged));
    expect(flaggedSelect).toMatch(/^<select name="result"[^>]*required/);
    expect(flaggedSelect).toContain('<option value="" selected="">（選んでください）</option>');
    const plain = await gateFrom(rawGate(rawSlot('customer', 'approved'), rawSlot('seven', 'pending'), [rawPending()]));
    expect(select(panel('admin', plain))).not.toContain('（選んでください）');
  });

  it('L-R2-4 (review2 Z16): the check list never draws the written reason for staff / auditor / viewer, even if a list reached them', () => {
    const rejected = { ...rawPending({ approvalEventId: 'ev-r' }), manualVerification: { result: 'rejected', verifierName: '合成代表者', verifiedAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', reasonNote: '単価 480,000/本' } };
    for (const role of ['staff', 'auditor', 'viewer']) {
      const html = render(<PendingVerificationSection pending={[rejected] as never} role={role} canVerify={false} evidenceLabel={() => 'seal.pdf'} organizationText={(key) => (key === 'seven' ? 'セブン化学' : '顧客')} />);
      expect(html, role).not.toContain('480,000');
      expect(html, role).not.toContain('理由: ');
    }
    const admin = render(<PendingVerificationSection pending={[rejected] as never} role="admin" canVerify evidenceLabel={() => 'seal.pdf'} organizationText={(key) => (key === 'seven' ? 'セブン化学' : '顧客')} />);
    expect(admin).toContain('理由: 単価 480,000/本');
  });
});
