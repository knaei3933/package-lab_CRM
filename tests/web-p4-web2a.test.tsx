import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4 web 2a (audit44 UNRESOLVED §0, H14, M6, N9, M13, M10①, M12, H2·M2·H12, L5/L6, base p4/int
 * 5faa6c6): the old screens' writes move to the order screen. One describe per item; each holds
 * a test that fails on the base commit (evidence: demo-eml/p4-web2a/evidence/mutation-*.log)
 * and renders real markup (no CSS-text-only check). The API is mocked; it still decides every
 * write. Server rules, amounts (none on a staff/viewer/auditor screen) and the idempotency
 * semantics (one derived key per chain write) are untouched.
 */
const session = vi.hoisted(() => ({ user: null as { id: string; role: string } | null }));
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
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));
const board = vi.hoisted(() => ({ value: null as unknown, events: [] as unknown[] }));
const gate = vi.hoisted(() => ({ value: null as unknown }));
const workspaceFixture = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => board.value,
  loadMakerPoDetail: async () => ({ purchaseOrder: null, events: board.events, error: null })
}));
vi.mock('../apps/web/src/lib/approval-card.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/approval-card.js')>()),
  loadApprovalCard: async () => null
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadApprovalGate: async () => gate.value,
  loadWorkspace: async () => workspaceFixture.value
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');
const { OrderDetailScreen } = await import('../apps/web/src/screens/OrderDetailScreen.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');

const render = (node: ReactNode, showKorean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean }}>{node}</RenderedContextProvider>
).replaceAll('<!-- -->', '');

const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null });
const KEY = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c02';
const B64 = Buffer.from('%PDF-1.4 test').toString('base64');
const FILE = { contentBase64: B64, filename: 'receipt.pdf', contentType: 'application/pdf' };
function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  data.set(IDEMPOTENCY_FIELD, KEY);
  for (const [key, value] of Object.entries(entries)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}
const paths = () => callApi.mock.calls.map((call) => String(call[0]));

const PO = { id: 'po-1', poNumber: 'SC-1', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'order-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: 'MAKER_PO_READY', paymentTerms: 'prepaid', paymentTermsHidden: false,
    hold: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra
  };
}
const slot = (valid: boolean, pending = false) => ({
  organization: 'customer', valid, latestDecision: valid ? 'APPROVE' : null, revoked: false, invalidatedByNewerRevision: false,
  pendingEvidenceIdentifier: pending, manualVerification: null
});
const GATE_ONE_DESIGN = {
  orderId: 'order-1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [],
  designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer: slot(false), seven: slot(false), dualApproved: false }],
  pendingManualVerifications: []
};
const PENDING = {
  approvalEventId: 'ev-1', revisionId: 'rev-1', designKey: '表面A', revisionNo: 1, organization: 'customer',
  evidenceDocumentVersionId: 'ver-9', evidenceIdentifier: 'SEAL-0001', approvedFileSha256: 'ab'.repeat(32),
  eventTime: '2026-11-20T00:00:00Z', recordedAt: '2026-11-20T00:00:10Z', manualVerification: null,
  evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true,
  sharedEvidenceException: null, confirmable: true, sameContentUsedByOtherOrganization: false, recordedAsPending: true
};

/** The step panel of one order state, built the way the order screen builds it. */
function panel(status: string, role: string, extra: {
  order?: Record<string, unknown>; po?: unknown; gate?: unknown; maker?: unknown; makerEvents?: unknown[];
  documents?: unknown[]; deliveryContext?: unknown; showKorean?: boolean; makerPos?: unknown[]; settled?: Set<string>;
} = {}) {
  const o = order(status, extra.order ?? {});
  const po = extra.po === undefined ? PO : extra.po;
  const flow = buildOrderFlow({
    order: o as never, role, po: po as never, documents: (extra.documents ?? []) as never, revisions: [], gate: (extra.gate ?? null) as never,
    makerPos: (extra.makerPos ?? []) as never, makerEvents: (extra.makerEvents ?? []) as never, settledSendEventIds: extra.settled ?? new Set(),
    paymentGate: null, deliveries: []
  });
  return render(
    <StepPanelView
      flow={flow} order={o as never} projectCode="PRJ-1" role={role} po={po as never} gate={(extra.gate ?? null) as never}
      maker={(extra.maker ?? null) as never} makerEvents={(extra.makerEvents ?? []) as never} documents={(extra.documents ?? []) as never}
      stateLabel={(key) => key} deliveryContext={extra.deliveryContext as never}
    />,
    extra.showKorean ?? false
  );
}

/** The submit buttons of a markup (their visible label, the visually-hidden context dropped). */
const submitLabels = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => match[1]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim());
/** A link into an old screen (the lists that only read now). */
const OLD_SCREEN_HREF = /href="(?:\/p\/[^/"]+)?\/(?:orders|documents|approvals|deliveries)(?:[#?"])|href="(?:\/p\/[^/"]+)?\/maker-po#/;

beforeEach(() => {
  session.user = { id: 'u-admin', role: 'admin' };
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  board.value = null;
  board.events = [];
  gate.value = null;
  workspaceFixture.value = null;
});

// ---------------------------------------------------------------------------
describe('§0 the menu keeps the lists only (the old screens left the operators\' menu)', () => {
  it('admin / staff: 発注の一覧・証跡の一覧 (+ the maker master for admin), no 文書・承認・メーカー発注・納品', async () => {
    const { navHrefsForRole, openableHrefsForRole } = await import('../apps/web/src/lib/navigation.js');
    for (const role of ['admin', 'staff']) {
      const hrefs = navHrefsForRole(role);
      for (const old of ['/documents', '/approvals', '/maker-po', '/deliveries']) expect(hrefs, `${role} ${old}`).not.toContain(old);
      expect(hrefs).toContain('/orders');
      expect(hrefs).toContain('/evidence');
      // The lists still open (from 発注の一覧 and the order screen): a dashboard link to them is kept.
      expect(openableHrefsForRole(role)).toEqual(expect.arrayContaining(['/documents', '/approvals', '/maker-po', '/deliveries']));
    }
  });

  it('viewer / auditor (no order screen, H10①) keep what they read, named 「（閲覧）」 — never a form screen', async () => {
    const { navGroupsForRole } = await import('../apps/web/src/lib/navigation.js');
    const labels = (role: string) => navGroupsForRole(role).flatMap((group) => group.items.map((item) => `${item.href}=${item.label}`));
    expect(labels('viewer')).toEqual(expect.arrayContaining(['/maker-po=メーカー発注（閲覧）', '/deliveries=納品・手数料（閲覧）']));
    expect(labels('auditor')).toEqual(expect.arrayContaining(['/approvals=承認（閲覧）', '/maker-po=メーカー発注（閲覧）']));
    expect(labels('viewer').join()).not.toContain('/documents');
  });

  it('the rendered sidebar of staff has no link to an old screen', async () => {
    const { SideNav } = await import('../apps/web/src/components/NavLinks.js');
    const { navGroupsForRole } = await import('../apps/web/src/lib/navigation.js');
    const html = renderToStaticMarkup(<SideNav groups={navGroupsForRole('staff')} roleNote={null} />);
    expect(html).toMatch(/href="(?:\/p\/PRJ-1)?\/orders"/);
    for (const old of ['documents', 'approvals', 'maker-po', 'deliveries']) expect(html).not.toMatch(new RegExp(`href="(?:/p/PRJ-1)?/${old}"`));
  });
});

// ---------------------------------------------------------------------------
describe('§0 steps 1–2 are recorded on the order screen (they linked /orders#seven-po-…)', () => {
  it('an unregistered PO: the 本登録 form in the panel, no link into the old list', () => {
    const html = panel('DRAFT', 'staff', { po: { ...PO, officiallyRegistered: false, verificationStatus: null } });
    expect(submitLabels(html)).toEqual(['本登録する']);
    expect(html).toContain('name="officialRegisteredAt"');
    expect(html).toContain('name="poId" value="po-1"');
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });

  it('a registered, unchecked PO: the 照合 checklist with its draft (M9) and a blank 突合結果 (no default 一致)', () => {
    const html = panel('DRAFT', 'admin', { po: { ...PO, verificationStatus: null } });
    expect(submitLabels(html)).toEqual(['照合チェックを記録する']);
    expect(html).toContain('name="issuerNameRecorded"');
    expect(html).toMatch(/<select[^>]*name="quoteMatchesPo"[^>]*required[^>]*><option value="">（選ぶ）<\/option>/);
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });

  it('a viewer gets no form (RoleGate), and the API still decides', () => {
    const html = panel('DRAFT', 'viewer', { po: { ...PO, officiallyRegistered: false, verificationStatus: null } });
    expect(html).not.toContain('<form');
  });
});

// ---------------------------------------------------------------------------
describe('§0 / M6 the exceptions are resolved in the panel (they linked /orders#order-…)', () => {
  it('ON_HOLD: the representative releases it here, with the reason; staff read who does it', () => {
    const admin = panel('ON_HOLD', 'admin', { order: { hold: { reason: '色見本待ち', reasonHidden: false, actorName: '担当', at: '2026-11-20T00:00:00Z' } } });
    expect(submitLabels(admin)).toEqual(['保留を解除する']);
    expect(admin).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(admin).toContain('<dialog class="confirm-dialog');
    expect(admin).not.toMatch(OLD_SCREEN_HREF);
    const staff = panel('ON_HOLD', 'staff');
    expect(staff).not.toContain('<form');
    expect(staff).toContain('代表');
  });

  it('CANCELLATION_REVIEW: the representative resumes or ends it here; ending is danger-toned', () => {
    const html = panel('CANCELLATION_REVIEW', 'admin');
    expect(submitLabels(html)).toEqual(['取消確認を処理する']);
    expect(html).toContain('<option value="cancel">取消で終了する（取消済・元に戻せません）</option>');
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });

  it('CHANGE_REVIEW: staff pick the state to resume from (the state it left first)', () => {
    const html = panel('CHANGE_REVIEW', 'staff', { order: { lastNormalStatus: 'APPROVAL_PENDING' } });
    expect(submitLabels(html)).toEqual(['この段階から再開する']);
    const options = [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
    expect(options[0]).toBe('');
    expect(options[1]).toBe('APPROVAL_PENDING');
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });
});

// ---------------------------------------------------------------------------
describe('§0 the representative checks PDF / image approval evidence at step 6 (it linked /approvals#manual-verification)', () => {
  const pendingGate = { ...GATE_ONE_DESIGN, designs: [{ ...GATE_ONE_DESIGN.designs[0], customer: slot(false, true), seven: slot(true) }], pendingManualVerifications: [PENDING] };
  it('admin: the facts (issuer, identifier) and the 確認／却下 form with the approval event, in the panel', () => {
    const html = panel('APPROVAL_PENDING', 'admin', { gate: pendingGate, documents: [{ id: 'doc-9', documentType: 'approval_evidence', filename: 'seal.pdf', verificationStatus: 'unverified', versions: [{ id: 'ver-9', versionNumber: 1 }] }] });
    expect(submitLabels(html)).toContain('手動確認を記録する');
    expect(html).toContain('name="approvalEventId" value="ev-1"');
    expect(html).toContain('seal.pdf（版1／');
    expect(html).toContain('SEAL-0001');
    // M13: the button names what it checks.
    expect(html).toContain('<span class="visually-hidden">（顧客・デザイン 表面A）</span>');
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });
});

// ---------------------------------------------------------------------------
describe('M6 「その他の操作」 on the order screen (止める・変更する・取り消す)', () => {
  function serveBoard(role: string, status: string, makerPurchaseOrders: unknown[] = []) {
    session.user = { id: `u-${role}`, role };
    const o = order(status, { lines: [] });
    board.value = {
      workspace: {
        error: null, project: null, labels: null, filmOrders: [o], fillingOrders: [], sevenPurchaseOrders: [PO],
        documents: [], revisions: [], approvalEvents: [], deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
      },
      boards: [{ order: o, closure: null, makerPurchaseOrders, makerPoError: null, paymentGate: null, paymentGateError: null }]
    };
    callApi.mockImplementation(async (apiPath: string) => apiPath.endsWith('/order-facts')
      ? ok({ orderedQuantity: '500', orderedUnit: 'meters', updatedAt: null })
      : apiPath.endsWith('/maker-recipient-addresses') ? ok({ projectId: 'project-a', maker: null })
        : ok({ events: [] }));
  }
  async function screen() {
    const element = await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started: false } as never);
    return render(element);
  }
  const section = (html: string) => /<section id="order-more"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

  it('staff at メーカー発注準備完了: 保留・変更確認・取消確認 as buttons (closed), each with its own form', async () => {
    serveBoard('staff', 'MAKER_PO_READY');
    const more = section(await screen());
    expect(more).toContain('その他の操作（止める・変更する・取り消す）');
    const buttons = [...more.matchAll(/<button type="button"[^>]*aria-expanded="(true|false)"[^>]*data-menu-item="([^"]+)"/g)].map((match) => `${match[2]}:${match[1]}`);
    expect(buttons).toEqual(['to-ON_HOLD:false', 'to-CHANGE_REVIEW:false', 'to-CANCELLATION_REVIEW:false']);
    // Each panel is hidden until its button opens it, and carries the transition with its target.
    expect(more.match(/<div[^>]*hidden=""[^>]*data-menu-panel="[^"]+"/g) ?? []).toHaveLength(3);
    expect(more).toContain('name="to" value="ON_HOLD"');
    expect(more).toMatch(/<textarea[^>]*name="holdReason"[^>]*required/);
    expect(more).toContain('name="to" value="CANCELLATION_REVIEW"');
    expect(more).toContain('confirm-dialog--danger');
    // No maker paper work for staff (maker_po:cancel is the representative's).
    expect(more).not.toContain('data-menu-item="maker-paper"');
  });

  it('admin with a live draft paper: the paper\'s cancellation is offered there too (the old maker list\'s form)', async () => {
    serveBoard('admin', 'MAKER_PO_READY', [{ id: 'mpo-1', status: 'DRAFT', displayNumber: 'MPO-2026-0001', filmSupplyOrderId: 'order-1', createdAt: '2026-11-20T00:00:00Z' }]);
    const more = section(await screen());
    expect(more).toContain('data-menu-item="maker-paper"');
    expect(more).toContain('>発注書を取り消す');
    expect(more).toMatch(/メーカー発注書 MPO-2026-0001 を取り消しますか？/);
  });

  // web2a review L-4 (p4/web3): the exception entries exist only in the normal flow. A gap filler (the base
  // passes it too); its effect is shown by the review's surviving mutant W4 (entries offered in every phase).
  it.each(['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW', 'FILM_RECEIPT_ASSUMED_NO_ISSUE', 'CANCELLED'])('L-4: at %s no 保留・変更確認・取消確認 entry is offered', async (status) => {
    serveBoard('admin', status);
    const html = await screen();
    expect(html).not.toMatch(/data-menu-item="to-(ON_HOLD|CHANGE_REVIEW|CANCELLATION_REVIEW)"/);
    expect(html).not.toContain('name="to" value="ON_HOLD"');
  });

  it('L-3 (p4/web3): the breadcrumb and the header links are 44px targets on the real order screen', async () => {
    serveBoard('staff', 'MAKER_PO_READY');
    const html = await screen();
    const crumbs = /<nav class="p1-crumbs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(crumbs).toMatch(/<a class="p4w3-target" translate="no" href="\/p\/PRJ-1">PRJ-1<\/a>/);
    const links = /<p class="p1-order-links">[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';
    expect(links.match(/<a\b[^>]*>/g)?.length).toBe(3);
    for (const link of links.match(/<a\b[^>]*>/g) ?? []) expect(link).toContain('class="p4w3-target"');
  });

  it('(e, p4/web3) a delivered order reads delivery-status: all confirmed → 「確認済みの納品で完了する」 without the 「証跡なし」 agreement', async () => {
    serveBoard('admin', 'FILM_DELIVERED');
    const base = callApi.getMockImplementation()!;
    callApi.mockImplementation(async (apiPath: string, init?: unknown) => apiPath.endsWith('/delivery-status')
      ? ok({ orderId: 'order-1', status: 'FILM_DELIVERED', receiptAssumption: null, receiptClosure: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false } })
      : base(apiPath, init));
    const html = await screen();
    expect(callApi.mock.calls.some((call) => String(call[0]) === '/api/film-supply-orders/order-1/delivery-status')).toBe(true);
    expect(html).toContain('data-closure="delivery_confirmations"');
    expect(submitLabels(html)).toContain('確認済みの納品で完了する');
    expect(html).not.toContain('name="acknowledgeNoEvidence"');
  });

  it('(e) an order before 納品済み never asks for delivery-status', async () => {
    serveBoard('admin', 'MAKER_PO_READY');
    await screen();
    expect(callApi.mock.calls.some((call) => String(call[0]).endsWith('/delivery-status'))).toBe(false);
  });

  it('viewer: no menu at all (and no form)', async () => {
    serveBoard('viewer', 'MAKER_PO_READY');
    const html = await screen();
    expect(html).not.toContain('id="order-more"');
  });

  it('the menu is a client disclosure: one panel open at a time, aria-expanded follows', async () => {
    const { SecondaryMenu } = await import('../apps/web/src/components/SecondaryMenu.js');
    const html = render(<SecondaryMenu id="m" title="その他" items={[{ key: 'a', label: 'A', content: <p>A form</p> }, { key: 'b', label: 'B', who: '代表のみ', content: <p>B form</p> }]} />);
    expect(html).toMatch(/<button type="button" class="ui-button--subtle p4w2-more-button" aria-expanded="false" aria-controls="[^"]+-a"/);
    expect(html).toContain('B<span class="p4w2-more-who">（代表のみ）</span>');
    expect(html.match(/hidden=""/g) ?? []).toHaveLength(2);
    expect(readSrc('components/SecondaryMenu.tsx')).toMatch(/setOpen\(\(current\) => \(current === item\.key \? null : item\.key\)\)/);
  });
});

// ---------------------------------------------------------------------------
describe('N9 a second design gets its proof while the first waits for approvals', () => {
  it('APPROVAL_PENDING: 「別のデザインを追加する」 under the 押印 slots, with the registered names', () => {
    const html = panel('APPROVAL_PENDING', 'staff', { gate: GATE_ONE_DESIGN });
    expect(html).toContain('別のデザインを追加する');
    expect(submitLabels(html)).toContain('このデザインの校正を登録する');
    expect(html).toContain('name="existingDesignKeys" value="[&quot;表面A&quot;]"');
    expect(html).toContain('name="currentStatus" value="APPROVAL_PENDING"');
  });

  it('a registered name is refused before any write; a new one registers the file and the 版 only (no transition)', async () => {
    const base = { orderId: 'order-1', sevenPurchaseOrderId: 'po-1', currentStatus: 'APPROVAL_PENDING', existingDesignKeys: '["表面A"]', ...FILE };
    const refused = await stepActions.submitProofStepAction(null, form({ ...base, designKey: '表面A' }));
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('登録済み');
    expect(callApi).not.toHaveBeenCalled();
    callApi.mockResolvedValueOnce(ok({ document: { id: 'doc-2' }, version: { id: 'ver-2' } })).mockResolvedValueOnce(ok({ revision: { id: 'rev-2' } }));
    const done = await stepActions.submitProofStepAction(null, form({ ...base, designKey: '裏面B' }));
    expect(done.ok).toBe(true);
    expect(paths()).toEqual(['/api/projects/project-a/documents', '/api/film-supply-orders/order-1/artwork-revisions']);
  });
});

// ---------------------------------------------------------------------------
describe('M13 a repeated button names its target (order code, デザイン名, organization)', () => {
  it('the 押印 slot buttons of two designs differ for a screen reader', () => {
    const two = { ...GATE_ONE_DESIGN, designs: [GATE_ONE_DESIGN.designs[0], { ...GATE_ONE_DESIGN.designs[0], designKey: '裏面B', currentRevisionId: 'rev-2' }] };
    const html = panel('APPROVAL_PENDING', 'staff', { gate: two });
    const contexts = [...html.matchAll(/顧客の承認を記録する<span class="visually-hidden">（([^）]+)）<\/span>/g)].map((match) => match[1]);
    expect(contexts).toEqual(['FSO-1・デザイン 表面A・顧客', 'FSO-1・デザイン 裏面B・顧客']);
  });

  it('the 承認箱 row says which organization and design (server item organization / designKey), the delivery item its line', async () => {
    const { taskFromServerItem, queueTarget } = await import('../apps/web/src/lib/representative-queue.js');
    const item = { kind: 'approval_evidence_verification', label: '承認証跡の確認', project: { id: 'p', code: 'PRJ-1' }, order: { id: 'o', code: 'FSO-1' }, organization: 'seven', designKey: '表面A' };
    expect(taskFromServerItem(item)?.target).toBe('セブン化学／デザイン 表面A');
    expect(queueTarget({ detail: { delivery: { line: { lineNumber: 1 }, display: '500 m' } } })).toBe('明細1／500 m');
    expect(queueTarget({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('M10① the send waits: both times to the second and the reason, in the step panel', () => {
  it('formatTimestampSeconds / sendApprovalGapText', async () => {
    const { formatTimestampSeconds, sendApprovalGapText } = await import('../apps/web/src/lib/vocabulary.js');
    expect(formatTimestampSeconds('2026-11-23T00:10:49Z')).toBe('2026/11/23 09:10:49 JST');
    expect(sendApprovalGapText('2026-11-23T00:10:49Z', '2026-11-23T00:11:19Z')).toBe('送信は代表承認の30秒前');
    expect(sendApprovalGapText('2026-11-23T00:12:19Z', '2026-11-23T00:11:19Z')).toBe('送信は代表承認の1分後');
    expect(sendApprovalGapText('2026-11-23T00:11:19.400Z', '2026-11-23T00:11:19Z')).toBe('送信は代表承認と同じ秒');
    expect(sendApprovalGapText(null, '2026-11-23T00:11:19Z')).toBeNull();
  });

  it('send_verify (admin): 送信日時 HH:MM:SS ／ 代表承認 HH:MM:SS（30秒前） and 待っている理由', () => {
    const maker = { id: 'mpo-1', status: 'APPROVED_FOR_MANUAL_SEND', ceoApprovedAt: '2026-11-23T00:11:19Z', displayNumber: 'MPO-2026-0001' };
    const event = { id: 'se-1', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION', sentAt: '2026-11-23T00:10:49Z', verificationNote: 'SENT_AT_PRECEDES_CEO_APPROVAL' };
    const html = panel('APPROVED_FOR_MANUAL_SEND', 'admin', { maker, makerPos: [maker], makerEvents: [event] });
    expect(html).toContain('<dt>送信日時</dt><dd>2026/11/23 09:10:49 JST</dd>');
    expect(html).toContain('<dt>代表承認</dt><dd>2026/11/23 09:11:19 JST（送信は代表承認の30秒前）</dd>');
    expect(html).toContain('<dt>待っている理由</dt><dd>SENT_AT_PRECEDES_CEO_APPROVAL</dd>');
    expect(submitLabels(html)).toEqual(['送信の確認を記録する']);
  });

  it('the maker list (stage lines and history) shows the send and approval times to the second too', async () => {
    const { makerPoStages } = await import('../apps/web/src/lib/maker-po-stage.js');
    const view = makerPoStages({
      orderStatus: 'MAKER_PO_SENT_MANUALLY',
      papers: [{ po: { id: 'mpo-1', status: 'MAKER_PO_SENT_MANUALLY', ceoApprovedAt: '2026-11-23T00:11:19Z', createdAt: '2026-11-23T00:00:00Z' }, events: [{ id: 'se-1', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'VERIFIED', sentAt: '2026-11-23T00:12:49Z' }], pendingVerification: false, confirmedVerification: null, acknowledgementOwed: false } as never]
    } as never);
    const summaries = view.stages.map((stage) => stage.summary).join(' ');
    expect(summaries).toContain('代表承認（2026/11/23 09:11:19 JST）');
    expect(summaries).toContain('送信日時 2026/11/23 09:12:49 JST');
    expect(code(readSrc('screens/MakerPoScreen.tsx'))).toContain('formatTimestampSeconds(sentEvent.sentAt)');
  });
});

// ---------------------------------------------------------------------------
describe('H14 step 12: the receipt evidence confirms the delivery (the main path), the fallback stays below', () => {
  const delivery = (id: string, confirmed = false) => ({ id, kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliverySequence: 1, deliveredAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', note: null, confirmed, evidenceDocumentVersionId: null, confirmedAt: null, detailsHidden: false, confirmationHidden: false });
  const receiptDoc = (uploadedBy: string, verificationStatus = 'unverified', makerPurchaseOrderId: string | null = null) => ({
    id: 'doc-r', documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: 'jyuryo.pdf', note: null, verificationStatus, verificationNote: null,
    sevenPurchaseOrderId: null, filmSupplyOrderId: 'order-1', designKey: null, makerPurchaseOrderId, uploadedByUserId: uploadedBy,
    detailsHidden: false, typeHidden: false, verificationHidden: false, createdAt: '2026-11-22T02:00:00Z', updatedAt: '2026-11-22T02:00:00Z',
    versions: [{ id: 'ver-r', documentId: 'doc-r', versionNumber: 1, sha256: null, sha256Hidden: true, originalFilename: 'jyuryo.pdf', createdAt: '2026-11-22T02:00:00Z', uploadedByUserId: uploadedBy }]
  });
  const context = (userId: string, deliveries = [delivery('del-1')], filmOnly = true) => ({ deliveries, userId, filmOnly, readiness: null, readinessLabel: (key: string) => key });

  it('receiptPlan (P-4): the representative confirms (own evidence too); staff never on their own — the queue takes it', async () => {
    const { receiptPlan, deliveryReceiptDocuments } = await import('../apps/web/src/components/DeliveryReceiptStep.js');
    const own = receiptDoc('u-staff');
    expect(receiptPlan('admin', 'u-admin', []).kind).toBe('upload_confirm');
    expect(receiptPlan('admin', 'u-admin', [own as never]).kind).toBe('confirm_existing');
    expect(receiptPlan('staff', 'u-staff', [own as never]).kind).toBe('wait_representative');
    expect(receiptPlan('staff', 'u-staff', [receiptDoc('u-other', 'verified') as never]).kind).toBe('confirm_existing');
    expect(receiptPlan('staff', 'u-staff', [receiptDoc('u-other') as never]).kind).toBe('upload_only');
    expect(receiptPlan('staff', 'u-staff', []).kind).toBe('upload_only');
    // Step 10's maker acceptance evidence (bound to the maker paper) is not the delivery's receipt.
    expect(deliveryReceiptDocuments([receiptDoc('u-staff', 'verified', 'mpo-1') as never], 'order-1')).toEqual([]);
    // Live check w02: staff do not read the maker-paper link — a document registered before the
    // delivery was recorded is step 10's, never the delivery's receipt.
    const early = { ...receiptDoc('u-admin', 'verified'), createdAt: '2026-11-21T00:00:00Z' };
    expect(deliveryReceiptDocuments([early as never], 'order-1', [delivery('del-1')])).toEqual([]);
    expect(deliveryReceiptDocuments([receiptDoc('u-admin') as never], 'order-1', [delivery('del-1')])).toHaveLength(1);
  });

  it('admin at 納品済み: 「受領証跡で納品を確認する」 with the file and its issuer; the evidence-free close is the quiet fallback', () => {
    const html = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin') });
    expect(submitLabels(html)).toEqual(['受領証跡で納品を確認する', '手数料準備の状態を評価し直す', '証跡なしで問題なしとして完了する']);
    expect(html).toContain('name="receiptMode" value="confirm"');
    expect(html).toContain('name="deliveryId" value="del-1"');
    expect(html).toContain('name="sevenPurchaseOrderId" value="po-1"');
    expect(html).toMatch(/<select[^>]*name="receiptIssuer"[^>]*required/);
    expect(html).toContain('<h3 class="p4w2-subtitle">受領の証跡がない場合</h3>');
    // WIG: irreversible — the confirmation asks first.
    expect(html).toContain('納品を確認済みにしますか？');
    expect(html).toMatch(/class="ui-button--subtle"[^>]*>証跡なしで問題なしとして完了する/);
    expect(html).toContain('フィルムの納品確認待ち');
    expect(html).not.toContain('充填製品');
    expect(html).toContain('フィルムのみの案件（充填の納品は対象外）');
    expect(html).not.toMatch(OLD_SCREEN_HREF);
  });

  it('staff with their own receipt evidence: waits for the representative (no confirm form); with none: registers it only', () => {
    const waiting = panel('FILM_DELIVERED', 'staff', { deliveryContext: context('u-staff'), documents: [receiptDoc('u-staff')] });
    expect(waiting).toContain('受領証跡「jyuryo.pdf」はあなたが登録したため、代表が確認します（代表の確認待ち）。');
    expect(submitLabels(waiting)).not.toContain('受領証跡で納品を確認する');
    const upload = panel('FILM_DELIVERED', 'staff', { deliveryContext: context('u-staff') });
    expect(submitLabels(upload)[0]).toBe('受領証跡を登録する（確認は代表）');
    expect(upload).toContain('name="receiptMode" value="register"');
  });

  it('all confirmed: the delivery says so, and the close is the primary button (the server\'s CLOSE_ORDER)', () => {
    const html = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', [delivery('del-1', true)]) });
    expect(html).toContain('フィルムの納品確認済み（受領証跡で数量を確認済み）');
    expect(submitLabels(html)).toEqual(['手数料準備の状態を評価し直す', '受領確認（問題なし）を記録して完了する']);
  });

  it('a closed order whose delivery is still unconfirmed is confirmed on its own screen (it said 「充填製品の納品確認待ち」 elsewhere)', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'admin', { deliveryContext: context('u-admin') });
    expect(submitLabels(html)).toEqual(['受領証跡で納品を確認する', '手数料準備の状態を評価し直す']);
    expect(html).toContain('納品・手数料の一覧（閲覧）');
  });

  it('confirmDeliveryReceiptStepAction (admin, new file): document → verify → each delivery → readiness, one derived key each', async () => {
    callApi.mockResolvedValueOnce(ok({ document: { id: 'doc-n' }, version: { id: 'ver-n' } }));
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, form({
      orderId: 'order-1', sevenPurchaseOrderId: 'po-1', deliveryId: ['del-1', 'del-2'], receiptMode: 'confirm', evaluateReadiness: 'true', receiptIssuer: 'customer_generated', ...FILE
    }));
    expect(result.ok).toBe(true);
    expect(paths()).toEqual([
      '/api/projects/project-a/documents',
      '/api/documents/doc-n/verify',
      '/api/film-deliveries/del-1/confirmation',
      '/api/film-deliveries/del-2/confirmation',
      '/api/projects/project-a/commission-readiness'
    ]);
    // Live check w03: the API registers an official evidence only with the order's PO link (422 otherwise).
    expect(callApi.mock.calls[0]![1]).toMatchObject({ body: { documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filmSupplyOrderId: 'order-1', sevenPurchaseOrderId: 'po-1' } });
    expect(callApi.mock.calls[2]![1]).toMatchObject({ body: { evidenceDocumentVersionId: 'ver-n' } });
    expect(callApi.mock.calls.map((call) => (call[1] as { idempotencyKey?: string }).idempotencyKey)).toEqual([1, 2, 3, 4, 5].map((n) => `${KEY}.${n}`));
  });

  it('staff (register): the document only — no verify, no confirmation (P-4); an existing verified one is not re-verified', async () => {
    const staff = await stepActions.confirmDeliveryReceiptStepAction(null, form({ orderId: 'order-1', receiptMode: 'register', receiptIssuer: 'maker', ...FILE }));
    expect(staff.ok).toBe(true);
    expect(staff.message).toContain('代表が確認します');
    expect(paths()).toEqual(['/api/projects/project-a/documents']);
    callApi.mockClear();
    await stepActions.confirmDeliveryReceiptStepAction(null, form({
      orderId: 'order-1', deliveryId: 'del-1', receiptMode: 'confirm', evidenceDocumentId: 'doc-r', evidenceDocumentVersionId: 'ver-r', evidenceVerified: 'true'
    }));
    expect(paths()).toEqual(['/api/film-deliveries/del-1/confirmation']);
  });

  it('refuses a file without its issuer, before any write', async () => {
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, form({ orderId: 'order-1', deliveryId: 'del-1', receiptMode: 'confirm', ...FILE }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('発行元');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('the delivery with its receipt in ONE submit (admin): deliveries → 納品済み → document → verify → confirm the new deliveries', async () => {
    callApi
      .mockResolvedValueOnce(ok({ id: 'del-new' }))
      .mockResolvedValueOnce(ok({ order: { id: 'order-1' } }))
      .mockResolvedValueOnce(ok({ document: { id: 'doc-n' }, version: { id: 'ver-n' } }));
    const result = await stepActions.recordDeliveryStepAction(null, form({
      orderId: 'order-1', sevenPurchaseOrderId: 'po-1', lineId: 'line-1', 'quantity_line-1': '500', 'unit_line-1': 'meters',
      receiptMode: 'confirm', evaluateReadiness: 'false', receiptIssuer: 'customer_generated', ...FILE
    }));
    expect(result.ok).toBe(true);
    expect(paths()).toEqual([
      '/api/film-supply-orders/order-1/deliveries',
      '/api/film-supply-orders/order-1/transitions',
      '/api/projects/project-a/documents',
      '/api/documents/doc-n/verify',
      '/api/film-deliveries/del-new/confirmation'
    ]);
  });

  it('the representative\'s queue opens a delivery confirmation at step 12, with its Korean line', async () => {
    const { taskFromServerItem, QUEUE_KIND_KO } = await import('../apps/web/src/lib/representative-queue.js');
    const task = taskFromServerItem({ kind: 'delivery_confirmation', label: '納品の確認', project: { id: 'p', code: 'PRJ-1' }, order: { id: 'o', code: 'FSO-1' }, detail: { delivery: { line: { lineNumber: 1 }, display: '500 m' } } });
    expect(task?.step).toBe(12);
    expect(task?.target).toBe('明細1／500 m');
    expect(QUEUE_KIND_KO.delivery_confirmation).toBe('납품 확인');
  });
});

// ---------------------------------------------------------------------------
describe('H14 ②③ the deliveries list: a film delivery reads as film; the filling form only where there is filling', () => {
  const filmDelivery = { id: 'del-1', kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliverySequence: 1, deliveredAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', note: null, confirmed: false, evidenceDocumentVersionId: null, confirmedAt: null, detailsHidden: false, confirmationHidden: false };
  function serve(fillingOrders: unknown[]) {
    workspaceFixture.value = {
      error: null, projectRefused: false, project: { id: 'project-a', code: 'PRJ-1', name: 'A', route: 'F1' }, labels: null,
      filmOrders: [order('FILM_DELIVERED')], fillingOrders, sevenPurchaseOrders: [PO], documents: [], revisions: [], approvalEvents: [],
      deliveries: [filmDelivery], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
  }
  async function deliveries(role: string) {
    session.user = { id: `u-${role}`, role };
    const { DeliveriesScreen } = await import('../apps/web/src/screens/DeliveriesScreen.js');
    return render(await DeliveriesScreen({ projectId: 'project-a', projectCode: 'PRJ-1' } as never));
  }

  it('film only: 「フィルムの納品確認待ち」, a link to step 12 of the order, and no filling (or film) record form', async () => {
    serve([]);
    const html = await deliveries('admin');
    expect(html).toContain('フィルムの納品確認待ち');
    expect(html).not.toContain('充填製品の納品確認待ち');
    expect(html).toMatch(/href="\/p\/PRJ-1\/o\/FSO-1\?step=12"[^>]*>発注の画面で確認する（手順12）/);
    expect(html).toContain('この案件は充填発注がないため、フィルムのみの案件です（充填の納品は対象外）。');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('>準備状態を再評価する</button>');
  });

  it('with a filling order: the filling delivery form stays (no filling order screen yet — the one exception)', async () => {
    serve([{ id: 'fill-1', code: 'FILL-1', lines: [{ id: 'fl-1', lineNumber: 1, description: 'カプセル', orderedQuantity: '100', unit: 'pods' }], detailsHidden: false, createdAt: '2026-11-01T00:00:00Z' }]);
    const html = await deliveries('staff');
    expect(html).toContain('充填製品納品');
    expect(html.match(/<form\b/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('フィルムのみの案件');
  });
});

// ---------------------------------------------------------------------------
/**
 * web2a review M-1 (p4/web3): the API writes each happy-path submit makes, measured from the real actions (H12 test).
 * 14 submits, 32 writes. The operator's count is the submits (≤ 15, UNRESOLVED H12); the writes are the chain
 * behind them (one derived Idempotency-Key each) and cannot be ≤ 15 without fewer server endpoints — pinned instead.
 */
const EXPECTED_WRITES: Record<string, number> = {
  '1–3 受付・照合・発注': 5, // PO, PDF, 照合, order, 確定
  '4 入稿': 2, // document, → ARTWORK_RECEIVED
  '5 校正': 4, // document, 版, → PROOF_READY, → APPROVAL_PENDING
  '6 顧客': 2, // evidence, approval
  '6 セブン化学': 2,
  '7 メーカー発注書': 1,
  '8 代表承認': 1,
  '9 送信': 1,
  '10 受入（仮）': 2, // evidence, provisional acceptance
  '10 最終受入': 3, // evidence, verify, accept-evidence
  '11 製造': 1,
  '11 出荷': 1,
  '12 納品': 6, // delivery, → FILM_DELIVERED, receipt evidence, verify, confirmation, readiness
  '12 完了': 1
};

describe('H12 / H2 / M2 the happy path is ≤ 15 submits on ONE screen (no step sends the operator to an old screen)', () => {
  // (status, role, extra, the one submit of the step). Steps 1–3 are the new-order wizard: 1 submit.
  const maker = (status: string, over: Record<string, unknown> = {}) => ({ id: 'mpo-1', status, displayNumber: 'MPO-2026-0001', ceoApprovedAt: '2026-11-23T00:11:19Z', ...over });
  const PATH: Array<[string, string, Parameters<typeof panel>[2], string]> = [
    ['SEVEN_PO_VERIFIED', 'staff', {}, 'デザイン入稿データを登録して、受領済みにする'],
    ['ARTWORK_RECEIVED', 'staff', {}, '校正を登録して校了の確認へ'],
    ['APPROVAL_PENDING', 'staff', { gate: GATE_ONE_DESIGN }, '顧客の承認を記録する'],
    ['APPROVAL_PENDING', 'staff', { gate: { ...GATE_ONE_DESIGN, designs: [{ ...GATE_ONE_DESIGN.designs[0], customer: slot(true) }] } }, 'セブン化学の承認を記録する'],
    ['MAKER_PO_READY', 'staff', {}, 'FSO-1 のメーカー発注書（下書き）を作る'],
    ['APPROVED_FOR_MANUAL_SEND', 'staff', { maker: maker('APPROVED_FOR_MANUAL_SEND'), makerPos: [maker('APPROVED_FOR_MANUAL_SEND')] }, '送信を記録する'],
    ['MAKER_PO_SENT_MANUALLY', 'staff', { maker: maker('MAKER_PO_SENT_MANUALLY'), makerPos: [maker('MAKER_PO_SENT_MANUALLY')] }, '受入記録（仮）を残す'],
    ['MAKER_PO_SENT_MANUALLY', 'admin', { maker: maker('MAKER_PO_SENT_MANUALLY'), makerPos: [maker('MAKER_PO_SENT_MANUALLY')], makerEvents: [{ id: 'pa', eventType: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL' }] }, 'メーカーの受注を確定する（最終受入）'],
    ['MAKER_PO_ACCEPTED', 'staff', {}, '製造開始を記録する'],
    ['FILM_IN_PRODUCTION', 'staff', {}, '出荷を記録する'],
    ['FILM_SHIPPED', 'admin', {}, '納品を記録する']
  ];

  // web2a review M-1 (p4/web3): the count is no longer a hand counter. Each step's FIRST form is read from the
  // rendered panel (its hidden fields as drawn), the operator's inputs are filled in, the step's real server
  // action runs against the mocked API, and every API write it makes (POST / PATCH / PUT / DELETE) is counted.
  const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
  /** The named fields of the n-th <form> of a markup, as the browser would post them (files are filled in below). */
  function formFields(html: string, index = 0): Array<[string, string]> {
    const markup = [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)][index]?.[0] ?? '';
    const out: Array<[string, string]> = [];
    for (const [, attrs] of markup.matchAll(/<input\b([^>]*)>/g)) {
      const name = attr(attrs!, 'name');
      const type = attr(attrs!, 'type') ?? 'text';
      if (!name || type === 'file') continue;
      if (type === 'checkbox' || type === 'radio') {
        if (/\bchecked=""/.test(attrs!)) out.push([name, decode(attr(attrs!, 'value') ?? 'on')]);
        continue;
      }
      out.push([name, decode(attr(attrs!, 'value') ?? '')]);
    }
    for (const [, attrs, body] of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attr(attrs!, 'name');
      const options = [...body!.matchAll(/<option\b([^>]*)>/g)].map((match) => match[1]!);
      const chosen = options.find((option) => /\bselected=""/.test(option)) ?? options.find((option) => (attr(option, 'value') ?? '') !== '');
      if (name) out.push([name, decode(chosen ? attr(chosen, 'value') ?? '' : '')]);
    }
    for (const [, attrs, body] of markup.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const name = attr(attrs!, 'name');
      if (name) out.push([name, decode(body!)]);
    }
    return out;
  }
  function filled(html: string, typed: Record<string, string>, index = 0): FormData {
    const data = new FormData();
    data.set(IDEMPOTENCY_FIELD, KEY);
    for (const [name, value] of formFields(html, index)) if (!(name in typed)) data.append(name, value);
    for (const [name, value] of Object.entries(typed)) data.set(name, value);
    return data;
  }
  /** The API as the chains need it: each write answers the record it created (ids the next write uses). */
  function serveWrites() {
    callApi.mockImplementation(async (url: string, init?: { method?: string; body?: Record<string, unknown> }) => {
      if (!init?.method || init.method === 'GET') return ok({});
      if (/\/seven-purchase-orders$/.test(url)) return ok({ id: 'po-1' }, 201);
      if (/\/documents$/.test(url)) return ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } }, 201);
      if (/\/film-supply-orders$/.test(url)) return ok({ id: 'order-1', code: 'FSO-1', status: 'DRAFT' }, 201);
      if (/\/artwork-revisions$/.test(url)) return ok({ revision: { id: 'rev-1' } }, 201);
      if (/\/maker-purchase-orders$/.test(url)) return ok({ purchaseOrder: { id: 'mpo-1' } }, 201);
      if (/\/deliveries$/.test(url)) return ok({ id: 'del-1' }, 201);
      if (/\/transitions$/.test(url)) return ok({ order: { id: 'order-1', status: init.body?.to } });
      return ok({ id: 'row-1' });
    });
  }
  const writeCalls = () => callApi.mock.calls.filter((call) => {
    const method = (call[1] as { method?: string } | undefined)?.method;
    return method !== undefined && method !== 'GET';
  });
  const writes = () => writeCalls().length;
  /** p4/web4 (web3 review L-3): the Idempotency-Key of every write the last submit made. */
  const writeKeys = () => writeCalls().map((call) => (call[1] as { idempotencyKey?: string }).idempotencyKey);
  const ATTACHED = { contentBase64: B64, filename: 'evidence.pdf', contentType: 'application/pdf' };
  const MAIL = { contentBase64: Buffer.from('From: a@customer.example\r\nMessage-ID: <m1@customer.example>\r\nDate: Thu, 20 Nov 2026 10:00:00 +0900\r\n\r\nOK').toString('base64'), filename: 'approval.eml', contentType: 'message/rfc822', mailMessageId: '<m1@customer.example>', mailDate: '2026-11-20T01:00:00.000Z' };

  it('the happy path: ≤ 15 submits on the order screen, each one counted by the API writes its real action makes', async () => {
    const maker = (status: string, over: Record<string, unknown> = {}) => ({ id: 'mpo-1', status, displayNumber: 'MPO-2026-0001', ceoApprovedAt: '2026-11-23T00:11:19Z', ...over });
    const approvalActions = await import('../apps/web/src/app/approval-actions.js');
    const actions = await import('../apps/web/src/app/actions.js');
    const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
    const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
    const sent = maker('MAKER_PO_SENT_MANUALLY');
    type Step = { name: string; html: string; label: string; action: (prev: null, data: FormData) => Promise<{ ok: boolean; message?: string }>; typed?: Record<string, string> };
    const steps: Step[] = [
      { name: '4 入稿', html: panel('SEVEN_PO_VERIFIED', 'staff'), label: 'デザイン入稿データを登録して、受領済みにする', action: stepActions.submitArtworkStepAction, typed: { ...ATTACHED, designKey: '表面A' } },
      { name: '5 校正', html: panel('ARTWORK_RECEIVED', 'staff'), label: '校正を登録して校了の確認へ', action: stepActions.submitProofStepAction, typed: { ...ATTACHED, designKey: '表面A' } },
      { name: '6 顧客', html: panel('APPROVAL_PENDING', 'staff', { gate: GATE_ONE_DESIGN }), label: '顧客の承認を記録する', action: stepActions.recordApprovalStepAction, typed: { ...MAIL, evidenceIssuer: 'customer_generated' } },
      { name: '6 セブン化学', html: panel('APPROVAL_PENDING', 'staff', { gate: { ...GATE_ONE_DESIGN, designs: [{ ...GATE_ONE_DESIGN.designs[0], customer: slot(true) }] } }), label: 'セブン化学の承認を記録する', action: stepActions.recordApprovalStepAction, typed: { ...MAIL, evidenceIssuer: 'seven' } },
      { name: '7 メーカー発注書', html: panel('MAKER_PO_READY', 'staff'), label: 'FSO-1 のメーカー発注書（下書き）を作る', action: stepActions.createMakerPoStepAction, typed: { recipientAddress: 'order@maker.example' } },
      {
        name: '8 代表承認',
        html: render(<ApprovalCard korean={false} card={{
          source: 'server', poId: 'mpo-1', orderId: 'order-1', displayNumber: 'MPO-2026-0001', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid', amountDisplay: '¥312,000',
          items: [], artworkFiles: [], recipient: { address: 'order@maker.example', isEmail: true }, sevenPo: null, designs: [], dualApproved: true,
          blockers: [], warnings: [], canApprove: true, canReturn: true, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: 'a'.repeat(64)
        } as never} />),
        label: 'MPO-2026-0001 を代表承認する',
        action: approvalActions.approveFromCardAction
      },
      { name: '9 送信', html: panel('APPROVED_FOR_MANUAL_SEND', 'staff', { maker: maker('APPROVED_FOR_MANUAL_SEND'), makerPos: [maker('APPROVED_FOR_MANUAL_SEND')] }), label: '送信を記録する', action: makerActions.recordMakerPoSendEvidenceAction as never, typed: { ...MAIL, senderAddress: 'staff@kanei.example', recipients: 'order@maker.example', sentAt: '2026-11-23T10:00:00+09:00' } },
      { name: '10 受入（仮）', html: panel('MAKER_PO_SENT_MANUALLY', 'staff', { maker: sent, makerPos: [sent] }), label: '受入記録（仮）を残す', action: stepActions.recordAcceptanceStepAction, typed: { ...ATTACHED } },
      { name: '10 最終受入', html: panel('MAKER_PO_SENT_MANUALLY', 'admin', { maker: sent, makerPos: [sent], makerEvents: [{ id: 'pa', eventType: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL' }] }), label: 'メーカーの受注を確定する（最終受入）', action: stepActions.recordAcceptanceStepAction, typed: { ...ATTACHED } },
      { name: '11 製造', html: panel('MAKER_PO_ACCEPTED', 'staff'), label: '製造開始を記録する', action: actions.transitionFilmSupplyOrderAction },
      { name: '11 出荷', html: panel('FILM_IN_PRODUCTION', 'staff'), label: '出荷を記録する', action: actions.transitionFilmSupplyOrderAction },
      // 12: the delivery with its receipt evidence in the same submit (H14): delivery → 納品済み → evidence → verify → confirm → readiness.
      { name: '12 納品', html: panel('FILM_SHIPPED', 'admin'), label: '納品を記録する', action: stepActions.recordDeliveryStepAction, typed: { ...ATTACHED, receiptIssuer: 'customer_generated', 'quantity_line-1': '500' } },
      // 12: the completion on the confirmed deliveries (p4/web3 e: no 「証跡なし」 acknowledgment).
      {
        name: '12 完了',
        html: panel('FILM_DELIVERED', 'admin', { deliveryContext: { deliveries: [{ id: 'del-1', kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliveredAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', confirmed: true, confirmationHidden: false, detailsHidden: false }], userId: 'u-admin', filmOnly: true, readiness: null, readinessLabel: (key: string) => key, closure: { pending: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, recorded: null } } }),
        label: '確認済みの納品で完了する',
        action: actions.assumeFilmReceiptAction,
        typed: { note: '受領書で確認' }
      }
    ];
    // Steps 1–3 are the new-order wizard: ONE submit (受付 → PDF → 照合 → 発注 → 確定).
    serveWrites();
    const wizard = await stepActions.startFilmOrderAction(null, form({
      projectCode: 'PRJ-1', poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', code: 'FSO-1', paymentTerms: 'prepaid',
      lines: JSON.stringify([{ description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }]), ...FILE
    }));
    expect(wizard.ok, wizard.message).toBe(true);
    const perSubmit: Array<[string, number]> = [['1–3 受付・照合・発注', writes()]];
    const submitKeys: Array<[string, Array<string | undefined>]> = [['1–3 受付・照合・発注', writeKeys()]];
    for (const step of steps) {
      const index = submitLabels(step.html).indexOf(step.label);
      expect(index, `${step.name}: the step's button`).toBeGreaterThanOrEqual(0);
      expect(step.html, step.name).not.toMatch(OLD_SCREEN_HREF);
      callApi.mockReset();
      serveWrites();
      const result = await step.action(null, filled(step.html, step.typed ?? {}, index));
      expect(result.ok, `${step.name}: ${result.message ?? ''}`).toBe(true);
      perSubmit.push([step.name, writes()]);
      submitKeys.push([step.name, writeKeys()]);
    }
    // Every submit writes (a submit that writes nothing would not be a step), and the operator submits ≤ 15 times.
    expect(perSubmit.every(([, count]) => count >= 1), JSON.stringify(perSubmit)).toBe(true);
    expect(perSubmit.length).toBeLessThanOrEqual(15);
    const total = perSubmit.reduce((sum, [, count]) => sum + count, 0);
    // The writes behind those submits, pinned: a write added to (or dropped from) any step's chain fails here.
    expect(Object.fromEntries(perSubmit), `total ${total}`).toEqual(EXPECTED_WRITES);
    // p4/web4 (web3 review L-3): and every one of those writes carries a key derived from the form's own key
    // (the chain's `${KEY}.n`, its fallback `${KEY}.na`, the amount write `${KEY}.amounts`, or the key itself for a single
    // write) — different within a submit — so "32 writes" really is "14 submits' chains", never a new submit hiding behind one.
    const keyShape = new RegExp(`^${KEY}(\\.\\d+a?|\\.amounts)?$`);
    for (const [name, keys] of submitKeys) {
      expect(keys.every((key) => typeof key === 'string' && keyShape.test(key)), `${name}: ${JSON.stringify(keys)}`).toBe(true);
      expect(new Set(keys).size, `${name}: one key per write`).toBe(keys.length);
    }
    expect(submitKeys.filter(([, keys]) => keys.length > 1).length, 'the chained steps').toBeGreaterThanOrEqual(8);
  });

  it('the exceptional steps stay on the order screen too (evidence check, hold, cancellation review, change review, steps 1–2)', () => {
    const pendingGate = { ...GATE_ONE_DESIGN, designs: [{ ...GATE_ONE_DESIGN.designs[0], customer: slot(false, true), seven: slot(true) }], pendingManualVerifications: [PENDING] };
    const screens = [
      panel('DRAFT', 'staff', { po: { ...PO, officiallyRegistered: false, verificationStatus: null } }),
      panel('DRAFT', 'staff', { po: { ...PO, verificationStatus: null } }),
      panel('APPROVAL_PENDING', 'admin', { gate: pendingGate }),
      panel('ON_HOLD', 'admin'),
      panel('CANCELLATION_REVIEW', 'admin'),
      panel('CHANGE_REVIEW', 'staff', { order: { lastNormalStatus: 'APPROVAL_PENDING' } })
    ];
    for (const html of screens) {
      expect(html).not.toMatch(OLD_SCREEN_HREF);
      expect(submitLabels(html).length).toBeGreaterThan(0);
    }
  });

  it('H2 / M2: no screen draws the old 文書 upload (形式 select, 種類 default) or a typed デザインキー（必須） any more', () => {
    const screenCode = ['screens/DocumentsScreen.tsx', 'screens/ApprovalsScreen.tsx', 'screens/OrderDetailScreen.tsx', 'components/StepPanel.tsx'].map((rel) => code(readSrc(rel))).join('\n');
    expect(screenCode).not.toContain('<DocumentUploadForm');
    expect(screenCode).not.toContain('デザインキー（必須）');
    expect(screenCode).not.toMatch(/<ApprovalDecisionForm\b/);
  });
});

// ---------------------------------------------------------------------------
describe('L5 / L6 leftovers', () => {
  it('L6: no circled step glyph (①–⑤) in any screen, component, lib or action source outside comments', () => {
    const files = sources(root).filter((file) => !file.endsWith('.css'));
    const hits = files.filter((file) => /[①②③④⑤]/.test(code(readFileSync(file, 'utf8'))));
    expect(hits.map((file) => path.relative(root, file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('H3 (one line): the other dashboards read the server queue', () => {
  it.each(['app/dashboard/page.tsx', 'screens/OrdersScreen.tsx', 'screens/ProjectOverviewScreen.tsx', 'screens/HomeScreen.tsx'])('%s asks for { server: true }', (file) => {
    expect(code(readSrc(file))).toMatch(/loadRepresentativeQueue\([\s\S]*?\{ server: true \}\)/);
  });
});
