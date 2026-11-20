import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * UI nav-dashboard (demo-eml/ui-nav-dashboard/REPORT.md): the left sidebar by
 * role, the screen guide lines, the dashboard calculation and its redaction
 * (amounts only for the representative; 決済条件 for every role). Pure helpers
 * and server markup on fixtures; the real-API checks for all three roles are
 * in web-nav-dashboard-parity.test.tsx.
 */

const nav = vi.hoisted(() => ({ pathname: '/orders' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
  usePathname: () => nav.pathname,
  redirect: () => undefined
}));

const { navGroupsForRole, navHrefsForRole, navRoleNote, screenGuideFor, SCREEN_GUIDES, NAV_GROUPS } = await import('../apps/web/src/lib/navigation.js');
const { SideNav, isCurrentNavItem } = await import('../apps/web/src/components/NavLinks.js');
const { DRAWER_TITLE_ID, drawerDialogAttributes, NavDrawerToggle, SIDEBAR_ID } = await import('../apps/web/src/components/NavDrawer.js');
const { ScreenGuideLine } = await import('../apps/web/src/components/ScreenGuide.js');
const { buildDashboard, CHANGE_REVIEW_NOTE, dashboardAmount, itemHref, STALE_AFTER_DAYS, STALE_BASIS, TODO_SCOPE, ACTIVITY_LIMIT, ACTIVITY_READ_LIMIT } = await import('../apps/web/src/lib/dashboard.js');
const { DashboardFlow, DashboardItemList, DashboardActivity } = await import('../apps/web/src/components/DashboardParts.js');
const { GUIDE_STEPS, GUIDE_DAYS } = await import('../apps/web/src/lib/guide.js');
const { PROGRESS_STEPS } = await import('../apps/web/src/lib/project-data.js');
const { HIDDEN_BY_ROLE_LABEL } = await import('../apps/web/src/lib/redaction.js');

type Order = Parameters<typeof buildDashboard>[0]['workspace']['filmOrders'][number];
type Input = Parameters<typeof buildDashboard>[0];

const markup = (node: Parameters<typeof renderToString>[0]) => renderToString(node).replaceAll('<!-- -->', '');
const NOW = new Date('2026-11-20T03:00:00.000Z');
const RECENT = '2026-11-19T01:00:00.000Z';

function order(id: string, status: string, extra: Partial<Order> = {}): Order {
  return {
    id,
    code: `FSO-${id}`,
    status,
    sevenPurchaseOrderId: 'po-1',
    lineCount: 1,
    lines: [{ id: `${id}-l1`, lineNumber: 1, description: '合成フィルム', orderedQuantity: '1000', unit: 'sheets' }],
    detailsHidden: false,
    statusHidden: false,
    lastNormalStatus: status,
    hold: null,
    paymentTerms: 'prepaid',
    paymentTermsHidden: false,
    createdAt: RECENT,
    updatedAt: RECENT,
    ...extra
  };
}

const LABELS = {
  filmSupplyOrderStates: [
    { key: 'ON_HOLD', label: '保留中' },
    { key: 'APPROVAL_PENDING', label: '校了確認待ち' },
    { key: 'ARTWORK_RECEIVED', label: 'デザインデータ受領' },
    { key: 'MAKER_PO_READY', label: '製造先発注準備完了' }
  ],
  makerPurchaseOrderStatuses: [],
  commissionReadinessStates: [],
  fillingDeliveryConfirmationStates: [],
  approvalOrganizations: []
};

/** A maker PO row as the API answers admin — and a staff row that wrongly carries the same amounts. */
const DRAFT_PAPER = {
  id: 'mpo-1',
  status: 'DRAFT',
  snapshot: { order: { code: 'FSO-ready' }, amounts: { currency: 'JPY', totalAmount: '480000' } }
};

function input(role: string | null, orders: Order[], extra: Partial<Input> = {}): Input {
  return {
    role,
    workspace: {
      labels: LABELS,
      filmOrders: orders,
      sevenPurchaseOrders: [{
        id: 'po-1', poNumber: 'SEVEN-1', poNumberHidden: false, officialRegisteredAt: '2026-11-14', officiallyRegistered: true,
        verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false
      }],
      revisions: [],
      revisionsWithheld: 0,
      documents: [],
      deliveries: [],
      readiness: null
    },
    boards: [{ order: { id: 'ready' }, makerPurchaseOrders: [DRAFT_PAPER], paymentGate: null }],
    activity: [],
    now: NOW,
    ...extra
  };
}

/** One order per interesting state: staff work, a representative decision, a hold, done and cancelled. */
const MIXED = [
  order('approval', 'APPROVAL_PENDING'),
  order('ready', 'MAKER_PO_READY'),
  order('hold', 'ON_HOLD', {
    lastNormalStatus: 'APPROVAL_PENDING',
    hold: { reason: '色見本の再確認待ち', reasonHidden: false, actorName: '合成担当者', at: RECENT }
  }),
  order('done', 'FILM_RECEIPT_ASSUMED_NO_ISSUE'),
  order('cancelled', 'CANCELLED')
];

describe('sidebar menu by role (A)', () => {
  it('admin and staff see every screen in the order of the work', () => {
    const all = ['/dashboard', '/orders', '/documents', '/approvals', '/maker-po', '/deliveries', '/guide', '/status'];
    expect(navHrefsForRole('admin')).toEqual(all);
    expect(navHrefsForRole('staff')).toEqual(all);
    expect(navGroupsForRole('admin').map((group) => group.step)).toEqual([null, 1, 2, 3, 4, null]);
  });

  it('a viewer is not shown 文書 and 承認 (the API refuses it document:read and artwork_approval:read)', () => {
    expect(navHrefsForRole('viewer')).toEqual(['/dashboard', '/orders', '/maker-po', '/deliveries', '/guide', '/status']);
    // The デザイン・校正 group has no item left for a viewer and is dropped, not shown empty.
    expect(navGroupsForRole('viewer').map((group) => group.key)).not.toContain('artwork');
  });

  it('an unknown or missing role never gets more than the viewer menu', () => {
    expect(navHrefsForRole(null)).toEqual(navHrefsForRole('viewer'));
    expect(navHrefsForRole('superuser')).toEqual(navHrefsForRole('viewer'));
    expect(navRoleNote(null)).toBe('役割を確認できませんでした。再読み込みしてください。');
    expect(navRoleNote('viewer')).toContain('閲覧者');
    expect(navRoleNote('admin')).toBeNull();
    expect(navRoleNote('staff')).toBeNull();
  });

  it('marks only the current screen (aria-current="page"), including its sub-paths', () => {
    nav.pathname = '/maker-po/abc';
    const html = markup(<SideNav groups={navGroupsForRole('staff')} roleNote={null} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('<a aria-current="page" href="/maker-po">メーカー発注</a>');
    expect(html).toContain('<a href="/orders">案件（発注）一覧／作成</a>');
    expect(isCurrentNavItem('/orders-archive', '/orders')).toBe(false);
    nav.pathname = '/orders';
  });

  it('names the menu, numbers the phases in text and lists only the role’s links', () => {
    const html = markup(<SideNav groups={navGroupsForRole('viewer')} roleNote={navRoleNote('viewer')} />);
    expect(html).toContain('aria-label="業務メニュー（作業の順番）"');
    expect(html).toMatch(/<p id="nav-group-intake" class="app-nav-group-title"><span class="app-nav-step"><span class="visually-hidden">手順<\/span>1<\/span>受付・発注<\/p><ul aria-labelledby="nav-group-intake">/);
    // The group titles are not headings: the menu adds no outline level before the screen's h1.
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).not.toContain('href="/documents"');
    expect(html).not.toContain('href="/approvals"');
    // Japanese like every screen (no Korean in the menu).
    expect(html).not.toMatch(/[\uAC00-\uD7A3]/);
    expect(html).toContain('閲覧者のため、どの画面でも記録・変更はできません（閲覧のみ）。');
    expect(html).toContain(`id="${SIDEBAR_ID}"`);
    // Closed by default: no backdrop in the markup.
    expect(html).toContain('data-open="false"');
    expect(html).not.toContain('app-sidebar-backdrop');
  });

  it('the drawer toggle is a real button that says what it controls and whether it is open', () => {
    const html = markup(<NavDrawerToggle />);
    expect(html).toMatch(/^<button type="button" class="app-menu-toggle" aria-expanded="false" aria-controls="app-sidebar">/);
    expect(html).toContain('メニュー');
  });

  it('the open drawer is a named modal dialog; closed (and on a wide screen) it is a plain sidebar (review M-2)', () => {
    expect(drawerDialogAttributes(true)).toEqual({ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': DRAWER_TITLE_ID });
    expect(drawerDialogAttributes(false)).toEqual({});
    const html = markup(<SideNav groups={navGroupsForRole('admin')} roleNote={null} />);
    expect(html).toContain(`<span id="${DRAWER_TITLE_ID}">メニュー</span>`);
    expect(html).not.toContain('role="dialog"');
  });

  it('the drawer makes the page behind it inert, locks its scroll and gives focus back to 「メニュー」 on every close (review M-2, M-3)', async () => {
    const { readFileSync } = await import('node:fs');
    const drawer = readFileSync(new URL('../apps/web/src/components/NavDrawer.tsx', import.meta.url), 'utf8');
    const links = readFileSync(new URL('../apps/web/src/components/NavLinks.tsx', import.meta.url), 'utf8');
    expect(drawer).toContain("const BACKGROUND_SELECTORS = ['.app-header', '#main'] as const;");
    expect(drawer).toMatch(/for \(const element of background\) element\.inert = true;/);
    expect(drawer).toMatch(/for \(const element of background\) element\.inert = false;/);
    expect(drawer).toContain("document.body.style.overflow = 'hidden';");
    // Focus goes back only after the header is interactive again (cleanup order).
    expect(drawer).toMatch(/element\.inert = false;[\s\S]*if \(restoreFocusRef\.current\) \{\s*restoreFocusRef\.current = false;\s*toggleRef\.current\?\.focus\(\);/);
    // A menu link closes through the same close() that restores focus.
    expect(links).toMatch(/closest\('a\[href\]'\)\) close\(\);/);
    expect(links).toContain('{...drawerDialogAttributes(open)}');
  });

  it('every top-bar and drawer control is a 44px touch target on a phone or tablet (review M-4)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../apps/web/src/app/globals.css', import.meta.url), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 1023px)'));
    expect(narrow).toMatch(/\.app-menu-toggle,\s*\.app-sidebar-close,\s*\.app-help-link,\s*\.app-logout,\s*\.app-header-project \.project-picker-submit,\s*\.dash-next-link \{\s*min-height: 44px;/);
    expect(narrow).toMatch(/\.app-sidebar \.app-nav a \{\s*min-height: 44px;/);
    const logout = readFileSync(new URL('../apps/web/src/components/LogoutButton.tsx', import.meta.url), 'utf8');
    expect(logout).toContain('className="app-logout"');
  });

  it('the layout keeps the main region and wires the sidebar, the toggle and the guide line', async () => {
    const { readFileSync } = await import('node:fs');
    const layout = readFileSync(new URL('../apps/web/src/app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('<main id="main" tabIndex={-1} className="app-main">');
    expect(layout).toContain('<SideNav groups={navGroupsForRole(user.role)} roleNote={navRoleNote(user.role)} />');
    expect(layout).toContain('<NavDrawerToggle />');
    expect(layout).toContain('<ScreenGuideLine />');
    expect(layout).toContain('href={GUIDE_PATH}');
    expect(layout).not.toContain('NavLinks items=');
  });
});

describe('screen guide lines (C)', () => {
  it('every menu screen has a 「この画面でやること」 line', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) expect(SCREEN_GUIDES[item.href], item.href).toBeDefined();
    }
    expect(screenGuideFor('/maker-po/123')?.phase).toBe('メーカー発注');
    expect(screenGuideFor('/')).toBeNull();
    expect(screenGuideFor(null)).toBeNull();
  });

  it('the line names the step and links the usual next screen', () => {
    nav.pathname = '/orders';
    const html = markup(<ScreenGuideLine />);
    expect(html).toContain('手順1｜受付・発注');
    expect(html).toContain('この画面でやること');
    expect(html).toContain('<a href="/documents">文書画面を開く</a>');
    expect(html).not.toMatch(/[\uAC00-\uD7A3]/);
    expect(html).not.toContain('<aside');
    nav.pathname = '/deliveries';
    expect(markup(<ScreenGuideLine />)).not.toContain('次の段階');
    nav.pathname = '/';
    expect(markup(<ScreenGuideLine />)).toBe('');
    nav.pathname = '/orders';
  });

  it('the guide page steps are the stepper’s eight steps, in order, and there is a day per role', () => {
    expect(GUIDE_STEPS.map((step) => step.name)).toEqual([...PROGRESS_STEPS]);
    expect(GUIDE_DAYS.map((day) => day.role)).toEqual(['admin', 'staff', 'viewer']);
  });
});

describe('dashboard: flow counts (B)', () => {
  it('counts open orders per step; done, stopped, cancelled and withheld orders are counted outside', () => {
    const view = buildDashboard(input('admin', [...MIXED, order('hidden', 'DRAFT', { statusHidden: true })]));
    expect(view.flow.map((step) => step.count)).toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
    expect(view.completedCount).toBe(1);
    expect(view.exceptionCount).toBe(1);
    expect(view.cancelledCount).toBe(1);
    expect(view.hiddenCount).toBe(1);
  });

  it('marks the steps that hold the signed-in operator’s own work', () => {
    expect(buildDashboard(input('staff', MIXED)).flow[2]).toMatchObject({ count: 1, mine: 1 });
    // The hold is the admin's work but is counted outside the steps: it never marks 校正・校了 (review L).
    expect(buildDashboard(input('admin', MIXED)).flow[2]).toMatchObject({ count: 1, mine: 0 });
    expect(buildDashboard(input('admin', MIXED)).flow[3]).toMatchObject({ count: 1, mine: 1 });
    for (const role of ['admin', 'staff', 'viewer']) {
      expect(buildDashboard(input(role, MIXED)).flow.every((step) => step.mine <= step.count), role).toBe(true);
    }
  });

  it('renders every count with its unit and the next action with its link', () => {
    const html = markup(<DashboardFlow view={buildDashboard(input('staff', MIXED))} />);
    expect(html.match(/<li class="dash-flow-step/g)).toHaveLength(8);
    expect(html).toContain('<span class="dash-flow-count">1<span class="dash-flow-unit">件</span></span>');
    expect(html).toContain('段階の外: 止まっている 1件、完了 1件、取消で終了 1件');
    expect(html).toContain('href="/approvals"');
  });
});

describe('dashboard: 「いま自分がやること」 by role (B)', () => {
  it('admin: the representative’s decisions — the 代表承認 of a drafted maker PO and the hold — not the staff work', () => {
    const view = buildDashboard(input('admin', MIXED));
    expect(view.todo.map((item) => item.key)).toEqual(['order-ready', 'order-hold']);
    const approval = view.todo[0]!;
    expect(approval.title).toBe('メーカー発注書の代表承認を記録する（発注書は作成済み）。');
    expect(approval.kind).toBe('maker_po');
    expect(approval.amount).toBe('¥480,000');
    expect(approval.href).toBe('/maker-po#maker-order-ready');
    expect(view.todo[1]!.detail).toContain('保留の理由: 色見本の再確認待ち');
    expect(view.todo[1]!.href).toBe('/orders#order-hold');
    expect(view.others.map((item) => item.key)).toEqual(['order-approval']);
  });

  it('admin: a cancelled order whose maker paper is still live is the representative’s cleanup (review H)', () => {
    const base = input('admin', [order('cancelled', 'CANCELLED')]);
    const withCleanup = { ...base, workspace: { ...base.workspace, makerPaperCleanup: {
      cancelled: { state: 'cleanup' as const, livePapers: 1, cancellablePapers: 1, acknowledgementPapers: 0 }
    } } };
    const view = buildDashboard(withCleanup);
    expect(view.todo.map((item) => item.key)).toEqual(['order-cancelled']);
    expect(view.todo[0]!.title).toContain('メーカー発注書の整理が残っています');
    expect(view.todo[0]!.href).toBe('/maker-po#maker-order-cancelled');
    // Settled paper: nothing left to do.
    const settled = { ...base, workspace: { ...base.workspace, makerPaperCleanup: {
      cancelled: { state: 'none' as const, livePapers: 0, cancellablePapers: 0, acknowledgementPapers: 0 }
    } } };
    expect(buildDashboard(settled).todo).toEqual([]);
  });

  it('変更レビュー follows the server: resumed through film_order:transition, so it is staff work; the admin sees it as staff work (review R-1)', () => {
    const cr = [order('cr', 'CHANGE_REVIEW', { lastNormalStatus: 'APPROVAL_PENDING' })];
    const staff = buildDashboard(input('staff', cr));
    expect(staff.todo.map((item) => item.key)).toEqual(['order-cr']);
    expect(staff.todo[0]!.owner).toBe('担当者・代表者');
    expect(staff.todo[0]!.detail).toBe(CHANGE_REVIEW_NOTE);
    expect(CHANGE_REVIEW_NOTE).toContain('担当者・代表者が行えます');
    expect(CHANGE_REVIEW_NOTE).toContain('印刷開始（フィルム製造中）以降の変更は、代表者の承認と実費の記録が必要です');
    const admin = buildDashboard(input('admin', cr));
    expect(admin.todo).toEqual([]);
    expect(admin.others.map((item) => item.key)).toEqual(['order-cr']);
    // Only the hold release and the cancellation review are the representative's own.
    for (const status of ['ON_HOLD', 'CANCELLATION_REVIEW']) {
      const own = buildDashboard(input('admin', [order('x', status, { lastNormalStatus: 'APPROVAL_PENDING' })]));
      expect(own.todo.map((item) => item.key), status).toEqual(['order-x']);
      expect(buildDashboard(input('staff', [order('x', status, { lastNormalStatus: 'APPROVAL_PENDING' })])).todo, status).toEqual([]);
    }
    expect(TODO_SCOPE.admin).toContain('保留の解除、取消レビューの処理');
    expect(TODO_SCOPE.admin).not.toContain('変更レビュー');
    expect(TODO_SCOPE.staff).toContain('変更レビューからの再開');
  });

  it('staff: the records staff makes; the representative’s steps are listed as waiting, never as staff work', () => {
    const view = buildDashboard(input('staff', MIXED));
    expect(view.todo.map((item) => item.key)).toEqual(['order-approval']);
    expect(view.todo[0]!.href).toBe('/approvals');
    expect(view.others.map((item) => item.key)).toEqual(['order-ready', 'order-hold']);
    expect(view.nextAction.text).toContain('FSO-approval');
  });

  it('viewer: nothing to record; the work in progress is listed with who does it', () => {
    const view = buildDashboard(input('viewer', MIXED));
    expect(view.todo).toEqual([]);
    // 承認 is not in the viewer's menu: the item opens the order row instead.
    expect(view.others[0]!.href).toBe('/orders#order-approval');
    expect(view.others[0]!.linkLabel).toBe('発注画面を開く');
    expect(view.others.map((item) => item.owner)).toEqual(['担当者・代表者', '代表者', '代表者']);
  });

  it('an unconfirmed delivery is staff work (納品確認) and the representative’s reference', () => {
    const delivery = {
      id: 'd1', kind: 'film' as const, orderId: 'approval', lineId: 'approval-l1', unit: 'sheets', deliveredQuantity: '1000',
      deliverySequence: 1, deliveredAt: RECENT, recordedAt: RECENT, note: null, confirmed: false,
      evidenceDocumentVersionId: null, confirmedAt: null, detailsHidden: false, confirmationHidden: false
    };
    const base = input('staff', []);
    const withDelivery = { ...base, workspace: { ...base.workspace, deliveries: [delivery] } };
    expect(buildDashboard(withDelivery).todo.map((item) => item.key)).toEqual(['deliveries-unconfirmed']);
    expect(buildDashboard({ ...withDelivery, role: 'admin' }).others.map((item) => item.key)).toEqual(['deliveries-unconfirmed']);
    const hidden = { ...withDelivery, workspace: { ...withDelivery.workspace, deliveries: [{ ...delivery, confirmationHidden: true }] } };
    expect(buildDashboard(hidden).todo).toEqual([]);
  });

  it('with nothing of its own to do, the next action names whose step comes next, worded per role', () => {
    const onlyStaffWork = [order('approval', 'APPROVAL_PENDING')];
    expect(buildDashboard(input('admin', onlyStaffWork)).nextAction.text)
      .toMatch(/^代表者の判断が必要な作業はありません。進行中の次の作業: FSO-approval /);
    expect(buildDashboard(input('staff', [order('hold', 'ON_HOLD', { lastNormalStatus: 'APPROVAL_PENDING' })])).nextAction.text)
      .toMatch(/^いまはあなたの作業はありません。代表者の作業待ち: FSO-hold /);
    expect(buildDashboard(input('viewer', onlyStaffWork)).nextAction.text).toMatch(/^進行中の次の作業: FSO-approval /);
    expect(buildDashboard(input('staff', [order('done', 'FILM_RECEIPT_ASSUMED_NO_ISSUE')])).nextAction)
      .toEqual({ text: 'この案件で進めている作業はありません。', href: null, linkLabel: null, owner: null });
  });

  it('without any order the next action is the first record of the flow (or why the role cannot make it)', () => {
    const empty = input('staff', []);
    const noPo = { ...empty, workspace: { ...empty.workspace, sevenPurchaseOrders: [] } };
    expect(buildDashboard(noPo).nextAction).toMatchObject({ text: 'セブン化学発注書を登録する。', href: '/orders' });
    expect(buildDashboard(empty).nextAction.text).toBe('フィルム発注を作成する。');
    expect(buildDashboard({ ...noPo, role: 'viewer' }).nextAction.text).toContain('閲覧権限のため操作できません');
  });
});

describe('dashboard redaction: amounts only for the representative, 決済条件 for everyone', () => {
  it('dashboardAmount: admin reads the formatted total; staff, viewer and an unknown role never do — even from a row that carries it', () => {
    expect(dashboardAmount('admin', DRAFT_PAPER)).toBe('¥480,000');
    for (const role of ['staff', 'viewer', null, undefined, 'superuser']) {
      expect(dashboardAmount(role, DRAFT_PAPER), String(role)).toBeNull();
    }
    expect(dashboardAmount('admin', { snapshot: { amounts: null } })).toBeNull();
  });

  it('no item of a staff or viewer dashboard carries an amount, and the rendered lists show no 金額 or ¥', () => {
    for (const role of ['staff', 'viewer']) {
      const view = buildDashboard(input(role, MIXED));
      const items = [...view.todo, ...view.others, ...view.blocked];
      expect(items.length, role).toBeGreaterThan(0);
      expect(items.every((item) => item.amount === null), role).toBe(true);
      const html = markup(<>
        <DashboardFlow view={view} />
        <DashboardItemList items={items} label="x" empty="" />
      </>);
      expect(html, role).not.toMatch(/480,?000|¥|金額/);
    }
    const adminHtml = markup(<DashboardItemList items={buildDashboard(input('admin', MIXED)).todo} label="x" empty="" />);
    expect(adminHtml).toContain('金額: ¥480,000');
  });

  it('the 決済条件 is on every order item for every role; a withheld one says so, never 未記録', () => {
    for (const role of ['admin', 'staff', 'viewer']) {
      const view = buildDashboard(input(role, MIXED));
      expect([...view.todo, ...view.others].every((item) => item.paymentTerms === '前払い'), role).toBe(true);
    }
    const hidden = buildDashboard(input('viewer', [order('approval', 'APPROVAL_PENDING', { paymentTerms: null, paymentTermsHidden: true })]));
    expect(hidden.others[0]!.paymentTerms).toBe(HIDDEN_BY_ROLE_LABEL);
    const html = markup(<DashboardItemList items={buildDashboard(input('staff', MIXED)).todo} label="x" empty="" />);
    expect(html).toContain('決済条件: 前払い');
  });
});

describe('dashboard: 막힌 건 (blocked)', () => {
  it('lists the hold with its reason and the step it interrupted', () => {
    const blocked = buildDashboard(input('staff', MIXED)).blocked;
    expect(blocked.map((item) => item.key)).toEqual(['exception-hold']);
    expect(blocked[0]!.title).toBe('「保留中」で止まっています。');
  });

  it('an unlinked draft and a draft without 明細 are stuck; the next step’s missing evidence is that task’s note, not a block (review M)', () => {
    const view = buildDashboard(input('staff', [
      order('artwork', 'ARTWORK_RECEIVED'),
      order('unlinked', 'DRAFT', { sevenPurchaseOrderId: null }),
      order('nolines', 'DRAFT', { lineCount: 0, lines: [] })
    ]));
    expect(view.blocked.map((item) => item.key)).toEqual(['unlinked-unlinked', 'lines-nolines']);
    const task = view.todo.find((item) => item.key === 'order-artwork')!;
    expect(task.href).toBe('/approvals');
    expect(task.detail).toBe('証跡が未登録: この発注の校正ゲラの版が、承認画面にまだ登録されていません。');
  });

  it('a stalled order names its missing evidence; a viewer is never told evidence is missing', () => {
    const old = new Date(NOW.getTime() - 9 * 86_400_000).toISOString();
    const stalled = [order('artwork', 'ARTWORK_RECEIVED', { updatedAt: old })];
    const staff = buildDashboard(input('staff', stalled));
    // Its own neutral list, never 「止まっている発注」 (review M-1).
    expect(staff.blocked).toEqual([]);
    expect(staff.stalled.map((item) => item.key)).toEqual(['stale-artwork']);
    expect(staff.stalled[0]!.detail).toMatch(/^待っているもの: メーカーの校正ゲラ／証跡が未登録: この発注の校正ゲラの版が、承認画面にまだ登録されていません。／最後の記録: /);
    // A viewer does not read the linked records: nothing is judged, and it says why.
    const viewer = buildDashboard(input('viewer', stalled));
    expect(viewer.stalled).toEqual([]);
    expect(viewer.stalledNote).toContain('閲覧者には関連する記録の一部が表示されない');
    expect([...viewer.others, ...viewer.blocked].some((item) => (item.detail ?? '').includes('証跡が未登録'))).toBe(false);
  });

  it('a failed workspace read claims nothing missing and never asks for a first registration (review M)', () => {
    const base = input('staff', [order('unlinked', 'DRAFT', { sevenPurchaseOrderId: null, lineCount: 0, lines: [] }), order('artwork', 'ARTWORK_RECEIVED')]);
    const failed = buildDashboard({ ...base, workspace: { ...base.workspace, error: '監査履歴が取得できませんでした（500）。' } });
    expect(failed.blocked).toEqual([]);
    expect(failed.todo.find((item) => item.key === 'order-artwork')!.detail).toBeNull();
    const empty = input('staff', []);
    expect(buildDashboard({ ...empty, workspace: { ...empty.workspace, error: 'x' } }).nextAction)
      .toEqual({ text: '記録を読み込めなかったため、次の行動を表示できません。画面上部の案内を確認してください。', href: null, linkLabel: null, owner: null });
  });

  it('an order in a state the flow does not name is counted as such, never on a step (review L)', () => {
    const view = buildDashboard(input('staff', [order('odd', 'SOME_NEW_STATE')]));
    expect(view.unknownCount).toBe(1);
    expect(view.flow.every((step) => step.count === 0)).toBe(true);
    expect(markup(<DashboardFlow view={view} />)).toContain('段階を表示できない状態 1件');
  });

  it('never calls withheld details missing (staff/viewer answers without the link or the lines)', () => {
    const view = buildDashboard(input('viewer', [order('x', 'DRAFT', { detailsHidden: true, sevenPurchaseOrderId: null, lineCount: 0, lines: [] })]));
    expect(view.blocked).toEqual([]);
  });

  it(`an open order without a record for ${STALE_AFTER_DAYS} days is stalled; ${STALE_AFTER_DAYS - 1} days is not`, () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const view = buildDashboard(input('staff', [
      order('old', 'APPROVAL_PENDING', { updatedAt: at(STALE_AFTER_DAYS) }),
      order('fresh', 'APPROVAL_PENDING', { updatedAt: at(STALE_AFTER_DAYS - 1) }),
      order('done', 'FILM_RECEIPT_ASSUMED_NO_ISSUE', { updatedAt: at(40) }),
      // Waiting on the maker or the carrier: a quiet week is normal (review M).
      order('making', 'FILM_IN_PRODUCTION', { updatedAt: at(30) }),
      order('shipping', 'FILM_SHIPPED', { updatedAt: at(30) })
    ]));
    expect(view.blocked).toEqual([]);
    expect(view.stalled.map((item) => item.key)).toEqual(['stale-old']);
    // Neutral: 「更新が止まっています」, never a delay; it names what the order waits on.
    expect(view.stalled[0]!.title).toBe(`更新が止まっています（${STALE_AFTER_DAYS}日間記録なし、いま: 校正・校了）。`);
    expect(view.stalled[0]!.detail).toMatch(/^待っているもの: 顧客・セブン化学の校了／最後の記録: /);
    expect(view.stalled.map((item) => item.title).join()).not.toMatch(/遅延|遅れ/);
    expect(STALE_BASIS).toContain(`最後の記録から${STALE_AFTER_DAYS}日以上`);
    expect(STALE_BASIS).toContain('納期は記録されていないため、遅れかどうかは判定していません');
  });

  it('work recorded on a linked record (an approval, a document) keeps the order from looking stalled (review M)', () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const approval = {
      id: 'ev1', action: 'ARTWORK_APPROVAL_RECORDED', entityType: 'artwork_approval_event', entityId: 'ap1', beforeState: null,
      afterState: { filmSupplyOrderId: 'old', organization: 'customer' }, requestMetadata: null, occurredAt: at(1), actor: null
    };
    const orders = [order('old', 'APPROVAL_PENDING', { updatedAt: at(10) })];
    expect(buildDashboard(input('staff', orders, { activity: [approval] })).stalled).toEqual([]);
    // A セブン化学発注書 record counts for the orders made from it (review M-1 c).
    const poEvent = { ...approval, id: 'ev2', entityType: 'seven_purchase_order', entityId: 'po-1', afterState: { status: 'verified' } };
    expect(buildDashboard(input('staff', orders, { activity: [poEvent] })).stalled).toEqual([]);
    // Reading a document is not work on the order.
    const viewed = { ...approval, id: 'ev3', action: 'DOCUMENT_VERSION_VIEWED', entityType: 'document_version' };
    expect(buildDashboard(input('staff', orders, { activity: [viewed] })).stalled.map((item) => item.key)).toEqual(['stale-old']);
    // A failed or capped activity read cannot see the linked records: no judgement, and the note says so (review M-1 b).
    for (const activity of [null, Array.from({ length: ACTIVITY_READ_LIMIT }, (_, index) => ({ ...viewed, id: `c${index}` }))]) {
      const view = buildDashboard(input('staff', orders, { activity }));
      expect(view.stalled).toEqual([]);
      expect(view.stalledNote).toContain('判定していません');
    }
  });

  it('a send that could not be verified, a refused payment gate and readiness blockers', () => {
    const base = input('admin', [order('ready', 'MAKER_PO_READY'), order('sent', 'MAKER_PO_SENT_MANUALLY')]);
    const view = buildDashboard({
      ...base,
      workspace: { ...base.workspace, readiness: { readinessState: 'NOT_READY', isReady: false, blocking: ['FILM_DELIVERY_NOT_RECORDED'], evaluatedAt: RECENT, hidden: false } },
      boards: [
        { order: { id: 'ready' }, makerPurchaseOrders: [], paymentGate: {
          orderId: 'ready', orderStatus: 'MAKER_PO_READY', paymentTerms: 'undetermined', paymentConfirmedAt: null,
          gate: { satisfied: false, code: 'PAYMENT_TERMS_UNDETERMINED', reason: '決済条件が未確定です' }
        } },
        { order: { id: 'sent' }, makerPurchaseOrders: [{ id: 'mpo-u', status: 'SEND_UNVERIFIED' }], paymentGate: null }
      ]
    });
    expect(view.blocked.map((item) => item.key)).toEqual(['gate-ready', 'unverified-mpo-u', 'readiness']);
    expect(view.blocked[0]!.detail).toBe('決済条件が未確定です');
    expect(view.blocked[2]!.detail).toBe('フィルム納品がまだ記録されていません');
  });
});

describe('dashboard: recent activity', () => {
  const event = (index: number, action: string, extra: Record<string, unknown> = {}) => ({
    id: `e${index}`, action, entityType: 'film_supply_order', entityId: 'approval', beforeState: null,
    afterState: { status: 'APPROVAL_PENDING', totalAmount: '480000' }, requestMetadata: null,
    occurredAt: new Date(Date.parse('2026-11-19T00:00:00.000Z') + index * 60_000).toISOString(),
    actor: { id: 'u', displayName: '合成担当者', role: 'staff' }, ...extra
  });

  it(`newest first, at most ${ACTIVITY_LIMIT}, reads (views/downloads) left out, never an amount`, () => {
    const rows = Array.from({ length: 12 }, (_, index) => event(index, 'FILM_SUPPLY_ORDER_TRANSITIONED'));
    rows.push(event(20, 'DOCUMENT_VERSION_VIEWED', { entityType: 'document_version' }));
    const view = buildDashboard(input('staff', [order('approval', 'APPROVAL_PENDING')], { activity: rows }));
    expect(view.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(view.activity[0]!.key).toBe('e11');
    expect(view.activity[0]!.text).toBe('FSO-approval 発注の状態を変更（→「校了確認待ち」）');
    expect(view.activity[0]!.href).toBe('/orders#order-approval');
    const html = markup(<DashboardActivity view={view} />);
    expect(html).not.toMatch(/480,?000|¥/);
    expect(html).toContain('合成担当者');
  });

  it('a failed read and a capped read are said, never shown as 「まだ記録はありません」', () => {
    expect(buildDashboard(input('staff', [], { activity: null })).activityNote).toBe('最近の記録を読み込めませんでした。');
    const capped = Array.from({ length: ACTIVITY_READ_LIMIT }, (_, index) => event(index, 'FILM_SUPPLY_ORDER_TRANSITIONED'));
    const view = buildDashboard(input('staff', [], { activity: capped }));
    expect(view.activity).toEqual([]);
    expect(view.activityNote).toContain('最近の記録はここに表示できません');
    expect(buildDashboard(input('staff', [], { activity: [] })).activityNote).toBe('まだ記録はありません。');
  });
});

describe('item links', () => {
  it('open the order on /orders and /maker-po, the screen elsewhere', () => {
    expect(itemHref('/orders', 'o1')).toBe('/orders#order-o1');
    expect(itemHref('/maker-po', 'o1')).toBe('/maker-po#maker-order-o1');
    expect(itemHref('/approvals', 'o1')).toBe('/approvals');
    expect(itemHref('/deliveries', null)).toBe('/deliveries');
  });

  it('the screens carry the anchors the dashboard links to', async () => {
    const { readFileSync } = await import('node:fs');
    const orders = readFileSync(new URL('../apps/web/src/app/orders/page.tsx', import.meta.url), 'utf8');
    const maker = readFileSync(new URL('../apps/web/src/app/maker-po/page.tsx', import.meta.url), 'utf8');
    expect(orders).toContain('id={`order-${order.id}`}');
    expect(maker).toContain('id={`maker-order-${entry.order.id}`}');
  });

  it('an empty list says what is (not) there instead of rendering nothing', () => {
    expect(markup(<DashboardItemList items={[]} label="x" empty="止まっている発注はありません。" />))
      .toBe('<p class="dash-empty">止まっている発注はありません。</p>');
  });
});
