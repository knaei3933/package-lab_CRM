/**
 * P1 R28 (REDESIGN §9, policy P-10 standard approved): the one wording of the
 * product. State labels, menus and the error dictionary all follow this table;
 * the Korean gloss (R29) comes from the same row, so a term can no longer split
 * between screens (M16). The API keeps its stored keys; only what a screen says
 * changes. An unknown key falls back to the API's own label (never an enum).
 * Client-safe and pure.
 */
export interface Term {
  ja: string;
  ko: string;
}

export type TermSurface =
  | 'filmSupplyOrderStates'
  | 'makerPurchaseOrderStatuses'
  | 'commissionReadinessStates'
  | 'fillingDeliveryConfirmationStates'
  | 'approvalOrganizations';

export const STANDARD_LABELS: Readonly<Record<TermSurface, Readonly<Record<string, Term>>>> = {
  filmSupplyOrderStates: {
    DRAFT: { ja: '下書き', ko: '초안' },
    SEVEN_PO_VERIFIED: { ja: '発注書の照合済み', ko: '발주서 대조 완료' },
    ARTWORK_RECEIVED: { ja: 'デザイン受領', ko: '디자인 수령' },
    PROOF_READY: { ja: '校正準備完了', ko: '교정본 준비 완료' },
    APPROVAL_PENDING: { ja: '校了確認待ち', ko: '교정 확정 대기' },
    DUAL_APPROVED: { ja: '校了', ko: '교정 확정' },
    MAKER_PO_READY: { ja: 'メーカー発注準備完了', ko: '제조사 발주 준비 완료' },
    APPROVED_FOR_MANUAL_SEND: { ja: 'メーカーへの送信待ち', ko: '제조사 발송 대기' },
    MAKER_PO_SENT_MANUALLY: { ja: 'メーカーへ送信済み', ko: '제조사 발송 완료' },
    MAKER_PO_ACCEPTED: { ja: 'メーカー受注確認済み', ko: '제조사 접수 확인' },
    FILM_IN_PRODUCTION: { ja: '製造中', ko: '생산 중' },
    FILM_SHIPPED: { ja: '出荷済み', ko: '출하 완료' },
    FILM_DELIVERED: { ja: '納品済み', ko: '납품 완료' },
    FILM_RECEIPT_ASSUMED_NO_ISSUE: { ja: '問題なしで完了', ko: '이상 없음 완료' },
    ON_HOLD: { ja: '保留中', ko: '보류 중' },
    CHANGE_REVIEW: { ja: '変更確認中', ko: '변경 검토 중' },
    CANCELLATION_REVIEW: { ja: '取消確認中', ko: '취소 검토 중' },
    CANCELLED: { ja: '取消済', ko: '취소됨' }
  },
  makerPurchaseOrderStatuses: {
    DRAFT: { ja: '代表承認待ち', ko: '대표 승인 대기' },
    APPROVED_FOR_MANUAL_SEND: { ja: 'メーカーへの送信待ち', ko: '제조사 발송 대기' },
    SEND_UNVERIFIED: { ja: '送信未確認（要対応）', ko: '발송 미확인(조치 필요)' },
    MAKER_PO_SENT_MANUALLY: { ja: '送信済み（受注確認待ち）', ko: '발송 완료(접수 확인 대기)' },
    MAKER_PO_ACCEPTED: { ja: 'メーカー受注確認済み', ko: '제조사 접수 확인' },
    SNAPSHOT_VOIDED: { ja: '発注書無効（再承認待ち）', ko: '발주서 무효(재승인 대기)' },
    CANCELLED: { ja: '取消済（作り直し待ち）', ko: '취소됨(재작성 대기)' }
  },
  commissionReadinessStates: {
    MISSING_DATA: { ja: 'データ不足', ko: '데이터 부족' },
    PENDING_VERIFICATION: { ja: '納品確認待ち', ko: '납품 확인 대기' },
    READY: { ja: '手数料計算の準備完了', ko: '수수료 계산 준비 완료' }
  },
  fillingDeliveryConfirmationStates: {
    PENDING_CONFIRMATION: { ja: '充填製品の納品確認待ち', ko: '충전 제품 납품 확인 대기' },
    CONFIRMED: { ja: '充填製品の納品確認済み', ko: '충전 제품 납품 확인 완료' }
  },
  approvalOrganizations: {
    customer: { ja: '顧客の承認', ko: '고객 승인' },
    seven: { ja: 'セブン化学の承認', ko: '세븐화학 승인' }
  }
};

/** The standard term of a key, or null when the table has none (the caller falls back). */
export function standardTerm(surface: TermSurface, key: string): Term | null {
  return STANDARD_LABELS[surface][key] ?? null;
}

/**
 * The legacy words the product used before §9 → the standard word. Applied once
 * to the screen copy (the source), and kept here so a test can prove no screen
 * text uses a legacy word any more.
 */
export const LEGACY_TERMS: ReadonlyArray<readonly [string, string]> = [
  ['真性行チェックリスト', '発注書の照合チェック'],
  ['公式登録', '本登録'],
  ['決済条件（G6）', '支払条件'],
  ['決済条件', '支払条件'],
  ['キャンセルレビュー', '取消確認'],
  ['取消レビュー', '取消確認'],
  ['キャンセル終了', '取消済'],
  ['変更レビュー', '変更確認'],
  ['製造先', 'メーカー'],
  ['フィルム製造中', '製造中'],
  ['フィルム発送済み', '出荷済み'],
  ['フィルム納品完了', '納品済み']
];

/** Menu and screen names (REDESIGN §2-3, §9) with their Korean gloss. */
export const MENU_TERMS: Readonly<Record<string, Term>> = {
  '/home:admin': { ja: '承認箱', ko: '승인함' },
  '/home:staff': { ja: '自分の作業', ko: '내 작업' },
  '/home:viewer': { ja: '履歴', ko: '이력' },
  '/home:auditor': { ja: '監査履歴', ko: '감사 이력' },
  '/makers': { ja: '製造先の宛先', ko: '제조처 수신처' },
  '/evidence': { ja: '証跡の一覧', ko: '증빙 목록' },
  '/dashboard': { ja: 'ダッシュボード', ko: '대시보드(안건 선택)' },
  '/orders': { ja: '発注の一覧', ko: '발주 목록' },
  '/documents': { ja: '書類', ko: '서류' },
  '/approvals': { ja: '校了の承認', ko: '교정 확정 승인' },
  '/maker-po': { ja: 'メーカー発注書', ko: '제조사 발주서' },
  '/deliveries': { ja: '納品確認・手数料計算の準備', ko: '납품 확인·수수료 계산 준비' },
  '/guide': { ja: '使い方ガイド', ko: '사용 안내' },
  '/status': { ja: '状態の一覧', ko: '상태 목록' },
  '/settings': { ja: '表示言語', ko: '표시 언어' }
};
