import { datetimeLocalToIso } from './datetime';
import { formatJstWithWeekday } from './date-input';

/**
 * UI batch C (1-③, review M4): the confirm dialog's rows and texts, without
 * the DOM. The form shell turns each named control into a SummaryControl and
 * these functions decide what the operator reads back before the record is
 * filed, so the tests can check the wording on plain objects.
 */

export interface SummaryRow {
  label: string;
  value: string;
}

/** A dialog built for one held submit (the same shape the shell's ConfirmResolver returns). */
export interface ConfirmSpec {
  options: { title: string; body: string };
  confirmLabel: string;
  summary: SummaryRow[];
}

export const EMPTY_SUMMARY_VALUE = '（未入力）';

/** One named form control, reduced to what its summary row shows. */
export type SummaryControl =
  | { kind: 'missing' }
  /** Several controls under one name (radio group): the checked one, if any. */
  | { kind: 'group'; checked: { type: string; value: string; labelText: string | null } | null }
  | { kind: 'select'; value: string; selectedText: string }
  | { kind: 'checkbox'; checked: boolean }
  | { kind: 'text'; value: string };

/** UI batch E (F-18): list a summary field only while `field` holds one of `values`. */
export interface SummaryCondition {
  field: string;
  values: string[];
}

/**
 * The summary fields a dialog lists for the current form values: a field with
 * a condition is dropped unless the named control holds one of its values
 * (「保留にする理由」 only when 「保留中」 is the chosen target).
 */
export function summaryFieldsFor(
  fields: readonly string[],
  when: Readonly<Record<string, SummaryCondition>> | undefined,
  valueOf: (name: string) => string
): string[] {
  if (!when) return [...fields];
  return fields.filter((name) => {
    const condition = when[name];
    return condition === undefined || condition.values.includes(valueOf(condition.field));
  });
}

const EXPLICIT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The value text of one row: select → the option text, checkbox → はい／いいえ,
 * radio → the checked option's label, an explicit-offset instant (the hidden
 * OffsetDateTimeField value) → 「日本時間 2026/11/18（水）14:30」, other text →
 * as typed; nothing chosen or typed → （未入力）.
 */
export function summaryValueText(control: SummaryControl): string {
  switch (control.kind) {
    case 'missing':
      return EMPTY_SUMMARY_VALUE;
    case 'group': {
      const checked = control.checked;
      if (!checked) return EMPTY_SUMMARY_VALUE;
      if (checked.type !== 'radio') return checked.value || EMPTY_SUMMARY_VALUE;
      return checked.labelText?.trim() || checked.value;
    }
    case 'select': {
      const text = control.selectedText.trim();
      return control.value.length > 0 && text.length > 0 ? text : EMPTY_SUMMARY_VALUE;
    }
    case 'checkbox':
      return control.checked ? 'はい' : 'いいえ';
    case 'text': {
      const value = control.value.trim();
      if (value.length === 0) return EMPTY_SUMMARY_VALUE;
      if (EXPLICIT_INSTANT.test(value)) {
        const jst = formatJstWithWeekday(value);
        if (jst) return `日本時間 ${jst}`;
      }
      return value;
    }
  }
}

const ORGANIZATION_LABELS: Readonly<Record<string, string>> = { customer: '顧客', seven: 'セブン化学' };

/** ApprovalDecisionForm: the organization comes from the pressed button, evidence and time from the fields. */
export function approvalConfirmSpec(
  organization: string,
  evidence: string | undefined,
  eventTime: string | undefined
): ConfirmSpec {
  const orgLabel = ORGANIZATION_LABELS[organization] ?? '';
  return {
    options: {
      title: `${orgLabel}の承認を記録しますか？`,
      body: `選んだ承認証跡を根拠に、${orgLabel}の承認を記録します。記録は履歴に残ります。もう一方の組織の承認もそろうと校了になります。`
    },
    confirmLabel: `${orgLabel}として承認する`,
    summary: [
      { label: '承認組織', value: orgLabel || '（不明）' },
      { label: '承認証跡', value: evidence ?? '（未選択）' },
      { label: '承認日時', value: eventTime ?? EMPTY_SUMMARY_VALUE }
    ]
  };
}

export const MAKER_PO_SEND_SUBMIT_LABEL = '送信を記録する';
export const MAKER_PO_SEND_CONFIRM_TITLE = '送信を記録しますか？';

/**
 * MakerPoSendEvidenceForm: what will be recorded. The EML row names the file
 * only while its bytes are actually held for the submit; otherwise the cited
 * document version, otherwise （未選択）.
 */
export function makerPoSendConfirmSpec(input: {
  senderAddress: string;
  recipients: string;
  /** datetime-local wall clock in the browser zone (the form state). */
  sentAtLocal: string;
  emlFilename: string;
  hasEmlContent: boolean;
  /** The selected send-evidence version's option text, '' when none. */
  versionText: string;
}): ConfirmSpec {
  const iso = datetimeLocalToIso(input.sentAtLocal);
  const jst = iso ? formatJstWithWeekday(iso) : null;
  const evidence = input.hasEmlContent && input.emlFilename
    ? `EMLファイル ${input.emlFilename}`
    : input.versionText
      ? `書類 ${input.versionText}`
      : '（未選択）';
  return {
    options: {
      title: MAKER_PO_SEND_CONFIRM_TITLE,
      body: '送信証跡のEMLを検証し、この発注書の送信として記録します。記録は履歴に残り、あとから削除できません。'
    },
    confirmLabel: MAKER_PO_SEND_SUBMIT_LABEL,
    summary: [
      { label: '送信元', value: input.senderAddress.trim() || EMPTY_SUMMARY_VALUE },
      { label: '宛先', value: input.recipients.trim() || EMPTY_SUMMARY_VALUE },
      { label: '送信日時', value: jst ? `日本時間 ${jst}` : EMPTY_SUMMARY_VALUE },
      { label: '送信証跡', value: evidence }
    ]
  };
}

export const DELIVERY_RECORD_SUBMIT_LABEL = '納品を記録する';
export const DELIVERY_RECORD_CONFIRM_TITLE = '納品を記録しますか？';
export const DELIVERY_RECORD_CONFIRM_BODY =
  'この内容で納品を1件記録します。納品日を入力しなかった場合は、記録した時点の現在日時が納品日になります。記録した納品を削除する操作はありません。';
/** The 納品日 row when the field was left empty: the API records the moment of recording (review M3). */
export const DELIVERED_AT_NOW_VALUE = '未入力（記録した時点の現在日時で記録します）';

/**
 * DeliveryRecordForm (review M3): the rows the shell read from the fields
 * (発注・明細・数量・単位) plus the 納品日 row, which says outright that an
 * empty date becomes the recording time instead of showing （未入力）.
 */
export function deliveryRecordConfirmSpec(rows: readonly SummaryRow[], deliveredAt: string): ConfirmSpec {
  return {
    options: { title: DELIVERY_RECORD_CONFIRM_TITLE, body: DELIVERY_RECORD_CONFIRM_BODY },
    confirmLabel: DELIVERY_RECORD_SUBMIT_LABEL,
    summary: [
      ...rows,
      { label: '納品日', value: deliveredAt === EMPTY_SUMMARY_VALUE || deliveredAt.trim() === '' ? DELIVERED_AT_NOW_VALUE : deliveredAt }
    ]
  };
}
