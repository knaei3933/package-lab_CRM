import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/** P1 R20/R21 static render: timeline, ProjectNotFound and the step panel. */
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'user' }),
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, usePathname: () => '/p/PRJ-1/o/FSO-1', useRouter: () => ({ refresh: () => undefined }) }));

const { OrderTimeline } = await import('../apps/web/src/components/OrderTimeline.js');
const { ProjectNotFound, PROJECT_NOT_FOUND_TITLE } = await import('../apps/web/src/components/ProjectNotFound.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { buildOrderFlow, ORDER_STEPS } = await import('../apps/web/src/lib/order-flow.js');
const { RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');

const PO = { id: 'po-1', poNumber: 'N', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };

function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'ord-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '300.000', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: null, paymentTerms: 'prepaid', createdAt: '', updatedAt: '', ...extra
  };
}

function panelFor(status: string, role: string, over: { orderExtra?: Record<string, unknown>; gate?: unknown; makerPos?: unknown[]; makerEvents?: unknown[]; maker?: unknown; approvalCard?: unknown } = {}) {
  const o = order(status, over.orderExtra ?? {});
  const makerPos = over.makerPos ?? [];
  const flow = buildOrderFlow({
    order: o as never, role, po: PO as never, documents: [], revisions: [], gate: (over.gate ?? null) as never,
    makerPos: makerPos as never, makerEvents: (over.makerEvents ?? []) as never, settledSendEventIds: new Set(), paymentGate: null, deliveries: []
  });
  return renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'proj-RENDERED', showKorean: false }}>
      <StepPanelView
        flow={flow} order={o as never} projectCode="PRJ-1" role={role} po={PO as never} gate={(over.gate ?? null) as never}
        maker={(over.maker ?? makerPos[0] ?? null) as never} makerEvents={(over.makerEvents ?? []) as never} documents={[]} stateLabel={(key) => key}
        approvalCard={(over.approvalCard ?? null) as never}
      />
    </RenderedContextProvider>
  );
}

describe('OrderTimeline', () => {
  const marks = (current: number) => ORDER_STEPS.map((step) => step.no < current ? 'done' : step.no === current ? 'current' : 'upcoming') as never;

  it('renders 12 ordered steps with the step titles', () => {
    const html = renderToStaticMarkup(<OrderTimeline marks={marks(6)} current={6} />);
    expect(html.startsWith('<ol')).toBe(true);
    expect(html.match(/<li /g)).toHaveLength(12);
    for (const step of ORDER_STEPS) expect(html).toContain(step.title);
  });

  it('puts aria-current="step" on the current step only', () => {
    const html = renderToStaticMarkup(<OrderTimeline marks={marks(6)} current={6} />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    const current = /<li[^>]*aria-current="step"[^>]*>(.*?)<\/li>/.exec(html)![1]!;
    expect(current).toContain('校了');
    expect(current).toContain('いま');
  });

  it('writes out the done marks (済) rather than relying on colour', () => {
    const html = renderToStaticMarkup(<OrderTimeline marks={marks(4)} current={4} />);
    expect(html.match(/>済</g)).toHaveLength(3);
  });

  it('marks an interrupted step in words and gives it no aria-current', () => {
    const interrupted = ORDER_STEPS.map((step) => step.no < 3 ? 'done' : step.no === 3 ? 'interrupted' : 'upcoming') as never;
    const html = renderToStaticMarkup(<OrderTimeline marks={interrupted} current={3} />);
    expect(html).toContain('中断');
    expect(html).not.toContain('aria-current');
  });

  it('has no current step when the flow has none', () => {
    const html = renderToStaticMarkup(<OrderTimeline marks={Array(12).fill('unknown') as never} current={null} />);
    expect(html).not.toContain('aria-current');
    expect(html).not.toContain('いま');
  });
});

describe('ProjectNotFound', () => {
  const projects = [
    { id: 'p1', code: 'PRJ-1', name: '案件その1', status: 'ACTIVE' },
    { id: 'p2', code: '案件B', name: 'B', status: 'ACTIVE' }
  ];

  it('says the project is not found and links every openable project to /p/{code}', () => {
    const html = renderToStaticMarkup(<ProjectNotFound code="TYPO" projects={projects} listError={null} />);
    expect(html).toContain(PROJECT_NOT_FOUND_TITLE);
    expect(html).toContain('TYPO');
    expect(html).toContain('href="/p/PRJ-1"');
    expect(html).toContain(`href="/p/${encodeURIComponent('案件B')}"`);
  });

  it('tells the operator when there is no project to open', () => {
    const html = renderToStaticMarkup(<ProjectNotFound code="X" projects={[]} listError={null} />);
    expect(html).toContain('開ける案件はありません');
    expect(html).not.toContain('<ul');
  });

  it('says the list could not be read (not "no projects") when the read failed', () => {
    const html = renderToStaticMarkup(<ProjectNotFound code={null} projects={[]} listError="timeout" />);
    expect(html).toContain('案件の一覧を読み込めませんでした');
    expect(html).toContain('timeout');
    expect(html).not.toContain(PROJECT_NOT_FOUND_TITLE);
    expect(html).not.toContain('開ける案件はありません');
  });

  it('works for an address with no decodable code', () => {
    const html = renderToStaticMarkup(<ProjectNotFound code={null} projects={projects} listError={null} />);
    expect(html).toContain('このアドレスの案件は');
    expect(html).toContain('href="/p/PRJ-1"');
  });
});

describe('StepPanelView', () => {
  it('shows an admin the maker paper form with recipient and amount fields and the order ids', () => {
    const html = panelFor('DUAL_APPROVED', 'admin');
    expect(html).toContain('name="recipientAddress"');
    expect(html).toContain('name="totalAmount"');
    expect(html).toContain('name="orderId" value="ord-1"');
    expect(html).toContain('name="projectCode" value="PRJ-1"');
    expect(html).toContain('name="needsReadyTransition" value="true"');
  });

  it('carries the rendered project id of the URL project in every form', () => {
    const html = panelFor('DUAL_APPROVED', 'admin');
    expect(html).toContain(`name="${RENDERED_PROJECT_FIELD}" value="proj-RENDERED"`);
  });

  it('shows staff the waiting text, not a form, for the representative step (代表承認)', () => {
    const maker = { id: 'mpo-1', status: 'DRAFT', snapshot: { amounts: null, items: [], specs: { artworkFiles: [] } } };
    const html = panelFor('MAKER_PO_READY', 'staff', { makerPos: [maker] });
    expect(html).toContain('代表の確認・承認を待っています');
    expect(html).not.toContain('<form');
  });

  it('P-6: staff draw up the maker paper themselves — without an amount field (amounts are the representative’s)', () => {
    const html = panelFor('DUAL_APPROVED', 'staff');
    expect(html).toContain('name="recipientAddress"');
    expect(html).not.toContain('name="totalAmount"');
    expect(panelFor('DUAL_APPROVED', 'admin')).toContain('name="totalAmount"');
  });

  it('shows a viewer the waiting text and no form on a staff step', () => {
    const html = panelFor('ARTWORK_RECEIVED', 'viewer');
    expect(html).toContain('担当者の記録を待っています');
    expect(html).not.toContain('<form');
  });

  it('shows the proof form with a file input that has no name (the file is posted as base64 fields)', () => {
    const html = panelFor('ARTWORK_RECEIVED', 'staff');
    expect(html).toContain('name="designKey"');
    expect(html).toContain('name="sevenPurchaseOrderId" value="po-1"');
    expect(html).toContain('name="currentStatus" value="ARTWORK_RECEIVED"');
    const fileInput = /<input[^>]*type="file"[^>]*>/.exec(html)![0];
    expect(fileInput).not.toMatch(/\sname=/);
  });

  it('blocks on undetermined payment terms: reason and a terms form for staff, waiting only for a viewer', () => {
    const staff = panelFor('DUAL_APPROVED', 'staff', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(staff).toContain('進められません');
    expect(staff).toContain('name="paymentTerms"');
    const viewer = panelFor('DUAL_APPROVED', 'viewer', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(viewer).toContain('進められません');
    expect(viewer).not.toContain('<form');
    expect(viewer).not.toContain('name="paymentTerms"');
  });

  it('shows one approval form per open slot with the organization fixed in a hidden field', () => {
    const gate = {
      designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, customer: { valid: false, pendingEvidenceIdentifier: false }, seven: { valid: true, pendingEvidenceIdentifier: false } }],
      pendingManualVerifications: []
    };
    const html = panelFor('APPROVAL_PENDING', 'staff', { gate });
    expect(html.match(/name="organization"/g)).toHaveLength(1);
    expect(html).toContain('name="organization" value="customer"');
    expect(html).not.toContain('name="organization" value="seven"');
    expect(html).toContain('name="revisionId" value="rev-1"');
    expect(html).toContain('承認済み');
  });

  it('shows the delivery form with the line quantity in plain digits', () => {
    const html = panelFor('FILM_SHIPPED', 'staff');
    expect(html).toContain('name="quantity_line-1"');
    expect(html).toContain('value="300"');
    expect(html).not.toContain('300.000');
  });

  it('shows the finished text for the terminal state with no form', () => {
    const html = panelFor('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'admin');
    expect(html).toContain('すべての手順が終わりました');
    expect(html).not.toContain('<form');
  });

  it('shows the cancelled text for CANCELLED', () => {
    expect(panelFor('CANCELLED', 'admin')).toContain('取消で終了しました');
  });

  it('shows the representative the ceo approval facts and the approve form (P1 R24 card)', async () => {
    const { cardFromWeb } = await import('../apps/web/src/lib/approval-card.js');
    const maker = { id: 'mpo-1', status: 'DRAFT', snapshot: { amounts: { currency: 'JPY', totalAmount: '480000' }, recipient: { address: 'order@maker.example' }, items: [{ lineNumber: 1, description: 'film', orderedQuantity: '300.000', unit: 'meters' }], specs: { artworkFiles: [] } } };
    const approvalCard = cardFromWeb({ paper: maker as never, orderCode: 'FSO-1', paymentTerms: 'prepaid', gate: null, sevenPo: null });
    const html = panelFor('MAKER_PO_READY', 'admin', { makerPos: [maker], approvalCard });
    expect(html).toMatch(/[¥￥]480,000/);
    expect(html).toContain('300 m');
    expect(html).toContain('name="expectedPaymentTerms" value="prepaid"');
    expect(html).toContain('name="poId" value="mpo-1"');
  });

  describe.each([
    ['DRAFT', 'staff', {}],
    ['SEVEN_PO_VERIFIED', 'staff', {}],
    ['ARTWORK_RECEIVED', 'staff', {}],
    ['DUAL_APPROVED', 'admin', {}],
    ['DUAL_APPROVED', 'staff', {}],
    ['FILM_SHIPPED', 'staff', {}],
    ['FILM_DELIVERED', 'admin', {}],
    ['ON_HOLD', 'admin', {}],
    ['CHANGE_REVIEW', 'staff', {}],
    ['MAKER_PO_ACCEPTED', 'staff', {}]
  ] as Array<[string, string, Record<string, unknown>]>)('%s as %s', (status, role, over) => {
    it('has no <details> and no <table> in the panel', () => {
      const html = panelFor(status, role, over);
      expect(html).not.toContain('<details');
      expect(html).not.toContain('<table');
    });
  });
});
