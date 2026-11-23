import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4 web 1 (audit44 UNRESOLVED.md, base 4468628): the web-only leftovers of the 44 frictions. One
 * describe per item id, each holding a test that fails on the base commit and passes with the fix
 * (mutation evidence: demo-eml/p4-web1/evidence/mutation-*.log). Server rules, amounts and the
 * idempotency semantics are untouched; amounts appear only in the admin-only paths they already had.
 */
const callApi = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'user' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => ({ get: (name: string) => cookieJar.headers[name.toLowerCase()] ?? null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
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
/** The source with its comments removed (a word in a comment is not on a screen). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { buildDashboard, daysPastDate, STALE_BASIS, TODO_SCOPE } = await import('../apps/web/src/lib/dashboard.js');
const { mergeDeliveryDates, nextActionForOrder } = await import('../apps/web/src/lib/project-data.js');
const { PaymentTermsChange, OrderTermsSection } = await import('../apps/web/src/components/OrderTermsSection.js');

type Input = Parameters<typeof buildDashboard>[0];
type Order = Input['workspace']['filmOrders'][number];

const NOW = new Date('2026-11-20T03:00:00.000Z');
const RECENT = '2026-11-19T01:00:00.000Z';
const LABELS = {
  filmSupplyOrderStates: [
    { key: 'DRAFT', label: '下書き' },
    { key: 'MAKER_PO_READY', label: 'メーカー発注準備完了' },
    { key: 'MAKER_PO_ACCEPTED', label: 'メーカー受注確認済み' }
  ],
  makerPurchaseOrderStatuses: [],
  commissionReadinessStates: [],
  fillingDeliveryConfirmationStates: [],
  approvalOrganizations: []
};

function order(id: string, status: string, extra: Partial<Order> = {}): Order {
  return {
    id, code: `FSO-${id}`, status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: `${id}-l1`, lineNumber: 1, description: '合成フィルム', orderedQuantity: '1000', unit: 'sheets' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: status, hold: null,
    paymentTerms: 'prepaid', paymentTermsHidden: false, createdAt: RECENT, updatedAt: RECENT,
    ...extra
  } as Order;
}

const PO = {
  id: 'po-1', poNumber: 'SEVEN-1', poNumberHidden: false, officialRegisteredAt: '2026-11-14', officiallyRegistered: true,
  verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false
};

function input(role: string | null, orders: Order[], extra: Partial<Input> = {}, pos: unknown[] = [PO]): Input {
  return {
    role,
    workspace: {
      labels: LABELS, filmOrders: orders, sevenPurchaseOrders: pos as never, revisions: [], revisionsWithheld: 0,
      documents: [], deliveries: [], readiness: null
    },
    boards: [],
    activity: [],
    now: NOW,
    ...extra
  } as Input;
}

beforeEach(() => {
  callApi.mockReset();
  cookieJar.headers = {};
});

// ---------------------------------------------------------------------------------------------
describe('B1① 「未定」 is in 「止まっている」 from creation on, whatever the status', () => {
  it('mergeDeliveryDates reads the list row: attention PAYMENT_TERMS_UNDETERMINED → true, none → false, no list → unknown', () => {
    const rows = [order('a', 'DRAFT'), order('b', 'DRAFT'), order('c', 'DRAFT')];
    const list = new Map<string, never>([
      ['a', { id: 'a', attention: [{ code: 'PAYMENT_TERMS_UNDETERMINED' }] } as never],
      ['b', { id: 'b', attention: [] } as never]
    ]);
    mergeDeliveryDates(rows as never, list);
    expect(rows.map((row) => row.paymentTermsUndetermined)).toEqual([true, false, undefined]);
    mergeDeliveryDates(rows as never, null);
    expect(rows.map((row) => row.paymentTermsUndetermined)).toEqual([undefined, undefined, undefined]);
  });

  it('a DRAFT order with an undetermined term is listed as blocked, linking its own screen (never an old address)', () => {
    const view = buildDashboard(input('admin', [order('a', 'DRAFT', { paymentTerms: 'undetermined', paymentTermsUndetermined: true })], { projectCode: 'PRJ-1' }));
    const item = view.blocked.find((entry) => entry.key === 'terms-a');
    expect(item).toBeDefined();
    expect(item!.title).toContain('未定');
    expect(item!.href).toBe('/p/PRJ-1/o/FSO-a');
    expect(item!.href).not.toContain('/orders#');
  });

  it('is claimed only when the API said so: a decided term, an unread list and a finished order add nothing', () => {
    const none = buildDashboard(input('admin', [
      order('d', 'DRAFT', { paymentTermsUndetermined: false }),
      order('u', 'DRAFT'),
      order('x', 'CANCELLED', { paymentTermsUndetermined: true })
    ]));
    expect(none.blocked.filter((entry) => entry.key.startsWith('terms-'))).toEqual([]);
  });

  it('the maker-ready order stays listed once (the gate item), not twice', () => {
    const board = { order: { id: 'r' }, makerPurchaseOrders: [], paymentGate: { paymentTerms: 'undetermined', gate: { satisfied: false, reason: '未定' } } };
    const view = buildDashboard(input('admin', [order('r', 'MAKER_PO_READY', { paymentTermsUndetermined: true })], { boards: [board as never] }));
    expect(view.blocked.filter((entry) => entry.orderCode === 'FSO-r')).toHaveLength(1);
  });
});

describe('B1② 「支払条件を変更する」 on the order screen', () => {
  const baseOrder = { id: 'ord-1', code: 'FSO-1', paymentTerms: 'undetermined', paymentTermsUndetermined: true };
  const render = (props: { role: string | null; order?: Record<string, unknown>; cancelled?: boolean }) => renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
      <PaymentTermsChange order={{ ...baseOrder, ...(props.order ?? {}) } as never} role={props.role} cancelled={props.cancelled ?? false} />
    </RenderedContextProvider>
  );

  it('admin and staff get the form, open while the term is 「未定」, with the three choices and the order id', () => {
    for (const role of ['admin', 'staff']) {
      const html = render({ role });
      expect(html, role).toContain('<details class="p4-terms-change" open="">');
      expect(html).toContain('支払条件を変更する');
      expect(html).toContain('name="paymentTerms"');
      expect(html).toContain('value="prepaid"');
      expect(html).toContain('value="on_delivery"');
      expect(html).toContain('value="undetermined"');
      expect(html).toContain('name="orderId" value="ord-1"');
      expect(html).toContain('このままでは代表承認できません');
    }
  });

  it('a decided term is folded (not open)', () => {
    const html = render({ role: 'admin', order: { paymentTerms: 'prepaid', paymentTermsUndetermined: false } });
    expect(html).toContain('<details class="p4-terms-change">');
    expect(html).not.toContain('open=""');
  });

  it('no form for viewer / auditor / an unknown role, for a cancelled order, or when the API says it is no longer editable', () => {
    expect(render({ role: 'viewer' })).toBe('');
    expect(render({ role: 'auditor' })).toBe('');
    expect(render({ role: null })).toBe('');
    expect(render({ role: 'admin', cancelled: true })).toBe('');
    expect(render({ role: 'admin', order: { paymentTermsEditable: false } })).toBe('');
  });

  it('OrderTermsSection draws it, and hides it once an approved paper locks the order', () => {
    const facts = { state: 'read', facts: { orderedQuantity: '1000', orderedUnit: 'meters', quantityDisplay: '1,000 メートル', amount: null } };
    const section = (lock: unknown) => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <OrderTermsSection
          order={{ ...baseOrder, requestedDeliveryDate: null, plannedDeliveryDate: null, deliveryDatesRead: true, sevenPurchaseOrderId: 'po-1', lines: [] } as never}
          role="staff" facts={facts as never} lock={lock as never} projectCode="PRJ-1" cancelled={false}
        />
      </RenderedContextProvider>
    );
    expect(section({ state: 'open' })).toContain('p4-terms-change');
    expect(section({ state: 'locked', paper: { displayNumber: 'MPO-2026-0001' } })).not.toContain('p4-terms-change');
  });
});

describe('B1③ / N6 no link into the remembered-project address', () => {
  it('the maker list points the 支払条件 fix at the order screen of THIS project', async () => {
    const { MakerPoApprovalBlock } = await import('../apps/web/src/screens/MakerPoScreen.js');
    const entry = {
      order: { id: 'ord-9', code: 'FSO-9' },
      makerPurchaseOrders: [{ id: 'mpo-1', status: 'DRAFT', displayNumber: null }],
      paymentGate: { paymentTerms: 'undetermined', gate: { satisfied: false, reason: '未定' } }
    };
    const html = renderToStaticMarkup(<MakerPoApprovalBlock entry={entry as never} role="staff" projectCode="PRJ-1" />);
    expect(html).toContain('href="/p/PRJ-1/o/FSO-9"');
    expect(html).not.toContain('/orders#order-');
  });

  it('no screen, component or lib source writes an href to /orders#… /maker-po#… (the cookie-scoped addresses)', () => {
    const offenders = ['screens', 'components', 'lib', 'app']
      .flatMap((dir) => sources(path.join(root, dir)))
      .filter((file) => /href=\{`\/(orders|maker-po|documents|approvals|deliveries)[#?/`]/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('H7① a duplicate says where the registered record is', () => {
  it('duplicateHref: a film order opens its own screen; the others open the project list at the record', async () => {
    const { duplicateHref } = await import('../apps/web/src/lib/duplicate-check.js');
    expect(duplicateHref('film_order', 'id-1', { projectCode: 'PRJ-1', value: 'PRJ-1-FILM-003' })).toBe('/p/PRJ-1/o/PRJ-1-FILM-003');
    expect(duplicateHref('seven_po', 'id-2', { projectCode: 'PRJ-1', value: 'PO-1' })).toBe('/p/PRJ-1/orders#seven-po-id-2');
    expect(duplicateHref('filling_order', 'id-3', { projectCode: 'PRJ-1' })).toBe('/p/PRJ-1/orders#filling-order-id-3');
  });

  it('duplicateFromAnswer: same project → link; another project → no link and its code; no `existing` → no link', async () => {
    const { duplicateFromAnswer } = await import('../apps/web/src/lib/duplicate-check.js');
    const scope = { projectId: 'proj-A', projectCode: 'PRJ-1', value: 'FSO-7' };
    const same = duplicateFromAnswer('film_order', { code: 'DUPLICATE', existing: { id: 'o1', projectId: 'proj-A', projectCode: 'PRJ-1' } }, scope);
    expect(same.link).toEqual({ href: '/p/PRJ-1/o/FSO-7', label: '登録済みのフィルム発注 FSO-7 を開く' });
    expect(same.code).toBe('DUPLICATE');
    const other = duplicateFromAnswer('film_order', { code: 'DUPLICATE', existing: { id: 'o2', projectId: 'proj-B', projectCode: 'PRJ-2' } }, scope);
    expect(other.link ?? null).toBeNull();
    expect(other.message).toContain('PRJ-2');
    expect(duplicateFromAnswer('seven_po', { code: 'DUPLICATE' }, scope).link ?? null).toBeNull();
  });
});

describe('H10① a viewer is told it is a permission, not that the order is missing', () => {
  it('orderLookupFailure: withheld codes + a read-only role → forbidden; otherwise missing', async () => {
    const { orderLookupFailure } = await import('../apps/web/src/lib/order-lookup.js');
    const { HIDDEN_BY_ROLE_LABEL } = await import('../apps/web/src/lib/redaction.js');
    const hidden = [{ code: HIDDEN_BY_ROLE_LABEL }];
    expect(orderLookupFailure(hidden, 'viewer')).toBe('forbidden');
    expect(orderLookupFailure(hidden, 'unknown-role')).toBe('forbidden');
    expect(orderLookupFailure(hidden, 'admin')).toBe('missing');
    expect(orderLookupFailure(hidden, 'staff')).toBe('missing');
    expect(orderLookupFailure(hidden, 'auditor')).toBe('missing');
    expect(orderLookupFailure([{ code: 'FSO-1' }], 'viewer')).toBe('missing');
    expect(orderLookupFailure([], 'viewer')).toBe('missing');
  });

  it('the order screen shows the permission message and the 履歴 link (the wording is the one the audit asked for)', async () => {
    const { ORDER_FORBIDDEN_TITLE, ORDER_FORBIDDEN_BODY } = await import('../apps/web/src/lib/order-lookup.js');
    expect(ORDER_FORBIDDEN_TITLE).toBe('閲覧権限では発注の画面を開けません');
    expect(ORDER_FORBIDDEN_BODY).toContain('履歴は「履歴」画面で見られます');
    const screen = code(readSrc('screens/OrderDetailScreen.tsx'));
    expect(screen).toContain("orderLookupFailure(workspace.filmOrders, user.role) === 'forbidden'");
  });
});

describe('H10② the auditor menu has 承認（閲覧）', () => {
  it('auditor sees /approvals as 承認（閲覧）; operators reach the read-only list from 発注の一覧 (P4 §0: not in their menu); viewer sees neither', async () => {
    const { navGroupsForRole, navHrefsForRole, openableHrefsForRole } = await import('../apps/web/src/lib/navigation.js');
    const items = (role: string) => navGroupsForRole(role).flatMap((group) => group.items);
    expect(items('auditor').find((item) => item.href === '/approvals')?.label).toBe('承認（閲覧）');
    expect(items('admin').find((item) => item.href === '/approvals')).toBeUndefined();
    expect(items('staff').find((item) => item.href === '/approvals')).toBeUndefined();
    expect(openableHrefsForRole('staff')).toContain('/approvals');
    expect(navHrefsForRole('viewer')).not.toContain('/approvals');
    expect(items('auditor').filter((item) => item.href === '/approvals')).toHaveLength(1);
  });
});

describe('H3 the other dashboards read the server queue (manual checks included)', () => {
  it.each(['app/dashboard/page.tsx', 'screens/OrdersScreen.tsx', 'screens/ProjectOverviewScreen.tsx'])('%s asks for { server: true }', (file) => {
    const text = code(readSrc(file));
    expect(text).toMatch(/loadRepresentativeQueue\([\s\S]*?\{ server: true \}\)/);
  });
});

describe('H11 Korean beside the representative\'s words', () => {
  it('every kind of the server queue has a Korean line; the fallback statuses too', async () => {
    const { QUEUE_KIND_STEP, QUEUE_KIND_KO, REPRESENTATIVE_WORK, REPRESENTATIVE_WORK_KO, taskWorkKo } = await import('../apps/web/src/lib/representative-queue.js');
    for (const kind of Object.keys(QUEUE_KIND_STEP)) expect(QUEUE_KIND_KO[kind], kind).toMatch(/[가-힣]/);
    for (const status of Object.keys(REPRESENTATIVE_WORK)) expect(REPRESENTATIVE_WORK_KO[status], status).toMatch(/[가-힣]/);
    expect(taskWorkKo({ kind: 'send_verification', status: '' })).toBe('송신 확인');
    expect(taskWorkKo({ kind: undefined, status: 'ON_HOLD' })).toBe('보류 해제(사유 확인)');
    expect(taskWorkKo({ kind: 'unknown', status: 'DRAFT' })).toBeNull();
  });

  it('ActionForm: a Korean hint and button line appear only when the display shows Korean', async () => {
    const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
    const draw = (showKorean: boolean) => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean }}>
        <ActionForm action={async () => ({ ok: true, message: '' })} submitLabel="送信の確認を記録する" submitLabelKo="송신 확인을 기록" hint="確認者と日時は自動で記録されます。" hintKo="확인자와 일시는 자동으로 기록됩니다." />
      </RenderedContextProvider>
    );
    expect(draw(true)).toContain('<span class="p1-ko" lang="ko">송신 확인을 기록</span>');
    expect(draw(true)).toContain('<span class="p1-ko" lang="ko">확인자와 일시는 자동으로 기록됩니다.</span>');
    expect(draw(false)).not.toMatch(/[가-힣]/);
  });
});

describe('H13 the step buttons are classes, so the 44px target and the hover apply', () => {
  it('a real ActionForm submit button has no inline style (T-2); danger is a class too', async () => {
    const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
    const draw = (tone?: 'danger') => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <ActionForm action={async () => ({ ok: true, message: '' })} submitLabel="記録する" {...(tone ? { tone } : {})} />
      </RenderedContextProvider>
    );
    const button = (html: string) => /<button type="submit"[^>]*>/.exec(html)![0];
    expect(button(draw())).not.toContain('style=');
    expect(button(draw())).toContain('class="ui-button"');
    expect(button(draw('danger'))).not.toContain('style=');
    expect(button(draw('danger'))).toContain('class="ui-button--danger"');
  });

  it('DeliveryRecordForm submit button: no inline min-height / background', async () => {
    const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <DeliveryRecordForm action={async () => ({ ok: true, message: '' })} kind="film" orders={[{ id: 'o1', code: 'FSO-1', lines: [{ value: 'l1', label: '明細1', unit: 'rolls' }] }]} unitChoices={[{ value: 'rolls', label: 'ロール' }]} />
      </RenderedContextProvider>
    );
    const button = /<button type="submit"[^>]*>/.exec(html)![0];
    expect(button).not.toMatch(/min-height|background|style=/);
    expect(button).toContain('class="ui-button"');
  });

  it('no component styles a button with buttonStyle / dangerButtonStyle / subtleButtonStyle (except the logout button)', () => {
    const offenders = sources(path.join(root, 'components'))
      .filter((file) => !file.endsWith('LogoutButton.tsx'))
      .filter((file) => /style=\{[^}]*(buttonStyle|dangerButtonStyle|subtleButtonStyle)/i.test(code(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('L2 the login note lists what only the representative does', () => {
  it('names all six operations (the old text promised 納品確認・手数料準備)', async () => {
    const { LOGIN_ADMIN_ONLY_NOTE } = await import('../apps/web/src/lib/login-messages.js');
    for (const operation of ['代表承認', '保留の解除', '取消確認', '送信の確認', '最終受入', '証跡の確認']) expect(LOGIN_ADMIN_ONLY_NOTE).toContain(operation);
    expect(LOGIN_ADMIN_ONLY_NOTE).not.toContain('納品確認');
    expect(LOGIN_ADMIN_ONLY_NOTE).not.toContain('手数料準備');
    expect(code(readSrc('app/page.tsx'))).toContain('LOGIN_ADMIN_ONLY_NOTE');
  });
});

describe('L4 the blocked-revision notice names the paper by its stored number', () => {
  it('loadRevisionTargets merges displayNumbers: 「MPO-…」 when known, 「{発注コード} のメーカー発注書」 when not (never a short id)', async () => {
    const { loadRevisionTargets } = await import('../apps/web/src/screens/ApprovalsScreen.js');
    callApi.mockResolvedValueOnce({
      ok: true, status: 200, error: null, code: null,
      data: { makerPurchaseOrders: [{ id: 'aaaaaaaa-1111', status: 'DRAFT' }, { id: 'bbbbbbbb-2222', status: 'DRAFT' }], displayNumbers: { 'aaaaaaaa-1111': 'MPO-2026-0002' } }
    });
    const result = await loadRevisionTargets([order('x', 'ARTWORK_RECEIVED')] as never);
    const papers = result.blocked[0]!.papers;
    const { makerPoName } = await import('../apps/web/src/lib/maker-po-data.js');
    expect(papers.map((paper) => makerPoName(paper, 'FSO-x'))).toEqual(['メーカー発注書 MPO-2026-0002', 'FSO-x のメーカー発注書']);
    expect(code(readSrc('screens/ApprovalsScreen.tsx'))).not.toContain('${shortId(paper.id)}');
  });
});

describe('L5 an order code never wraps and is not translated', () => {
  it('p4-web1.css gives .p4-nowrap white-space: nowrap, and the maker list cell uses it with translate="no"', () => {
    const css = readSrc('app/p4-web1.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.p4-nowrap\s*\{[^}]*white-space:\s*nowrap/.test(css)).toBe(true);
    expect(readSrc('screens/MakerPoScreen.tsx')).toContain('className="ui-td p4-nowrap" translate="no"');
    expect(readSrc('app/layout.tsx')).toContain("import './p4-web1.css'");
  });
});

describe('L6 no circled glyph names a step', () => {
  it('stage labels say 「手順N: …」', async () => {
    const { stageLabel, makerPoStages, stageHeadline, upcomingStagesLine } = await import('../apps/web/src/lib/maker-po-stage.js');
    expect(stageLabel({ number: '手順2', name: '代表承認' })).toBe('手順2: 代表承認');
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [] });
    expect(stageHeadline(view)).toBe('手順1: 発注書の作成');
    expect(upcomingStagesLine(view)).toBe('このあと: 手順2: 代表承認 → 手順3: 送信の記録 → 手順4: 受入 → 完了');
  });

  it('no source line of a screen, component, lib or action carries ①②③④⑤ outside a comment', () => {
    const offenders = sources(root)
      .filter((file) => /[①②③④⑤]/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('M5 the system\'s own steps are never offered by hand', () => {
  it('transitionChoicesFor leaves out PROOF_READY / APPROVAL_PENDING / MAKER_PO_READY from a normal state, but keeps the change-review exits', async () => {
    const { transitionChoicesFor } = await import('../apps/web/src/lib/transitions.js');
    const label = (key: string) => key;
    const values = (status: string, left: string | null = null) => transitionChoicesFor(status, label, left).choices.map((choice) => choice.value);
    expect(values('ARTWORK_RECEIVED')).not.toContain('PROOF_READY');
    expect(values('PROOF_READY')).not.toContain('APPROVAL_PENDING');
    expect(values('DUAL_APPROVED')).not.toContain('MAKER_PO_READY');
    // The exit of a 変更確認 into 校正準備完了 is an exception exit and stays manual (core isAutoOnlyManualTarget).
    expect(values('CHANGE_REVIEW', 'PROOF_READY')).toContain('PROOF_READY');
    expect(values('MAKER_PO_ACCEPTED')).toContain('FILM_IN_PRODUCTION');
  });

  it('「次にやること」 and the guide say it moves on by itself', async () => {
    const workspace = { labels: LABELS, revisions: [{ filmSupplyOrderId: 'x' }], revisionsWithheld: 0, sevenPurchaseOrders: [], documents: [] };
    for (const status of ['ARTWORK_RECEIVED', 'PROOF_READY', 'DUAL_APPROVED']) {
      const text = nextActionForOrder(order('x', status), workspace as never, 'staff').text;
      expect(text, status).not.toMatch(/状態を「[^」]+」へ進める/);
      expect(text, status).toContain('自動で進みます');
    }
    const { GUIDE_STEPS } = await import('../apps/web/src/lib/guide.js');
    const proofStep = GUIDE_STEPS.find((step) => step.what.includes('校正ゲラ'))!;
    expect(proofStep.what).toContain('自動で');
    expect(proofStep.ko).toContain('자동으로');
  });
});

describe('M9 the browser\'s 「戻る」/「進む」 asks first — without ever writing to the history (review H-1)', () => {
  const deps = (unsaved: boolean, answer: boolean, log: { asked: string[]; forgotten: number }) => ({
    hasUnsaved: () => unsaved,
    confirm: (message: string) => { log.asked.push(message); return answer; },
    forget: () => { log.forgotten += 1; }
  });

  it('decideTraverse: a typed form + 「いいえ」 cancels the traversal; 「はい」 allows and forgets; nothing typed never asks', async () => {
    const { decideTraverse } = await import('../apps/web/src/lib/unsaved-guard.js');
    const log = { asked: [] as string[], forgotten: 0 };
    expect(decideTraverse({ navigationType: 'traverse', cancelable: true }, deps(false, false, log))).toBe('allow');
    expect(log.asked).toEqual([]);
    expect(decideTraverse({ navigationType: 'traverse', cancelable: true }, deps(true, false, log))).toBe('cancel');
    expect(log.asked).toHaveLength(1);
    expect(log.asked[0]).toContain('入力中の内容があります');
    expect(log.forgotten).toBe(0);
    expect(decideTraverse({ navigationType: 'traverse', cancelable: true }, deps(true, true, log))).toBe('allow');
    expect(log.forgotten).toBe(1);
  });

  it('decideTraverse: only a traversal is asked about, and only when the browser lets the page cancel it', async () => {
    const { decideTraverse } = await import('../apps/web/src/lib/unsaved-guard.js');
    for (const navigationType of ['push', 'replace', 'reload']) {
      const log = { asked: [] as string[], forgotten: 0 };
      expect(decideTraverse({ navigationType, cancelable: true }, deps(true, false, log)), navigationType).toBe('allow');
      expect(log.asked, navigationType).toEqual([]);
    }
    // A traversal that cannot be cancelled is not asked about (the question could not be acted on).
    const log = { asked: [] as string[], forgotten: 0 };
    expect(decideTraverse({ navigationType: 'traverse', cancelable: false }, deps(true, false, log))).toBe('allow');
    expect(log.asked).toEqual([]);
  });

  it('there is no popstate handling and no history write anywhere in the guard (the cause of H-1)', () => {
    for (const file of ['components/unsaved-guard-dom.tsx', 'components/UnsavedGuardBoot.tsx', 'lib/unsaved-guard.ts']) {
      const text = code(readSrc(file));
      expect(text, file).not.toMatch(/popstate/i);
      expect(text, file).not.toMatch(/pushState|replaceState|history\.go|history\.back|history\.forward/);
    }
    expect(readSrc('components/unsaved-guard-dom.tsx')).toContain("navigation.addEventListener('navigate'");
  });

  it('the long old forms keep a draft (the substitute where the browser cannot be asked)', () => {
    // P4 web2a §0: the 照合 checklist moved to the order screen (steps 1–2) with its draft.
    expect(readSrc('components/SevenPoForms.tsx')).toContain('<DraftAutosave name={`po-check-${poId}`} />');
    expect(readSrc('components/ApprovalDecisionForm.tsx')).toContain('<DraftAutosave name={`approval-${designKey}-${revisionId}`} />');
  });
});

describe('M11 the delivery form does not start on an unshipped order or on 「ロール」', () => {
  it('only shipped / delivered film orders (and a withheld status) are candidates', async () => {
    const { isFilmDeliveryCandidate } = await import('../apps/web/src/lib/delivery-candidates.js');
    expect(isFilmDeliveryCandidate('FILM_SHIPPED')).toBe(true);
    expect(isFilmDeliveryCandidate('FILM_DELIVERED')).toBe(true);
    expect(isFilmDeliveryCandidate(null)).toBe(true);
    for (const status of ['DRAFT', 'MAKER_PO_ACCEPTED', 'FILM_IN_PRODUCTION', 'CANCELLED']) expect(isFilmDeliveryCandidate(status), status).toBe(false);
  });

  it('the unit select starts blank (required) and the empty text can be the screen\'s own', async () => {
    const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');
    const props = { action: async () => ({ ok: true, message: '' }), kind: 'film' as const, unitChoices: [{ value: 'rolls', label: 'ロール' }, { value: 'meters', label: 'メートル' }] };
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <DeliveryRecordForm {...props} orders={[{ id: 'o1', code: 'FSO-1', lines: [{ value: 'l1', label: '明細1', unit: 'meters' }] }]} />
      </RenderedContextProvider>
    );
    const select = /<select name="unit"[\s\S]*?<\/select>/.exec(html)![0];
    expect(select).toContain('required');
    expect(select).toContain('<option value="" selected="">明細を選ぶと入ります</option>');
    expect(select).not.toMatch(/<option value="rolls"[^>]*selected/);
    const empty = renderToStaticMarkup(<DeliveryRecordForm {...props} orders={[]} emptyText="出荷済みのフィルム発注がまだありません。" />);
    expect(empty).toContain('出荷済みのフィルム発注がまだありません。');
  });
});

describe('M14 the heading takes the focus after login, only when nothing else holds it', () => {
  const doc = (active: unknown) => {
    const focused: Array<{ preventScroll?: boolean } | undefined> = [];
    const body = { tag: 'body' };
    const document = {
      body, activeElement: active === 'body' ? body : active,
      getElementById: (id: string) => (id === 'home-title' ? { focus: (options?: { preventScroll?: boolean }) => focused.push(options) } : null)
    };
    return { document, focused };
  };

  it('on <body> → focus the heading without scrolling; in a field or on a button → leave it; no heading → nothing', async () => {
    const { focusHeadingIfIdle } = await import('../apps/web/src/components/FocusOnMount.js');
    const idle = doc('body');
    expect(focusHeadingIfIdle(idle.document as never, 'home-title')).toBe(true);
    expect(idle.focused).toEqual([{ preventScroll: true }]);
    const busy = doc({ tag: 'input' });
    expect(focusHeadingIfIdle(busy.document as never, 'home-title')).toBe(false);
    expect(busy.focused).toEqual([]);
    expect(focusHeadingIfIdle(idle.document as never, 'missing')).toBe(false);
    expect(focusHeadingIfIdle({ ...doc(null).document } as never, 'home-title')).toBe(true);
  });

  it('the home screen mounts it on its heading (tabIndex -1)', () => {
    const home = readSrc('screens/HomeScreen.tsx');
    expect(home).toContain('<FocusOnMount targetId="home-title" />');
    expect(home).toMatch(/id="home-title"[^>]*tabIndex=\{-1\}/);
  });
});

describe('N3 the wizard stops without leaving a PO behind', () => {
  it('the 照合 checks are required in the browser (all six boxes) and say so', async () => {
    const { NewOrderForm } = await import('../apps/web/src/components/NewOrderForm.js');
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <NewOrderForm action={async () => ({ ok: true, message: '' })} projectCode="PRJ-1" unitChoices={[{ value: 'rolls', label: 'ロール' }]} paymentTermsChoices={[{ value: 'prepaid', label: '前払い' }]} existingPoChoices={[]} unverifiedPoIds={[]} />
      </RenderedContextProvider>
    );
    const inputTag = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)![0];
    for (const name of ['issuerNameRecorded', 'documentNumberRecorded', 'issueDateRecorded', 'sendingChannelRecorded', 'pastTransactionCompared', 'quoteCompared']) {
      expect(inputTag(name), name).toContain('required=""');
    }
    expect(inputTag('uncertain')).not.toContain('required');
    expect(html).toContain('すべての項目を確かめてチェックします（必須');
  });

  it('runChain hands back the id of the record it wrote before it stopped (and nothing when it wrote none)', async () => {
    const { runChain, answerId } = await import('../apps/web/src/lib/step-chain.js');
    const form = new FormData();
    form.set('_kanei_idempotency_key', 'k1');
    const ok = { ok: true, status: 201, error: null, code: null, data: { purchaseOrder: { id: 'po-77' } } };
    const refused = { ok: false, status: 422, error: 'x', code: 'CHECKLIST_INCOMPLETE', data: { code: 'CHECKLIST_INCOMPLETE', error: 'x' } };
    const steps = [{ label: '受付', request: () => ({ path: '/a' }) }, { label: '照合', request: () => ({ path: '/b' }) }];
    callApi.mockResolvedValueOnce(ok).mockResolvedValueOnce(refused);
    const stopped = await runChain(form, steps as never, { success: 's', partialId: (answers) => answerId(answers[0]) });
    expect(stopped.ok).toBe(false);
    expect(stopped.settled).toBe(false);
    expect(stopped.partialPoId).toBe('po-77');
    callApi.mockResolvedValueOnce(refused);
    const first = await runChain(form, steps as never, { success: 's', partialId: (answers) => answerId(answers[0]) });
    expect(first.partialPoId).toBeUndefined();
  });

  it('the overview lists a セブン化学発注書 that has no order (claimed only when every link was read)', () => {
    const orphan = { ...PO, id: 'po-orphan', poNumber: 'SEVEN-ORPHAN' };
    const view = buildDashboard(input('admin', [order('a', 'DRAFT')], { projectCode: 'PRJ-1' }, [PO, orphan]));
    const item = view.blocked.find((entry) => entry.key === 'po-orphan-po-orphan');
    expect(item?.title).toContain('SEVEN-ORPHAN');
    expect(item?.href).toBe('/p/PRJ-1/new');
    expect(view.blocked.some((entry) => entry.key === 'po-orphan-po-1')).toBe(false);
    // A viewer, a hidden order or a failed read never claims it.
    expect(buildDashboard(input('viewer', [order('a', 'DRAFT')], {}, [PO, orphan])).blocked.some((entry) => entry.key.startsWith('po-orphan'))).toBe(false);
    expect(buildDashboard(input('admin', [order('a', 'DRAFT', { detailsHidden: true })], {}, [PO, orphan])).blocked.some((entry) => entry.key.startsWith('po-orphan'))).toBe(false);
  });
});

describe('N5 / H4② the old 代表承認 form is gone from the maker list', () => {
  const entry = {
    order: { id: 'ord-9', code: 'FSO-9' },
    makerPurchaseOrders: [{ id: 'mpo-1', status: 'DRAFT', displayNumber: 'MPO-2026-0001' }],
    paymentGate: { paymentTerms: 'prepaid', gate: { satisfied: true, reason: null } }
  };

  it('the representative gets a link to step 8 of the order screen — no approve form, no terms fields', async () => {
    const { MakerPoApprovalBlock } = await import('../apps/web/src/screens/MakerPoScreen.js');
    const html = renderToStaticMarkup(<MakerPoApprovalBlock entry={entry as never} role="admin" projectCode="PRJ-1" />);
    expect(html).toContain('href="/p/PRJ-1/o/FSO-9?step=8"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="expectedPaymentTerms"');
    expect(html).not.toContain('代表承認を記録する');
  });

  it('staff see that the representative approves; no link, no form', async () => {
    const { MakerPoApprovalBlock } = await import('../apps/web/src/screens/MakerPoScreen.js');
    const html = renderToStaticMarkup(<MakerPoApprovalBlock entry={entry as never} role="staff" projectCode="PRJ-1" />);
    expect(html).not.toContain('step=8');
    expect(html).not.toContain('<form');
  });
});

describe('N7 the 404 is in Japanese with a way out', () => {
  it('NotFoundNotice: title, the lead, 「ホームへ」 and 「案件を選ぶ」; Korean only in the bilingual mode', async () => {
    const { NotFoundNotice } = await import('../apps/web/src/components/NotFoundNotice.js');
    const draw = (showKorean: boolean, scope: 'site' | 'project') => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: '', showKorean }}><NotFoundNotice scope={scope} /></RenderedContextProvider>
    );
    const ja = draw(false, 'site');
    expect(ja).toContain('ページが見つかりません');
    expect(ja).toContain('href="/home"');
    expect(ja).toContain('ホームへ');
    expect(ja).toContain('href="/dashboard"');
    expect(ja).toContain('案件を選ぶ');
    expect(ja).not.toMatch(/[가-힣]/);
    expect(ja).not.toContain('This page could not be found');
    expect(draw(true, 'site')).toContain('lang="ko"');
    expect(draw(false, 'project')).toContain('この案件のページが見つかりません');
  });

  it('app/not-found.tsx and app/p/[project]/not-found.tsx exist and render the notice', async () => {
    const site = await import('../apps/web/src/app/not-found.js');
    const project = await import('../apps/web/src/app/p/[project]/not-found.js');
    expect(renderToStaticMarkup(site.default())).toContain('ページが見つかりません');
    expect(renderToStaticMarkup(project.default())).toContain('この案件のページが見つかりません');
  });
});

describe('N12 the stale-basis line is true after R30: a recorded 希望納期 is judged', () => {
  it('daysPastDate counts Japan calendar days', () => {
    expect(daysPastDate('2026-11-20', NOW)).toBe(0);
    expect(daysPastDate('2026-11-10', NOW)).toBe(10);
    expect(daysPastDate('2026-11-25', NOW)).toBe(-5);
    expect(daysPastDate(null, NOW)).toBeNull();
    expect(daysPastDate('2026/11/10', NOW)).toBeNull();
    // 2026-11-20T15:30Z is already 11-21 in Japan.
    expect(daysPastDate('2026-11-20', new Date('2026-11-20T15:30:00.000Z'))).toBe(1);
  });

  it('an open order past its 希望納期 is listed (even in production); a future date, no date and an unread date are not', () => {
    const view = buildDashboard(input('admin', [
      order('late', 'MAKER_PO_ACCEPTED', { requestedDeliveryDate: '2026-11-10', deliveryDatesRead: true }),
      order('future', 'MAKER_PO_ACCEPTED', { requestedDeliveryDate: '2026-12-10', deliveryDatesRead: true }),
      order('none', 'MAKER_PO_ACCEPTED', { requestedDeliveryDate: null, deliveryDatesRead: true }),
      order('unread', 'MAKER_PO_ACCEPTED', { requestedDeliveryDate: '2026-11-10', deliveryDatesRead: false })
    ], { projectCode: 'PRJ-1' }));
    const late = view.stalled.filter((entry) => entry.key.startsWith('late-'));
    expect(late.map((entry) => entry.orderCode)).toEqual(['FSO-late']);
    expect(late[0]!.title).toContain('希望納期（11/10）を過ぎています（10日）');
    expect(late[0]!.href).toBe('/p/PRJ-1/o/FSO-late');
  });

  it('the basis line no longer claims delivery dates are unrecorded', () => {
    expect(STALE_BASIS).not.toContain('納期は記録されていないため');
    expect(STALE_BASIS).toContain('希望納期が記録された発注は、その日を過ぎると');
  });
});

describe('N14 wording after P-6 (staff draw up the paper; the representative approves)', () => {
  it('the representative\'s work by status and the dashboard scope no longer say the representative creates the paper', async () => {
    const { REPRESENTATIVE_WORK } = await import('../apps/web/src/lib/representative-queue.js');
    for (const status of ['DUAL_APPROVED', 'MAKER_PO_READY']) {
      expect(REPRESENTATIVE_WORK[status], status).not.toContain('作成と代表承認');
      expect(REPRESENTATIVE_WORK[status], status).toContain('作成は担当者');
    }
    expect(TODO_SCOPE.admin).not.toContain('メーカー発注書の作成・代表承認');
    expect(TODO_SCOPE.admin).toContain('代表承認');
    expect(readSrc('components/StepPanel.tsx')).not.toContain('（代表がメーカー発注書を作ります）');
  });
});

describe('N15 the WIG leftovers', () => {
  it('one money formatter: formatMoney and formatAmount agree, and a JPY amount keeps its decimals', async () => {
    const { formatAmount } = await import('../apps/web/src/lib/number-format.js');
    const { formatMoney } = await import('../apps/web/src/lib/vocabulary.js');
    for (const [currency, amount] of [['JPY', '312000'], ['JPY', '312000.50'], ['USD', '1200.5'], ['', '999'], [null, '480000']] as Array<[string | null, string]>) {
      expect(formatMoney(currency, amount), `${currency} ${amount}`).toBe(formatAmount(currency, amount));
    }
    expect(formatAmount('JPY', '312000.50')).toBe('¥312,000.5');
    expect(formatAmount('USD', '1200.5')).toBe('1,200.5 USD');
  });

  it('the menu\'s Korean gloss comes from the menu item itself (one source), including the auditor entry', async () => {
    const { NAV_GROUPS } = await import('../apps/web/src/lib/navigation.js');
    const { MENU_TERMS } = await import('../apps/web/src/lib/terms.js');
    const { SideNav } = await import('../apps/web/src/components/NavLinks.js');
    for (const group of NAV_GROUPS) for (const item of group.items) expect(item.ko, item.href).toMatch(/[가-힣]/);
    expect(MENU_TERMS['/approvals:auditor']).toEqual({ ja: '承認（閲覧）', ko: '승인(열람)' });
    // P4 §0: the operators' 承認（校了） left the menu (the list is read-only now).
    expect(MENU_TERMS['/approvals']).toBeUndefined();
    const auditor = NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => item.roles.includes('auditor')) })).filter((group) => group.items.length > 0);
    const html = renderToStaticMarkup(<SideNav groups={auditor as never} roleNote={null} korean role="auditor" />);
    expect(html).toContain('承認（閲覧）<span class="p1-ko" lang="ko">승인(열람)</span>');
  });

  it('StepAnnouncer: the focus announces, so the region is not also a live status', async () => {
    const { StepAnnouncer } = await import('../apps/web/src/components/StepAnnouncer.js');
    const html = renderToStaticMarkup(<StepAnnouncer progressKey="a" latest={null} now={null}>x</StepAnnouncer>);
    expect(html).not.toContain('role="status"');
    expect(html).toContain('tabindex="-1"');
    // Review L-1: no aria-label (it would replace the message as the element's name).
    expect(html).not.toContain('aria-label');
  });

  it('no <p aria-label> (it is ignored on a paragraph): the 承認済み seal says it in visually-hidden text', () => {
    expect(readSrc('components/StepPanel.tsx')).not.toMatch(/<p[^>]*aria-label/);
    expect(readSrc('components/StepPanel.tsx')).toContain('<span className="visually-hidden">{name}の承認済み</span>');
  });

  it('an amount input has an on-screen decimal keypad (inputMode) — the field accepts sen', async () => {
    const { TextField } = await import('../apps/web/src/components/fields.js');
    const html = renderToStaticMarkup(<RenderedContextProvider value={{ projectId: 'p', showKorean: false }}><TextField name="totalAmount" label="金額" inputMode="decimal" /></RenderedContextProvider>);
    expect(html).toContain('inputMode="decimal"');
    for (const file of ['components/StepPanel.tsx', 'components/ApprovalCard.tsx', 'components/OrderTermsSection.tsx']) {
      expect(readSrc(file), file).toMatch(/name="totalAmount"[\s\S]{0,260}inputMode="decimal"/);
    }
  });

  it('「破棄」 asks before it deletes the restored draft, and is a 44px target', async () => {
    const { DISCARD_CONFIRM_MESSAGE } = await import('../apps/web/src/components/DraftAutosave.js');
    expect(DISCARD_CONFIRM_MESSAGE).toContain('破棄しますか？');
    expect(readSrc('components/DraftAutosave.tsx')).toContain('window.confirm(DISCARD_CONFIRM_MESSAGE)');
    const css = readSrc('app/p4-web1.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.p1-draft \.p1-link-button\s*\{[^}]*min-height:\s*44px/.test(css)).toBe(true);
  });

  it('the remedy button / link sits OUTSIDE the role=alert region (P3 M-4①)', async () => {
    const { FormFeedbackContext, FormResult } = await import('../apps/web/src/components/form-feedback.js');
    const draw = (state: Record<string, unknown>, flags: Record<string, unknown>) => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: true }}>
        <FormFeedbackContext.Provider value={{ errors: {}, summaryCount: 0, startNewIntent: () => undefined, ...flags } as never}>
          <FormResult state={{ ok: false, message: 'x', messageKo: '엑스', ...state } as never} />
        </FormFeedbackContext.Provider>
      </RenderedContextProvider>
    );
    const alertOf = (html: string) => /<span role="alert" class="form-result form-result--error">[\s\S]*?<\/span><\/span>/.exec(html)![0];
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ code: 'IDEMPOTENCY_KEY_REUSED' }, { keyReuseLocked: true }],
      [{ code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' }, { outcomeCheckPending: true }],
      [{ code: 'DUPLICATE', link: { href: '/p/PRJ-1/o/FSO-1', label: '登録済みを開く' } }, {}]
    ];
    for (const [state, flags] of cases) {
      const html = draw(state, flags);
      expect(html, String(state.code)).toMatch(/<button type="button" class="form-result-action">|<a class="form-result-action"/);
      expect(alertOf(html), String(state.code)).not.toMatch(/<button|<a /);
    }
    // The sentence of the unknown outcome stays inside the alert (it is what is announced).
    expect(alertOf(draw({ code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' }, { outcomeCheckPending: true }))).toContain('form-result-line');
  });

  it('the download relay gives up on an API that never answers (the wait has an end)', () => {
    const route = code(readSrc('app/api/document-versions/[versionId]/download/route.ts'));
    expect(route).toContain('apiTimeoutMs()');
    expect(route).toContain('signal: controller.signal');
  });
});

describe('H8 a page that cannot open says why (a soft navigation never draws the root layout again)', () => {
  it('noticeForSession: expired → expired, anonymous → login, unavailable → outage with its code', async () => {
    const { noticeForSession } = await import('../apps/web/src/lib/route-gate.js');
    expect(noticeForSession({ kind: 'expired' })).toEqual({ kind: 'expired', code: null });
    expect(noticeForSession({ kind: 'anonymous' })).toEqual({ kind: 'login', code: null });
    expect(noticeForSession({ kind: 'unavailable', code: 'DB_UNAVAILABLE' })).toEqual({ kind: 'outage', code: 'DB_UNAVAILABLE' });
  });

  it('RouteGate on an expired session draws the login link back to this screen, and asks the server to redraw the header', async () => {
    const { RouteGate } = await import('../apps/web/src/components/RouteGate.js');
    cookieJar.headers = { 'x-kanei-request-path': '/p/PRJ-1/maker-po' };
    const element = await RouteGate({ route: { kind: 'no-session', session: { kind: 'expired' } } as never });
    const html = renderToStaticMarkup(element!);
    expect(html).toContain('ログインの有効期限が切れました');
    expect(html).toContain(`href="/?next=${encodeURIComponent('/p/PRJ-1/maker-po')}"`);
    expect(await RouteGate({ route: { kind: 'not-found', code: 'X', projects: [] } as never })).toBeNull();
  });

  it('every page of /p/{案件} draws RouteGate for a closed route (no more return null), and so does the project layout', () => {
    const pages = sources(path.join(root, 'app/p')).filter((file) => file.endsWith('page.tsx'));
    expect(pages.length).toBeGreaterThanOrEqual(9);
    for (const file of pages) {
      const text = code(readFileSync(file, 'utf8'));
      expect(text, path.relative(root, file)).toContain("if (route.kind !== 'open') return <RouteGate route={route} />;");
    }
    expect(code(readSrc('app/p/[project]/layout.tsx'))).toContain("if (route.kind === 'no-session') return <RouteGate route={route} />;");
  });

});

// ---------------------------------------------------------------------------------------------
describe('review round (REVIEW.md of 32f528a): M-1, L-1…L-5', () => {
  it('M-1: the 「登録済みの発注書」 select is controlled, never re-keyed (a re-key drops the keyboard focus to <body>)', async () => {
    const wizard = code(readSrc('components/NewOrderForm.tsx'));
    expect(wizard).not.toMatch(/key=\{`existing-/);
    expect(wizard).toMatch(/name="existingPoId"[\s\S]{0,400}value=\{existingPoId\}/);
    const { SelectField } = await import('../apps/web/src/components/fields.js');
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <SelectField name="existingPoId" label="登録済み" choices={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="b" onChange={() => undefined} />
      </RenderedContextProvider>
    );
    expect(html).toContain('<option value="b" selected="">B</option>');
    expect(html).not.toContain('<option value="a" selected');
  });

  it('L-1: the announcer has no aria-label (covered in the N15 test above); L-5: the session notice takes the focus', async () => {
    const { SessionNotice } = await import('../apps/web/src/components/SessionNotice.js');
    for (const kind of ['expired', 'login', 'outage'] as const) {
      const html = renderToStaticMarkup(<SessionNotice kind={kind} path="/p/PRJ-1/orders" />);
      expect(html, kind).toMatch(/<h1 id="session-notice-title"[^>]*tabindex="-1"/);
    }
    expect(readSrc('components/SessionNotice.tsx')).toContain('<FocusOnMount targetId="session-notice-title" />');
  });

  it('L-2: a pending danger / subtle button dims like the primary one (aria-disabled is styled for all three)', () => {
    const css = readSrc('app/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const selector of ['.ui-button[aria-disabled=\'true\']', '.ui-button--danger[aria-disabled=\'true\']', '.ui-button--subtle[aria-disabled=\'true\']']) {
      expect(css, selector).toContain(selector);
    }
  });

  it('L-3: approveMakerPoAction is deleted — not exported, not referenced by any source', async () => {
    const actions = await import('../apps/web/src/app/maker-po/actions.js');
    expect(Object.keys(actions)).not.toContain('approveMakerPoAction');
    const offenders = ['screens', 'components', 'lib', 'app'].flatMap((dir) => sources(path.join(root, dir)))
      .filter((file) => readFileSync(file, 'utf8').includes('approveMakerPoAction')).map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
    // The approval itself is still recorded by the card's action (the API judges it).
    const card = await import('../apps/web/src/app/approval-actions.js');
    expect(Object.keys(card).some((name) => /approv/i.test(name))).toBe(true);
  });

  it('L-4: the 支払条件 change does not repeat the server\'s success sentence in a hint', () => {
    const section = readSrc('components/OrderTermsSection.tsx');
    const change = section.slice(section.indexOf('export function PaymentTermsChange'), section.indexOf('/** 1 行の要約'));
    expect(change).not.toContain('successHint');
  });
});
