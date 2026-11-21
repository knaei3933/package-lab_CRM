/**
 * UI nav-dashboard (demo-eml/ui-nav-dashboard/REPORT.md): the left sidebar.
 *
 * The menu is ordered by the F1 film order flow (Workflow v1.3 §4 A-2 / §5 F1):
 * セブン化学発注書 → デザイン入稿・校正 → 校了（顧客＋セブン化学） → メーカー発注書・
 * 代表承認・手動送信・受入 → 生産・出荷・納品 → 受領確認・手数料準備. Each group is one
 * phase of that flow and is numbered because the phases are a real sequence.
 *
 * Which items a role sees is display only (DESIGN_RULES §0-1): the API keeps
 * refusing what the role may not read. A viewer is not shown 文書 and 承認
 * because the API refuses a viewer document:read and artwork_approval:read
 * (packages/core authorization.ts) — those screens would only say
 * 「閲覧権限なし」. An unknown role (null: GET /api/me did not answer) is shown
 * the viewer menu, never more.
 */

export type NavRole = 'admin' | 'staff' | 'viewer';

/**
 * Same rule as permissions.normalizeRole (an unknown role reads as viewer),
 * kept here because the sidebar and the guide line are client components and
 * permissions.ts pulls in @kanei/core, which needs Node built-ins.
 */
function navRole(role: string | null | undefined): NavRole {
  return role === 'admin' || role === 'staff' ? role : 'viewer';
}

export interface NavLinkItem {
  href: string;
  label: string;
  /** The roles that see this item in the menu. */
  roles: readonly NavRole[];
}

export interface NavGroup {
  key: string;
  /** Step number of the phase in the flow; null for the groups outside it. */
  step: number | null;
  title: string;
  items: readonly NavLinkItem[];
}

const ALL: readonly NavRole[] = ['admin', 'staff', 'viewer'];
const OPERATORS: readonly NavRole[] = ['admin', 'staff'];

export const DASHBOARD_PATH = '/dashboard';
export const GUIDE_PATH = '/guide';
/** P1 R26: the role's home — 承認箱 (representative), 自分の作業 (staff), 履歴 (viewer). */
export const HOME_PATH = '/home';

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'home',
    step: null,
    title: 'ホーム',
    items: [
      { href: HOME_PATH, label: '承認箱', roles: ['admin'] },
      { href: HOME_PATH, label: '自分の作業', roles: ['staff'] },
      { href: HOME_PATH, label: '履歴', roles: ['viewer'] },
      { href: DASHBOARD_PATH, label: 'ダッシュボード', roles: ALL }
    ]
  },
  {
    key: 'intake',
    step: 1,
    title: '受付・発注',
    items: [{ href: '/orders', label: '案件（発注）一覧／作成', roles: ALL }]
  },
  {
    key: 'artwork',
    step: 2,
    title: 'デザイン・校正',
    items: [
      { href: '/documents', label: '文書', roles: OPERATORS },
      { href: '/approvals', label: '承認（校了）', roles: OPERATORS }
    ]
  },
  {
    key: 'maker',
    step: 3,
    title: 'メーカー発注',
    items: [{ href: '/maker-po', label: 'メーカー発注', roles: ALL }]
  },
  {
    key: 'delivery',
    step: 4,
    title: '納品・手数料',
    items: [{ href: '/deliveries', label: '納品確認・手数料準備', roles: ALL }]
  },
  {
    key: 'help',
    step: null,
    title: '参照',
    items: [
      { href: GUIDE_PATH, label: '使い方ガイド', roles: ALL },
      { href: '/status', label: '状態表示', roles: ALL }
    ]
  }
];

/** The menu of one role: groups with only the items it sees, empty groups dropped. */
export function navGroupsForRole(role: string | null | undefined): NavGroup[] {
  const effective = navRole(role);
  return NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => item.roles.includes(effective)) }))
    .filter((group) => group.items.length > 0);
}

/** Every href the role sees, in menu order (tests and the guide read it). */
export function navHrefsForRole(role: string | null | undefined): string[] {
  return navGroupsForRole(role).flatMap((group) => group.items.map((item) => item.href));
}

/** True when `pathname` is the item's screen or one of its sub-paths. */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** A line under the menu for a role that only reads, or whose role could not be read. */
export function navRoleNote(role: string | null | undefined): string | null {
  if (role === null || role === undefined) return '役割を確認できませんでした。再読み込みしてください。';
  return navRole(role) === 'viewer' ? '閲覧者のため、どの画面でも記録・変更はできません（閲覧のみ）。' : null;
}

/**
 * The one-line 「この画面でやること／次の段階」 above each screen, in the
 * screens' own Japanese wording (screen, button and state names as shown).
 * `next` names the screen that usually follows; null when the screen is not
 * a step of the flow.
 */
export interface ScreenGuide {
  step: number | null;
  phase: string;
  doHere: string;
  next: { href: string; label: string; text: string } | null;
}

export const SCREEN_GUIDES: Readonly<Record<string, ScreenGuide>> = {
  // P1 R26: the role homes explain themselves (no guide line, REDESIGN §6-2).
  [DASHBOARD_PATH]: {
    step: null,
    phase: 'ホーム',
    doHere: '「いま自分がやること」を上から順に進めます。項目を押すと、その作業をする画面（該当の発注）が開きます。',
    next: null
  },
  '/orders': {
    step: 1,
    phase: '受付・発注',
    doHere: 'セブン化学発注書を登録し、公式登録日と真性行チェックリストを記録してから、フィルム発注を作成して状態を進めます（「フィルム製造中」「フィルム発送済み」への変更もこの画面です）。',
    next: { href: '/documents', label: '文書', text: '「セブン化学発注書確認済」になったら、文書画面でデザイン入稿データを登録します。' }
  },
  '/documents': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: 'デザイン入稿データ・校正ゲラ・承認証跡・受領証跡のファイルを登録し、確認の結果を記録します。',
    next: { href: '/approvals', label: '承認（校了）', text: '校正ゲラを登録したら、承認画面で版を登録して校了を記録します。' }
  },
  '/approvals': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: '校正ゲラの版を登録し、同じ版に対する顧客の承認とセブン化学の承認をそれぞれ記録します（順番は問いません。両方そろって校了です）。',
    next: { href: '/maker-po', label: 'メーカー発注', text: '「校了（顧客・セブン化学）」になったら、発注を「製造先発注準備完了」へ進めてメーカー発注画面へ。' }
  },
  '/maker-po': {
    step: 3,
    phase: 'メーカー発注',
    doHere: 'メーカー発注書の作成と代表承認（代表者）→ 送信済みメールの原本（EML）で手動送信を記録 → 受入（仮）と最終受入、の順に進めます。',
    next: { href: '/orders', label: '案件（発注）', text: '最終受入が済んだら、発注画面で「フィルム製造中」「フィルム発送済み」へ進めます。' }
  },
  '/deliveries': {
    step: 4,
    phase: '納品・手数料',
    doHere: '納品を記録し、受領証跡を引用して納品確認をしたあと、手数料準備状態を評価し直します。',
    next: null
  },
  [GUIDE_PATH]: {
    step: null,
    phase: '参照',
    doHere: '初めて使う人のための案内です。作業の順番、役割ごとの一日の流れ、用語、よく止まる場面をまとめています。',
    next: null
  },
  '/status': {
    step: null,
    phase: '参照',
    doHere: '画面に出てくる状態名（日本語ラベル）の一覧です。ここでは記録はしません。',
    next: null
  }
};

/** The guide of the screen at `pathname`, or null (login screen, unknown path). */
export function screenGuideFor(pathname: string | null): ScreenGuide | null {
  if (!pathname) return null;
  if (SCREEN_GUIDES[pathname]) return SCREEN_GUIDES[pathname]!;
  const match = Object.keys(SCREEN_GUIDES).find((href) => isCurrentPath(pathname, href));
  return match ? SCREEN_GUIDES[match]! : null;
}
