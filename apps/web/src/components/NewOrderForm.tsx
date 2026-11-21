'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import type { FormAction } from './ActionForm';
import { DraftAutosave } from './DraftAutosave';
import { CheckboxField, DateTextField, SelectField, TextareaField, TextField } from './fields';
import { FeedbackForm, FieldError, FieldFeedback, FormErrorSummary, FormResult, SubmitLock } from './form-feedback';
import { LineInputs, PAYMENT_TERMS_HINT, UNDECIDED_TERMS, UNDECIDED_TERMS_WARNING } from './OrderCreateForm';
import { StepFileField } from './StepFileField';
import { normalizeQuantityText } from '../lib/form-validation';
import { draftKey } from '../lib/unsaved-guard';
import type { Choice } from '../lib/types';

/**
 * P1 R21: steps 1–3 of a new film order on one form, sent once — 発注書の受付
 * (number, 本登録日, the PDF), 発注書の照合 (the 7 checks, next to each other)
 * and 発注内容 (code, lines with visible labels, 支払条件 with no default). The
 * server action records them in order (lib/step-chain) and opens the order's
 * own screen. A PO that is already verified can be chosen instead of a new one.
 * The draft is kept while typing (R34) — the lines too.
 */
interface LineRow {
  description: string;
  quantity: string;
  unit: string;
}

const QUOTE_MATCH_CHOICES = [
  { value: 'true', label: '見積と一致している' },
  { value: 'false', label: '見積と一致していない' }
];

const SUBMIT_LABEL = '発注を作成して照合済みにする';
const LINES_DRAFT = 'new-order-lines';

export function NewOrderForm({
  action,
  projectCode,
  unitChoices,
  paymentTermsChoices,
  existingPoChoices,
  unverifiedPoIds
}: {
  action: FormAction;
  projectCode: string;
  unitChoices: Choice[];
  paymentTermsChoices: Choice[];
  /** Registered セブン化学発注書 a new order can be added to. */
  existingPoChoices: Choice[];
  /** Those of them whose 照合 is not recorded yet (the checklist is asked for them). */
  unverifiedPoIds: string[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const firstUnit = unitChoices[0]?.value ?? '';
  const [lines, setLines] = useState<LineRow[]>([{ description: '', quantity: '', unit: firstUnit }]);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [existingPoId, setExistingPoId] = useState('');
  const warningId = useId();
  const needsChecklist = mode === 'new' || unverifiedPoIds.includes(existingPoId);

  // R34: the lines are React state, so their draft is kept here (the rest by DraftAutosave).
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(draftKey(window.location.pathname, LINES_DRAFT));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length > 0) setLines(parsed as LineRow[]);
    } catch {
      // No draft: start empty.
    }
  }, []);
  useEffect(() => {
    try {
      const key = draftKey(window.location.pathname, LINES_DRAFT);
      const empty = lines.every((line) => line.description === '' && line.quantity === '');
      if (empty) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, JSON.stringify(lines));
    } catch {
      // Storage blocked: no draft.
    }
  }, [lines]);

  const serialized = JSON.stringify(lines.map((line) => ({
    description: line.description,
    orderedQuantity: normalizeQuantityText(line.quantity),
    unit: line.unit
  })));

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      onReset={() => {
        setLines([{ description: '', quantity: '', unit: firstUnit }]);
        setPaymentTerms('');
      }}
      className="p1-wizard"
    >
      <DraftAutosave name="new-order" />
      <input type="hidden" readOnly name="projectCode" value={projectCode} />
      <input type="hidden" readOnly name="lines" value={serialized} />

      <fieldset className="p1-fieldset">
        <legend className="p1-legend"><span className="p1-legend-no">1</span>発注書の受付</legend>
        {existingPoChoices.length > 0 ? (
          <div className="p1-choice-row" role="radiogroup" aria-label="セブン化学発注書">
            <label className="p1-radio">
              <input type="radio" name="poMode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} />
              新しい発注書を受け付ける
            </label>
            <label className="p1-radio">
              <input type="radio" name="poMode" value="existing" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              登録済みの発注書に追加する
            </label>
          </div>
        ) : null}
        {mode === 'existing' ? (
          <SelectField
            name="existingPoId"
            label="登録済みのセブン化学発注書"
            required
            includeBlank
            blankLabel="（選ぶ）"
            choices={existingPoChoices}
            width={360}
            onChange={(event) => setExistingPoId(event.target.value)}
          />
        ) : (
          <>
            <div className="p1-row">
              <TextField name="poNumber" label="発注番号" required width={240} autoComplete="off" spellCheck={false} placeholder="SC-2026-0112" />
              <DateTextField name="officialRegisteredAt" label="本登録日" required />
            </div>
            <StepFileField label="発注書のPDF（任意）" required={false} hint="セブン化学から届いた発注書。5MBまで。" />
          </>
        )}
      </fieldset>

      {needsChecklist ? (
        <fieldset className="p1-fieldset">
          {mode === 'existing' ? <input type="hidden" readOnly name="runChecklist" value="true" /> : null}
          <legend className="p1-legend"><span className="p1-legend-no">2</span>発注書の照合</legend>
          <p className="p1-field-hint">発注書の原本を見ながら、確かめた項目にチェックします（番号・数量・価格・納期・見積の版）。</p>
          <div className="p1-check-grid">
            <CheckboxField name="issuerNameRecorded" label="発行者名を確認した" />
            <TextField name="issuerName" label="発行者名" width={220} />
            <CheckboxField name="documentNumberRecorded" label="文書番号を確認した" />
            <TextField name="documentNumber" label="文書番号" width={220} />
            <CheckboxField name="issueDateRecorded" label="発行日を確認した" />
            <DateTextField name="issueDate" label="発行日" />
            <CheckboxField name="sendingChannelRecorded" label="送信経路を確認した" />
            <TextField name="sendingChannel" label="送信経路" width={220} />
            <CheckboxField name="pastTransactionCompared" label="過去取引と突合した" />
            <TextField name="pastTransactionNote" label="突合メモ" width={220} />
            <CheckboxField name="quoteCompared" label="見積と突合した" />
            <SelectField name="quoteMatchesPo" label="見積との突合結果" required choices={QUOTE_MATCH_CHOICES} width={240} />
            <CheckboxField name="uncertain" label="確認が不確かだった" />
            <CheckboxField name="confirmationReplyRecorded" label="確認の返信を記録した（不確かな場合必須）" />
            <TextField name="confirmationReplyNote" label="返信メモ" width={220} />
            <TextareaField name="verificationNote" label="照合メモ（任意）" rows={2} />
          </div>
        </fieldset>
      ) : null}

      <fieldset className="p1-fieldset">
        <legend className="p1-legend"><span className="p1-legend-no">3</span>発注内容</legend>
        <TextField name="code" label="発注コード" required width={260} autoComplete="off" spellCheck={false} placeholder="PRS-A-FILM-003" />
        <div className="p1-lines">
          <p className="p1-field-label">明細（説明・数量・単位）</p>
          {lines.map((line, index) => (
            <div key={index} className="p1-line-row">
              <span className="p1-line-no">明細{index + 1}</span>
              <LineInputs
                index={index}
                line={line}
                unitChoices={unitChoices}
                onChange={(patch) => setLines(lines.map((row, i) => (i === index ? { ...row, ...patch } : row)))}
              />
              {lines.length > 1 ? (
                <button type="button" className="p1-button p1-button--quiet" onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                  {`明細${index + 1}を削除`}
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" className="p1-button p1-button--quiet" onClick={() => setLines([...lines, { description: '', quantity: '', unit: firstUnit }])}>
            明細を追加（新しい発注）
          </button>
        </div>
        <FieldFeedback name="paymentTerms" hasHint>
          {(feedback) => (
            <div className="field p1-field">
              <label className="p1-field-label" htmlFor={`${warningId}-terms`}>
                支払条件<span className="p1-required">（必須）</span>
              </label>
              <select
                id={`${warningId}-terms`}
                name="paymentTerms"
                className="p1-select"
                value={paymentTerms}
                required
                onChange={(event) => setPaymentTerms(event.target.value)}
                aria-describedby={[feedback.describedBy, paymentTerms === UNDECIDED_TERMS ? warningId : null].filter(Boolean).join(' ') || undefined}
                aria-invalid={feedback.invalid}
                data-feedback-label="支払条件"
              >
                <option value="" disabled>選んでください</option>
                {paymentTermsChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
              <FieldError id={feedback.errorId} message={feedback.error} />
              {paymentTerms === UNDECIDED_TERMS ? (
                <p id={warningId} className="field-warning" role="status"><span aria-hidden="true">⚠</span> {UNDECIDED_TERMS_WARNING}</p>
              ) : null}
              <span id={feedback.hintId} className="p1-field-hint">{PAYMENT_TERMS_HINT}</span>
            </div>
          )}
        </FieldFeedback>
      </fieldset>

      <div className="form-actions">
        <SubmitLock>
          {(locked) => (
            <button type="submit" className="p1-button p1-button--primary" aria-disabled={pending || undefined} disabled={locked || undefined}>
              {pending ? '作成しています…' : SUBMIT_LABEL}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        <FormResult state={state} />
      </div>
    </FeedbackForm>
  );
}
