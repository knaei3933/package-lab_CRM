'use client';

import { useEffect, useRef, useState } from 'react';
import { changeRequestKey } from '../lib/change-request-key';
import { noteStyle } from '../lib/ui';
import { CheckboxField, SelectField, TextareaField, TextField } from './fields';

/** Mirror of lib/change-request ChangeEvidenceChoice (type only; that module is server-side). */
export interface ChangeEvidenceChoiceProps {
  value: string;
  label: string;
  orderId: string;
  designKey: string | null;
}

/** 依頼組織: the API's ApprovalOrganization values (customer / seven). */
const ORGANIZATION_CHOICES = [
  { value: 'customer', label: '顧客' },
  { value: 'seven', label: 'セブン化学' }
];

/**
 * UI batch F (server R1-9 / F2, representative Q-A4): the controlled change
 * request of the revision form. A new revision of a design that already has
 * approval history (any APPROVE or REVOKE, server-batch-f4 M-6) invalidates
 * those approvals, and the API then requires the
 * change facts: 依頼組織・変更理由・証憑・納期／数量／金額への影響・実費 (zero
 * stated explicitly) and the new lot marking. The fields open — and become
 * required — when the order and design typed above have approval history on
 * this screen, or when the operator opens them by hand; the API decides either
 * way (a refusal names the change section). A printed order (FILM_IN_PRODUCTION
 * or later) says that only the representative can record the change.
 *
 * Reads the order select and design input of the surrounding form, so the
 * other fields stay the shared uncontrolled ones of the page.
 */
export function ChangeRequestFields({
  historyKeys,
  printedOrderIds,
  evidenceChoices,
  canRecordPrinted
}: {
  historyKeys: readonly string[];
  printedOrderIds: readonly string[];
  evidenceChoices: readonly ChangeEvidenceChoiceProps[];
  /** The role may record a change after printing started (representative). */
  canRecordPrinted: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [orderId, setOrderId] = useState('');
  const [designKey, setDesignKey] = useState('');
  const [manual, setManual] = useState(false);

  const required = orderId !== '' && designKey.trim() !== '' && historyKeys.includes(changeRequestKey(orderId, designKey));
  const open = required || manual;
  const printed = printedOrderIds.includes(orderId);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return undefined;
    const read = () => {
      const order = form.elements.namedItem('orderId');
      const design = form.elements.namedItem('designKey');
      const toggle = form.elements.namedItem('changeRequest');
      setOrderId(order instanceof HTMLSelectElement ? order.value : '');
      setDesignKey(design instanceof HTMLInputElement ? design.value : '');
      setManual(toggle instanceof HTMLInputElement && toggle.type === 'checkbox' ? toggle.checked : false);
    };
    // After a successful submit the form resets: read the blank values again.
    const onReset = () => window.setTimeout(read, 0);
    read();
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    form.addEventListener('reset', onReset);
    return () => {
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
      form.removeEventListener('reset', onReset);
    };
  }, []);

  // The new lot marking is part of the change facts: the shared field above becomes required.
  useEffect(() => {
    const form = anchor.current?.closest('form');
    const lot = form?.elements.namedItem('lotMarking');
    if (lot instanceof HTMLInputElement) lot.required = open;
  }, [open]);

  const evidence = evidenceChoices
    .filter((choice) => choice.orderId === orderId && (choice.designKey === null || choice.designKey === designKey.trim()))
    .map(({ value, label }) => ({ value, label }));

  return (
    <div ref={anchor} style={{ flexBasis: '100%' }}>
      <fieldset style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', margin: 0 }}>
        <legend style={{ fontSize: 14, padding: '0 4px' }}>変更依頼（承認済みデザインの差し替え）</legend>
        {required ? (
          <>
            {/* Posted like the checkbox would be; the operator cannot opt out of what the API requires. */}
            <input type="hidden" readOnly name="changeRequest" value="on" />
            <p style={noteStyle}>
              このデザインには承認の記録（承認または取消）があるため、新しい版は変更依頼として登録されます（既存の承認は無効になります）。
              次の項目とロット表記はすべて必須です。
            </p>
          </>
        ) : (
          <CheckboxField
            name="changeRequest"
            label="変更依頼として登録する"
            hint="承認の記録（承認または取消）があるデザインに新しい版を登録するときは必須です。承認の記録がないデザインでは、入力しても記録されません。"
          />
        )}
        {open ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
            <SelectField
              name="changeRequestedOrganization"
              label="変更を依頼した組織"
              required
              includeBlank
              blankLabel="（選んでください）"
              width={200}
              choices={ORGANIZATION_CHOICES}
            />
            <TextareaField name="changeReason" label="変更理由" required rows={2} width={480} />
            <SelectField
              name="changeEvidenceDocumentVersionId"
              label="変更依頼の証憑（承認証跡の書類バージョン）"
              required
              includeBlank
              blankLabel={evidence.length === 0 ? '（この発注に紐付けた承認証跡がありません）' : '（選んでください）'}
              width={420}
              choices={evidence}
              hint="この発注（デザインを指定した証跡はそのデザイン）に紐付けた承認証跡から選びます。"
            />
            <TextField name="impactSchedule" label="納期への影響" required width={260} hint="影響がなければ「なし」と入力" />
            <TextField name="impactQuantity" label="影響数量（増減）" required width={180} hint="影響がなければ0（小数点以下3桁まで）" />
            <TextField name="impactAmount" label="影響金額（円・増減）" required width={200} hint="影響がなければ0、減額はマイナス（小数点以下2桁まで）" />
            <TextField name="actualCost" label="実費（円）" required width={180} hint="実費がなければ0（小数点以下2桁まで）" />
          </div>
        ) : null}
        <p style={noteStyle}>
          印刷開始（フィルム製造中）以降の変更は、代表者の承認と実費の記録が必須です。代表者が登録すると、その代表者が承認者として記録されます。
        </p>
        {printed && open ? (
          <p className="role-notice" role="note">
            {canRecordPrinted
              ? 'この発注は印刷開始後です。登録すると、あなた（代表者）が印刷開始後の変更を承認したものとして記録されます。実費は必ず入力してください（なければ0）。'
              : 'この発注は印刷開始後です。印刷開始後の変更は代表者だけが登録できます（担当者の登録は受け付けられません）。代表者に登録を依頼してください。'}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
