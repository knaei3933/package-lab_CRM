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
const OPERATORS: readonly NavRole[] = ['admin', 'staff'];
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
    key: 'intake',
    step: 1,
    title: '受付・発注',
    items: [{ href: '/orders', label: '発注の一覧', ko: '발주 목록', roles: READERS }]
  },
  {
    key: 'artwork',
    step: 2,
    title: 'デザイン・校正',
    items: [
      { href: '/documents', label: '文書', ko: '서류', roles: OPERATORS },
      { href: '/approvals', label: '承認（校了）', ko: '승인(교정 확정)', roles: OPERATORS },
      // P4 H10②: the auditor reads the approval history (the API allows artwork_approval:read); no forms there.
      { href: '/approvals', label: '承認（閲覧）', ko: '승인(열람)', roles: ['auditor'] }
    ]
  },
  {
    key: 'maker',
    step: 3,
    title: 'メーカー発注',
    items: [
      { href: '/maker-po', label: 'メーカー発注', ko: '제조사 발주', roles: READERS },
      { href: MAKERS_PATH, label: 'メーカーの宛先', ko: '제조사 수신처', roles: ['admin'] }
    ]
  },
  {
    key: 'delivery',
    step: 4,
    title: '納品・手数料',
    items: [{ href: '/deliveries', label: '納品確認・手数料準備', ko: '납품 확인·수수료 준비', roles: ALL }]
  },
  {
    key: 'evidence',
    step: null,
    title: '証跡',
    items: [{ href: EVIDENCE_PATH, label: '証跡の一覧', ko: '증빙 목록', roles: ['admin', 'staff', 'auditor'] }]
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
    doHere: 'セブン化学発注書を登録し、本登録日と発注書の照合チェックを記録してから、フィルム発注を作成して状態を進めます（「製造中」「出荷済み」への変更もこの画面です）。',
    next: { href: '/documents', label: '文書', text: '「発注書の照合済み」になったら、文書画面でデザイン入稿データを登録します。' }
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
    next: { href: '/maker-po', label: 'メーカー発注', text: '両組織の承認がそろって「校了（顧客・セブン化学）」になると、発注は自動で「メーカー発注準備完了」に進みます。メーカー発注画面へ。' }
  },
  '/maker-po': {
    step: 3,
    phase: 'メーカー発注',
    doHere: 'メーカー発注書の作成（担当者・代表者）→ 代表承認（代表者）→ 送信済みメールの原本（EML）で送信を記録 → 受入（仮）と最終受入、の順に進めます。',
    next: { href: '/orders', label: '案件（発注）', text: '最終受入が済んだら、発注画面で「製造中」「出荷済み」へ進めます。' }
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
