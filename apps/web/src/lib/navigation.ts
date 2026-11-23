/**
 * UI nav-dashboard (demo-eml/ui-nav-dashboard/REPORT.md): the left sidebar.
 *
 * The menu is ordered by the F1 film order flow (Workflow v1.3 §4 A-2 / §5 F1):
 * セブン化学発注書 → デザイン入稿・校正 → 校了（顧客＋セブン化学） → メーカー発注書・
 * 代表承認・送信の記録・受入 → 生産・出荷・納品 → 受領確認・手数料準備. Each group is one
 * phase of that flow and is numbered because the phases are a real sequence.
 *
 * Which items a role sees is display only (DESIGN_RULES §0-1): the API keeps
 * refusing what the role may not read. A viewer is not shown 文書 and 承認
 * because the API refuses a viewer document:read and artwork_approval:read
 * (packages/core authorization.ts) — those screens would only say
 * 「閲覧権限なし」. An unknown role (null: GET /api/me did not answer) is shown
 * the viewer menu, never more.
 */

export type NavRole = 'admin' | 'staff' | 'viewer' | 'auditor';

/**
 * Same rule as permissions.normalizeRole (an unknown role reads as viewer),
 * kept here because the sidebar and the guide line are client components and
 * permissions.ts pulls in @kanei/core, which needs Node built-ins.
 */
export function navRole(role: string | null | undefined): NavRole {
  // P2 P-2: the audit-only role has its own menu (contract §7); the write forms still read it as viewer.
  return role === 'admin' || role === 'staff' || role === 'auditor' ? role : 'viewer';
}

export interface NavLinkItem {
  href: string;
  label: string;
  /** P4 N15: the Korean gloss — one source with the label (it used to come from a second table). */
  ko: string;
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
/** P2 P-2: the screens the auditor reads (their APIs answer the auditor; nothing to write there). */
const READERS: readonly NavRole[] = ['admin', 'staff', 'viewer', 'auditor'];

/** P2 R33: the representative's maker master (メーカーと送信先メール). */
export const MAKERS_PATH = '/makers';
/** P2 P-2: the evidence metadata list of a project (GET …/evidence-metadata). */
export const EVIDENCE_PATH = '/evidence';

export const DASHBOARD_PATH = '/dashboard';
export const GUIDE_PATH = '/guide';
/** P1 R26: the role's home — 承認箱 (representative), 自分の作業 (staff), 履歴 (viewer). */
export const HOME_PATH = '/home';

/**
 * P4 §0 (audit44 UNRESOLVED §0-3): the menu keeps the lists only. Every record of a
 * film order is made on the order's own screen (/p/{案件}/o/{発注}); for the operators
 * (admin, staff) the old screens 文書・承認・メーカー発注・納品 are read-only lists reached
 * from the order screen and from 発注の一覧, not from the menu (they used to pull people
 * into their old forms). The roles that only read (viewer, auditor) cannot open the order
 * screen (H10①), so they keep the read-only screens they read, named 「（閲覧）」 — P4
 * H10② for the auditor's 承認.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'home',
    step: null,
    title: 'ホーム',
    items: [
      { href: HOME_PATH, label: '承認箱', ko: '승인함', roles: ['admin'] },
      { href: HOME_PATH, label: '自分の作業', ko: '내 작업', roles: ['staff'] },
      { href: HOME_PATH, label: '履歴', ko: '이력', roles: ['viewer'] },
      { href: HOME_PATH, label: '監査履歴', ko: '감사 이력', roles: ['auditor'] },
      { href: DASHBOARD_PATH, label: 'ダッシュボード', ko: '대시보드(안건 선택)', roles: ALL }
    ]
  },
  {
    key: 'lists',
    step: null,
    title: '一覧',
    items: [
      { href: '/orders', label: '発注の一覧', ko: '발주 목록', roles: READERS },
      { href: '/approvals', label: '承認（閲覧）', ko: '승인(열람)', roles: ['auditor'] },
      { href: '/maker-po', label: 'メーカー発注（閲覧）', ko: '제조사 발주(열람)', roles: ['viewer', 'auditor'] },
      { href: '/deliveries', label: '納品・手数料（閲覧）', ko: '납품·수수료(열람)', roles: ['viewer'] },
      { href: EVIDENCE_PATH, label: '証跡の一覧', ko: '증빙 목록', roles: ['admin', 'staff', 'auditor'] }
    ]
  },
  {
    key: 'master',
    step: null,
    title: '設定',
    items: [{ href: MAKERS_PATH, label: 'メーカーの宛先', ko: '제조사 수신처', roles: ['admin'] }]
  },
  {
    key: 'help',
    step: null,
    title: '参照',
    items: [
      { href: GUIDE_PATH, label: '使い方ガイド', ko: '사용 안내', roles: READERS },
      { href: '/status', label: '状態表示', ko: '상태 표시', roles: READERS }
    ]
  }
];

/** P4 §0: the read-only lists the operators reach from 発注の一覧 and the order screen (not from the menu). */
export const READ_ONLY_LISTS: readonly { href: string; label: string }[] = [
  { href: '/documents', label: '文書の一覧' },
  { href: '/approvals', label: '承認の一覧' },
  { href: '/maker-po', label: 'メーカー発注の一覧' },
  { href: '/deliveries', label: '納品・手数料の一覧' }
];

/**
 * The screens a role can open (its menu, plus — for the operators — the read-only lists
 * that left the menu). A link to any other screen is replaced by 発注の一覧.
 */
export function openableHrefsForRole(role: string | null | undefined): string[] {
  const menu = navHrefsForRole(role);
  const effective = navRole(role);
  return effective === 'admin' || effective === 'staff' ? [...menu, ...READ_ONLY_LISTS.map((list) => list.href)] : menu;
}

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
  if (navRole(role) === 'auditor') return '監査のため、閲覧のみです。金額・単価とファイルの中身は表示しません。';
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
    doHere: 'フィルム発注とセブン化学発注書の一覧です（閲覧用）。記録・状態の変更・保留や取消は、各行の「発注の画面」で行います。新しい発注は「新しいフィルム発注を登録する」から。',
    next: null
  },
  '/documents': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: 'この案件の書類（発注書・校正ゲラ・各種証跡）の一覧です（閲覧用）。書類の登録と確認は発注の画面の各手順で行います。',
    next: null
  },
  '/approvals': {
    step: 2,
    phase: 'デザイン・校正',
    doHere: 'デザインごとの顧客・セブン化学の承認の状況と記録の一覧です（閲覧用）。承認の記録と証跡の確認は発注の画面の手順6で行います。',
    next: null
  },
  '/maker-po': {
    step: 3,
    phase: 'メーカー発注',
    doHere: 'メーカー発注書の作成・代表承認・送信・受入の状況と履歴の一覧です（閲覧用）。記録は発注の画面の手順7〜10で行います。',
    next: null
  },
  [MAKERS_PATH]: {
    step: 3,
    phase: 'メーカー発注',
    doHere: 'メーカーと、メーカー発注書の送信先メールアドレスを登録します。既定の宛先は発注書の作成時に最初から選ばれます（代表者のみ）。',
    next: { href: '/maker-po', label: 'メーカー発注', text: '宛先を登録したら、メーカー発注書の作成で宛先を選べます。' }
  },
  [EVIDENCE_PATH]: {
    step: null,
    phase: '証跡',
    doHere: 'この案件の証跡ファイルの記録（種類・ファイル名・SHA-256・登録者と日時・確認の状態）を新しい順に見ます。ファイルの中身はこの画面では開きません。',
    next: null
  },
  '/deliveries': {
    step: 4,
    phase: '納品・手数料',
    doHere: '納品と手数料準備の状態の一覧です（閲覧用）。フィルムの納品の記録と確認は発注の画面の手順12で行います。',
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
