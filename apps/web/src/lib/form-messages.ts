/**
 * UI batch C (1-①): reading the server actions' messages on the client.
 *
 * The messages themselves stay verbatim in app/actions.ts and
 * app/maker-po/actions.ts (they are part of the action contract). This module
 * only (a) names the form field a refusal is about, so the form can mark and
 * focus it, and (b) adjusts the wording shown on screen where the original
 * leaks an internal code or an outdated screen name. Pure and client-safe: no
 * server imports (lib/maker-po-data and @kanei/core stay out of the bundle;
 * the two label maps below are mirrored and pinned equal by
 * tests/web-ui-batch-c-forms.test.tsx).
 */

/** P0 R01 (B1): the server actions' refusal when no 支払条件 was chosen (no default any more). */
export const PAYMENT_TERMS_REQUIRED_MESSAGE = '支払条件を選んでください（決まっていない場合は「未定」を選びます）。';

/** P0 R10 (H5): the maker PO's recipient must be an e-mail address (checked before the paper is frozen). */
export const RECIPIENT_EMAIL_INVALID_MESSAGE = 'メーカーの送信先メールアドレスの形（例 order@maker.example）で入力してください。郵便の住所ではありません。';

/** P0 R02: the shared-evidence exception needs its reason (mapped to the reason field). */
export const SHARED_EVIDENCE_REASON_MESSAGE = '両組織で同じ承認証跡を使う理由を入力してください。';

/**
 * P0 review M1: the approval is held when the 支払条件 the screen shows could not
 * be read — the approval must certify the term the representative saw.
 */
export const EXPECTED_TERMS_MISSING_MESSAGE =
  '支払条件を確認できないため、代表承認を保留しています。画面を再読み込みして支払条件が表示されてから承認してください。';

/** P0 review M2: PAYMENT_TERMS_LOCKED by its reason (the server rule, not 「下書きの間だけ」). */
export const PAYMENT_TERMS_LOCKED_MESSAGES: Readonly<Record<string, string>> = {
  ceo_approved: '代表承認済みのメーカー発注書があるため、支払条件は変更できません。変更する場合は、メーカー発注書を取り消して作り直してください。',
  order_frozen: '保留・変更レビュー・取消レビュー中の発注は、支払条件を変更できません。状態を解決してから変更してください。'
};

export type MessageMatch = 'exact' | 'prefix' | 'suffix';

export interface ActionMessageField {
  /** The message text as written in the action source (or its fixed part). */
  message: string;
  /** exact: whole message; prefix / suffix: the fixed part of a template or a long message. */
  match: MessageMatch;
  /**
   * The form field name the message is about. Controls without a submitted
   * name (line rows, file pickers, the split date inputs) carry the same key
   * in data-feedback-name.
   */
  field: string;
  source: 'actions' | 'maker-po-actions';
}

/** Pseudo field names for controls that are not posted under a name. */
export const FILE_FIELD = 'file';
export const lineField = (index: number, part: 'description' | 'quantity' | 'unit'): string => `lines.${index}.${part}`;

/**
 * Every field-specific refusal of the two action files. Messages about a
 * hidden id (e.g. 「メーカー発注書が選択されていません。」) or about the whole form
 * are deliberately absent: there is no field the operator could fix.
 */
export const ACTION_MESSAGE_FIELDS: readonly ActionMessageField[] = [
  // app/actions.ts
  { message: '案件を選択するか、案件IDを入力してください。', match: 'exact', field: 'projectId', source: 'actions' },
  { message: '発注番号を入力してください。', match: 'exact', field: 'poNumber', source: 'actions' },
  { message: '公式登録日を入力してください。', match: 'exact', field: 'officialRegisteredAt', source: 'actions' },
  { message: '発注コードを入力してください。', match: 'exact', field: 'code', source: 'actions' },
  // UI batch E (F-05, F-07): the PO link a film order and an official artifact need.
  { message: 'セブン化学発注書を選択してください。', match: 'exact', field: 'sevenPurchaseOrderId', source: 'actions' },
  {
    message: 'セブン化学発注書を選択してください（校正ゲラ・各種証跡では必須です）。',
    match: 'exact',
    field: 'sevenPurchaseOrderId',
    source: 'actions'
  },
  { message: 'の明細を1行以上入力してください。', match: 'suffix', field: lineField(0, 'description'), source: 'actions' },
  { message: 'の明細の説明が入力されていません。', match: 'suffix', field: lineField(0, 'description'), source: 'actions' },
  { message: 'の明細の数量は正の数で入力してください。', match: 'suffix', field: lineField(0, 'quantity'), source: 'actions' },
  { message: 'の明細の単位が正しくありません。', match: 'suffix', field: lineField(0, 'unit'), source: 'actions' },
  // UI batch E2: the API's DELIVERY_UNIT_MISMATCH (db4bd88), read back in Japanese by recordDeliveryAction.
  { message: '単位を明細と同じ単位に直して、もう一度記録してください。', match: 'suffix', field: 'unit', source: 'actions' },
  { message: PAYMENT_TERMS_REQUIRED_MESSAGE, match: 'exact', field: 'paymentTerms', source: 'actions' },
  { message: SHARED_EVIDENCE_REASON_MESSAGE, match: 'exact', field: 'sharedEvidenceReason', source: 'actions' },
  { message: '検証結果（確認／却下）を選択してください。', match: 'exact', field: 'result', source: 'actions' },
  {
    message: '根拠を入力してください（原本証跡のどこで識別子を確認したか）。',
    match: 'exact',
    field: 'reasonNote',
    source: 'actions'
  },
  { message: '遷移先の状態を選択してください。', match: 'exact', field: 'to', source: 'actions' },
  // Recheck 7 Low-7 (d): the hold reason sits in a folded section; the refusal opens and focuses it.
  { message: '保留にする理由は必須です。', match: 'exact', field: 'holdReason', source: 'actions' },
  { message: '保留にする理由は1000字以内で入力してください。', match: 'exact', field: 'holdReason', source: 'actions' },
  { message: '受領確認のメモは必須です。', match: 'exact', field: 'note', source: 'actions' },
  {
    message: '「証跡なしで問題なしとみなす」の確認にチェックを入れてください。',
    match: 'exact',
    field: 'acknowledgeNoEvidence',
    source: 'actions'
  },
  { message: 'ファイル名を入力してください。', match: 'exact', field: 'filename', source: 'actions' },
  { message: 'ファイルを選択してください。', match: 'exact', field: FILE_FIELD, source: 'actions' },
  { message: '検証結果（確認済み／相違あり）を選択してください。', match: 'exact', field: 'verificationStatus', source: 'actions' },
  { message: 'フィルム発注を選択してください。', match: 'exact', field: 'orderId', source: 'actions' },
  { message: 'デザインキーを入力してください。', match: 'exact', field: 'designKey', source: 'actions' },
  {
    message: '版ファイル（校正ゲラのバージョン）を選択してください。',
    match: 'exact',
    field: 'fileDocumentVersionId',
    source: 'actions'
  },
  // UI batch F: the controlled change request of the revision form (server R1-9 / F2).
  {
    message: 'このデザインには承認の記録があるため、変更依頼として登録する必要があります。',
    match: 'prefix',
    field: 'changeRequest',
    source: 'actions'
  },
  { message: '変更を依頼した組織（顧客／セブン化学）を選んでください。', match: 'exact', field: 'changeRequestedOrganization', source: 'actions' },
  { message: '変更理由を入力してください。', match: 'exact', field: 'changeReason', source: 'actions' },
  {
    message: '変更依頼の証憑（承認証跡の書類バージョン）を選択してください。',
    match: 'exact',
    field: 'changeEvidenceDocumentVersionId',
    source: 'actions'
  },
  {
    message: '変更依頼の証憑は、この発注（デザインを指定した証跡はそのデザイン）に紐付けた承認証跡から選んでください。',
    match: 'exact',
    field: 'changeEvidenceDocumentVersionId',
    source: 'actions'
  },
  { message: '納期への影響を入力してください（影響がなければ「なし」）。', match: 'exact', field: 'impactSchedule', source: 'actions' },
  { message: '影響数量を入力してください（影響がなければ0）。', match: 'exact', field: 'impactQuantity', source: 'actions' },
  { message: '影響数量は0以上の数で、小数点以下3桁まで入力してください。', match: 'exact', field: 'impactQuantity', source: 'actions' },
  { message: '影響数量が上限（99,999,999,999.999）を超えています。', match: 'exact', field: 'impactQuantity', source: 'actions' },
  { message: '影響金額を入力してください（影響がなければ0、減額はマイナス）。', match: 'exact', field: 'impactAmount', source: 'actions' },
  {
    message: '影響金額は数で、小数点以下2桁まで入力してください（減額はマイナス）。',
    match: 'exact',
    field: 'impactAmount',
    source: 'actions'
  },
  { message: '影響金額が上限（±999,999,999,999.99）を超えています。', match: 'exact', field: 'impactAmount', source: 'actions' },
  { message: '実費を入力してください（実費がなければ0）。', match: 'exact', field: 'actualCost', source: 'actions' },
  { message: '実費は0以上の数で、小数点以下2桁まで入力してください。', match: 'exact', field: 'actualCost', source: 'actions' },
  { message: '実費が上限（999,999,999,999.99）を超えています。', match: 'exact', field: 'actualCost', source: 'actions' },
  {
    message: 'ロット表記を入力してください（変更依頼では新しいロット表示が必須です）。',
    match: 'exact',
    field: 'lotMarking',
    source: 'actions'
  },
  { message: '承認証跡の書類バージョンを選択してください。', match: 'exact', field: 'evidenceDocumentVersionId', source: 'actions' },
  {
    message: '承認証跡識別子を8文字以上で入力してください（例：メールのMessage-ID）。',
    match: 'exact',
    field: 'evidenceIdentifier',
    source: 'actions'
  },
  { message: '証跡の入手経路を選択してください。', match: 'exact', field: 'evidenceSource', source: 'actions' },
  { message: '承認日時を入力してください。', match: 'exact', field: 'eventTime', source: 'actions' },
  { message: '発注を選択してください。', match: 'exact', field: 'orderId', source: 'actions' },
  { message: '納品する明細を選択してください。', match: 'exact', field: 'lineId', source: 'actions' },
  { message: '納品数量は正の数で入力してください。', match: 'exact', field: 'deliveredQuantity', source: 'actions' },
  {
    message: '確認に使う受領証跡（確認済みの書類バージョン）を選択してください。',
    match: 'exact',
    field: 'evidenceDocumentVersionId',
    source: 'actions'
  },
  // app/maker-po/actions.ts
  { message: 'フィルム発注を選択してください。', match: 'exact', field: 'orderId', source: 'maker-po-actions' },
  { message: RECIPIENT_EMAIL_INVALID_MESSAGE, match: 'exact', field: 'recipientAddress', source: 'maker-po-actions' },
  {
    message: 'メーカーの送信先メールアドレスを入力してください。',
    match: 'exact',
    field: 'recipientAddress',
    source: 'maker-po-actions'
  },
  {
    message: PAYMENT_TERMS_REQUIRED_MESSAGE,
    match: 'exact',
    field: 'paymentTerms',
    source: 'maker-po-actions'
  },
  { message: '送信証跡がありません。', match: 'prefix', field: FILE_FIELD, source: 'maker-po-actions' },
  { message: '送信元アドレスを入力してください。', match: 'exact', field: 'senderAddress', source: 'maker-po-actions' },
  { message: '宛先アドレスを1件以上入力してください。', match: 'exact', field: 'recipients', source: 'maker-po-actions' },
  { message: '送信日時を入力してください。', match: 'exact', field: 'sentAt', source: 'maker-po-actions' },
  { message: '確認結果（confirmed／rejected）を選択してください。', match: 'exact', field: 'result', source: 'maker-po-actions' },
  { message: '根拠（reasonNote）を入力してください。', match: 'prefix', field: 'reasonNote', source: 'maker-po-actions' },
  { message: '取消理由（note）は必須です。', match: 'prefix', field: 'note', source: 'maker-po-actions' },
  { message: '承認理由（note）は必須です。', match: 'prefix', field: 'note', source: 'maker-po-actions' },
  {
    message: '受領証跡（acceptance_evidence）の書類バージョンを選択してください。',
    match: 'exact',
    field: 'evidenceDocumentVersionId',
    source: 'maker-po-actions'
  }
];

function matches(entry: ActionMessageField, message: string): boolean {
  if (entry.match === 'exact') return message === entry.message;
  if (entry.match === 'prefix') return message.startsWith(entry.message);
  return message.endsWith(entry.message);
}

/** The field a server action's refusal is about, or null (API refusals, hidden ids, whole-form messages). */
export function fieldForActionMessage(message: string): string | null {
  const text = message.trim();
  return ACTION_MESSAGE_FIELDS.find((entry) => matches(entry, text))?.field ?? null;
}

export type ActionFieldResolution =
  | { kind: 'none' }
  | { kind: 'clear' }
  | { kind: 'field'; field: string; message: string };

/**
 * What a new action result does to the field errors: a success clears them; a
 * refusal about a field the form actually shows marks that field (with the
 * display wording) and the shell focuses it; anything else leaves them alone
 * (the result line still shows the message).
 */
export function resolveActionFieldError(
  state: { ok: boolean; message: string } | null,
  hasField: (field: string) => boolean
): ActionFieldResolution {
  if (!state) return { kind: 'none' };
  if (state.ok) return { kind: 'clear' };
  const field = fieldForActionMessage(state.message);
  if (!field || !hasField(field)) return { kind: 'none' };
  return { kind: 'field', field, message: displayActionMessage(state.message) };
}

/** Mirror of lib/maker-po-data PAYMENT_TERMS_LABELS (pinned equal by test). P0 R01: P-10 glossary words. */
export const PAYMENT_TERMS_DISPLAY: Readonly<Record<string, string>> = {
  prepaid: '前払い',
  on_delivery: '納品後払い',
  undetermined: '未定'
};

/** Mirror of @kanei/core COMMISSION_READINESS_STATE_LABELS (pinned equal by test). */
export const READINESS_STATE_DISPLAY: Readonly<Record<string, string>> = {
  MISSING_DATA: 'データ不足',
  PENDING_VERIFICATION: '納品証跡確認待ち',
  READY: '手数料計算可能'
};

const NO_PROJECT_ORIGINAL = '案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。';
const NO_PROJECT_DISPLAY = '案件が選択されていません。画面上部の「案件」から案件を選んでください。';

/** Internal field / document-type codes in parentheses that the operator never sees elsewhere. */
const INTERNAL_CODE_SUFFIXES = ['（verifierName）', '（verifiedAt）', '（reasonNote）', '（note）', '（acceptance_evidence）', '（send_evidence）'];

/**
 * The wording shown for a server action's message. Unknown messages (the
 * API's own refusals included) pass through unchanged.
 */
export function displayActionMessage(message: string): string {
  if (message === NO_PROJECT_ORIGINAL) return NO_PROJECT_DISPLAY;
  let text = message
    .replace(/^(?:決済|支払)条件を記録しました（([a-z_]+)）。/, (whole, code: string) => {
      const label = PAYMENT_TERMS_DISPLAY[code];
      return label ? `支払条件を記録しました（${label}）。` : whole;
    })
    .replace(/^準備状態：([A-Z_]+)（/, (whole, code: string) => {
      const label = READINESS_STATE_DISPLAY[code];
      return label ? `準備状態：${label}（` : whole;
    })
    .replace(
      '（prepaid／on_delivery／undetermined）',
      `（${PAYMENT_TERMS_DISPLAY.prepaid}／${PAYMENT_TERMS_DISPLAY.on_delivery}／${PAYMENT_TERMS_DISPLAY.undetermined}）`
    )
    .replace('（confirmed／rejected）', '（確認／却下）')
    .replace('何を確認して納品を断定したか', '何を確認して送信を確定したか');
  for (const suffix of INTERNAL_CODE_SUFFIXES) text = text.replaceAll(suffix, '');
  return text;
}
