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

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'home',
    step: null,
    title: 'ホーム',
    items: [{ href: DASHBOARD_PATH, label: 'ダッシュボード', roles: ALL }]
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

/** A line under the menu for a role that only reads (Korean guide copy, lang="ko"). */
export function navRoleNote(role: string | null | undefined): string | null {
  if (role === null || role === undefined) return '역할을 확인하지 못했습니다. 새로고침해 주세요.';
  return navRole(role) === 'viewer' ? '閲覧者: 보기 전용입니다（記録・変更はできません）.' : null;
}

/**
 * The one-line 「이 화면에서 할 일 / 다음 단계」 above each screen. Korean guide
 * copy that keeps the screen and button names in their Japanese wording, so
 * the operator finds the same words on the screen. `next` names the screen
 * that usually follows; null when the screen is not a step of the flow.
 */
export interface ScreenGuide {
  step: number | null;
  phase: string;
  doHere: string;
  next: { href: string; label: string; text: string } | null;
}

export const SCREEN_GUIDES: Readonly<Record<string, ScreenGuide>> = {
  [DASHBOARD_PATH]: {
    step: null,
    phase: 'ホーム',
    doHere: '「지금 내가 할 일」부터 위에서 차례로 처리합니다. 항목을 누르면 그 작업을 하는 화면이 열립니다.',
    next: null
  },
  '/orders': {
    step: 1,
    phase: '受付・発注',
    doHere: 'セブン化学発注書를 등록·公式登録·真性行チェックリスト까지 마치고, フィルム発注을 만들어 상태를 진행합니다（生産中・発送済み 진행도 이 화면）.',
    next: { href: '/documents', label: '文書', text: '「セブン確認済み」가 되면 文書 화면에서 デザイン入稿データ를 등록합니다.' }
  },
  '/documents': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: 'デザイン入稿データ・校正ゲラ・承認証跡・受領証跡 파일을 올리고 確認 결과를 기록합니다.',
    next: { href: '/approvals', label: '承認（校了）', text: '校正ゲラ를 올렸으면 承認 화면에서 版을 등록하고 校了를 기록합니다.' }
  },
  '/approvals': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: '校正ゲラの版을 등록하고, 같은 版에 대한 顧客 承認과 セブン化学 承認을 각각 기록합니다（순서 무관, 둘 다 필요）.',
    next: { href: '/maker-po', label: 'メーカー発注', text: '「校了（ダブル承認）」이 되면 発注을 「製造先発注準備完了」로 진행한 뒤 メーカー発注 화면으로.' }
  },
  '/maker-po': {
    step: 3,
    phase: 'メーカー発注',
    doHere: 'メーカー発注書 작성·代表承認（代表者）→ 送信済みメール原本（EML）로 手動送信 기록 → 受入（仮）·最終受入 순서로 진행합니다.',
    next: { href: '/orders', label: '案件（発注）', text: '受入確認이 끝나면 発注 화면에서 「生産中」「発送済み」로 진행합니다.' }
  },
  '/deliveries': {
    step: 4,
    phase: '納品・手数料',
    doHere: '納品을 기록하고, 受領証跡을 인용해 納品確認을 한 뒤 手数料準備状態를 다시 평가합니다.',
    next: null
  },
  [GUIDE_PATH]: {
    step: null,
    phase: '参照',
    doHere: '처음 쓰는 분을 위한 안내입니다. 역할별 하루 흐름, 용어, 자주 막히는 상황을 정리했습니다.',
    next: null
  },
  '/status': {
    step: null,
    phase: '参照',
    doHere: '화면에 나오는 상태 이름（日本語ラベル）의 목록입니다. 기록은 하지 않습니다.',
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
