'use client';

import { useActionState, useContext, useId, useState } from 'react';
import type { FormAction } from './ActionForm';
import {
  FeedbackForm,
  FieldError,
  FieldFeedback,
  FormErrorSummary,
  FormFeedbackContext,
  FormResult,
  resolverFromOptions,
  SubmitLock
} from './form-feedback';
import type { ConfirmOptions } from './form-feedback';
import { lineField } from '../lib/form-messages';
import { normalizeQuantityText } from '../lib/form-validation';
import type { Choice } from '../lib/types';
import { buttonStyle, inputStyle, noteStyle, subtleButtonStyle } from '../lib/ui';

/** P0 R01: the term that keeps 代表承認 closed (the API's undetermined). */
export const UNDECIDED_TERMS = 'undetermined';

export const UNDECIDED_TERMS_WARNING =
  '「未定」のままでは代表承認できません。決まったら代表承認の前に支払条件を変更してください。';

export const PAYMENT_TERMS_HINT = '支払条件の記録は入金確認ではありません（入金の確認は別の手順です）。';

interface LineRow {
  description: string;
  quantity: string;
  unit: string;
}

interface OrderCreateFormProps {
  action: FormAction;
  unitChoices: Choice[];
  orderKind: 'film' | 'filling';
  sevenPurchaseOrderChoices?: Choice[];
  /**
   * M8-OPER2 FIX 1: the G6 transaction terms, chosen while the order is still a
   * draft. Omitted for the filling order form — the terms belong to the film
   * supply chain only.
   */
  paymentTermsChoices?: Choice[];
  /** UI batch C: optional confirmation before the order is created. */
  confirm?: ConfirmOptions | undefined;
  /** Appended after 「記録しました。」. */
  successHint?: string | undefined;
}

const SUBMIT_LABEL = '発注を作成する';

/**
 * The description / quantity / unit inputs of one line, with their field errors.
 * P1 R34 (M15): each input has a visible label (説明・数量・単位); the line
 * number is in the accessible name only, so the name stays 「明細1の説明」.
 */
export function LineInputs({
  index,
  line,
  unitChoices,
  onChange
}: {
  index: number;
  line: LineRow;
  unitChoices: Choice[];
  onChange: (patch: Partial<LineRow>) => void;
}) {
  const feedback = useContext(FormFeedbackContext);
  const baseId = useId();
  const parts = ['description', 'quantity', 'unit'] as const;
  const state = Object.fromEntries(
    parts.map((part) => {
      const error = feedback?.errors[lineField(index, part)];
      return [part, { error, errorId: `${baseId}${part}`, describedBy: error ? `${baseId}${part}` : undefined, invalid: error ? (true as const) : undefined }];
    })
  ) as Record<(typeof parts)[number], { error: string | undefined; errorId: string; describedBy: string | undefined; invalid: true | undefined }>;
  return (
    <>
      <span className="line-field" style={{ display: 'grid', gap: 2, flex: '0 1 260px', minWidth: 'min(160px, 100%)' }}>
        <label className="line-field-inner">
        <span className="line-field-label"><span className="visually-hidden">{`明細${index + 1}の`}</span>説明</span>
        <input
          value={line.description}
          required
          onChange={(event) => onChange({ description: event.target.value })}
          aria-describedby={state.description.describedBy}
          aria-invalid={state.description.invalid}
          data-feedback-name={lineField(index, 'description')}
          style={{ ...inputStyle, width: '100%' }}
        />
        </label>
        <FieldError id={state.description.errorId} message={state.description.error} />
      </span>
      <span className="line-field" style={{ display: 'grid', gap: 2, flex: '0 1 120px', minWidth: 96 }}>
        <label className="line-field-inner">
        <span className="line-field-label"><span className="visually-hidden">{`明細${index + 1}の`}</span>数量</span>
        <input
          value={line.quantity}
          inputMode="decimal"
          required
          pattern="\d+(\.\d+)?"
          onChange={(event) => onChange({ quantity: event.target.value })}
          onBlur={(event) => {
            const normalized = normalizeQuantityText(event.currentTarget.value);
            if (normalized !== line.quantity) onChange({ quantity: normalized });
          }}
          aria-describedby={state.quantity.describedBy}
          aria-invalid={state.quantity.invalid}
          data-feedback-name={lineField(index, 'quantity')}
          data-quantity-text=""
          data-feedback-format="正の数（例 1000、12.5）"
          style={{ ...inputStyle, width: '100%' }}
        />
        </label>
        <FieldError id={state.quantity.errorId} message={state.quantity.error} />
      </span>
      <span className="line-field" style={{ display: 'grid', gap: 2, flex: '0 1 140px', minWidth: 96 }}>
        <label className="line-field-inner">
        <span className="line-field-label"><span className="visually-hidden">{`明細${index + 1}の`}</span>単位</span>
        <select
          value={line.unit}
          onChange={(event) => onChange({ unit: event.target.value })}
          aria-describedby={state.unit.describedBy}
          aria-invalid={state.unit.invalid}
          data-feedback-name={lineField(index, 'unit')}
          style={{ ...inputStyle, width: '100%' }}
        >
          {unitChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        </label>
        <FieldError id={state.unit.errorId} message={state.unit.error} />
      </span>
    </>
  );
}

/**
 * Criterion 3: the film supply order form (code, lines with description /
 * quantity / unit, optional seven PO) and the filling order form. Lines are
 * edited as rows and serialized into one hidden field, which the server action
 * numbers and validates before posting to the API.
 */
export function OrderCreateForm({
  action,
  unitChoices,
  orderKind,
  sevenPurchaseOrderChoices,
  paymentTermsChoices,
  confirm,
  successHint
}: OrderCreateFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const undecidedWarningId = useId();
  const [lines, setLines] = useState<LineRow[]>([{ description: '', quantity: '', unit: unitChoices[0]?.value ?? '' }]);
  const [code, setCode] = useState('');
  const [sevenPurchaseOrderId, setSevenPurchaseOrderId] = useState('');
  // P0 R01 (B1): no default — 「未定」 is chosen on purpose, and then warned about.
  const [paymentTerms, setPaymentTerms] = useState('');

  const serialized = JSON.stringify(
    // A quantity typed with spaces or full-width digits still posts ASCII digits.
    lines.map((line) => ({ description: line.description, orderedQuantity: normalizeQuantityText(line.quantity), unit: line.unit }))
  );

  function updateLine(index: number, patch: Partial<LineRow>): void {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      // P0 R05/R06: after a success the controlled fields empty too (the shell resets only
      // after a success), so the next order never starts from the code just registered.
      onReset={() => {
        setCode('');
        setLines([{ description: '', quantity: '', unit: unitChoices[0]?.value ?? '' }]);
        setSevenPurchaseOrderId('');
        setPaymentTerms('');
      }}
      confirm={resolverFromOptions(confirm, SUBMIT_LABEL)}
      dialogDefaults={confirm ? { options: confirm, confirmLabel: confirm.confirmLabel ?? SUBMIT_LABEL } : undefined}
      style={{ display: 'grid', gap: 10 }}
    >
      <input type="hidden" readOnly name="lines" value={serialized} />
      <FieldFeedback name="code">
        {(codeFeedback) => (
          <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%' }}>
            <label className="field-label">
              <span style={{ fontSize: 13 }}>
                発注コード<span style={{ color: 'var(--danger)' }}>（必須）</span>
              </span>
              <input
                name="code"
                value={code}
                required
                onChange={(event) => setCode(event.target.value)}
                placeholder={orderKind === 'film' ? 'FSO-...' : 'FLO-...'}
                aria-describedby={codeFeedback.describedBy}
                aria-invalid={codeFeedback.invalid}
                data-feedback-label="発注コード"
                style={{ ...inputStyle, width: '100%', maxWidth: 280 }}
              />
            </label>
            <FieldError id={codeFeedback.errorId} message={codeFeedback.error} />
          </div>
        )}
      </FieldFeedback>

      {sevenPurchaseOrderChoices ? (
        // UI batch E (F-05): required for a film order. An order made without its
        // PO can never leave 下書き, and the link cannot be added afterwards.
        <FieldFeedback name="sevenPurchaseOrderId" hasHint>
          {(poFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%' }}>
              <label className="field-label">
                <span style={{ fontSize: 13 }}>
                  セブン化学発注書<span style={{ color: 'var(--danger)' }}>（必須）</span>
                </span>
                <select
                  name="sevenPurchaseOrderId"
                  value={sevenPurchaseOrderId}
                  required
                  onChange={(event) => setSevenPurchaseOrderId(event.target.value)}
                  aria-describedby={poFeedback.describedBy}
                  aria-invalid={poFeedback.invalid}
                  data-feedback-label="セブン化学発注書"
                  style={{ ...inputStyle, width: '100%', maxWidth: 340 }}
                >
                  <option value="">{sevenPurchaseOrderChoices.length > 0 ? '（発注書を選ぶ）' : '（登録済みの発注書がありません）'}</option>
                  {sevenPurchaseOrderChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={poFeedback.errorId} message={poFeedback.error} />
              <span id={poFeedback.hintId} style={noteStyle}>
                {sevenPurchaseOrderChoices.length > 0
                  ? '紐付けはここでしか選べません（あとから付け替えられません）。状態を進めるには、選んだ発注書の公式登録と真性行チェックリスト（確認済み）が必要です。'
                  : '先に「セブン化学発注書を登録する」で紙の発注書を登録してください。'}
              </span>
            </div>
          )}
        </FieldFeedback>
      ) : null}

      {paymentTermsChoices && paymentTermsChoices.length > 0 ? (
        <FieldFeedback name="paymentTerms" hasHint>
          {(paymentFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%' }}>
              <label className="field-label">
                <span style={{ fontSize: 13 }}>
                  支払条件<span style={{ color: 'var(--danger)' }}>（必須）</span>
                </span>
                {/* P0 R01 (B1): required with no preselected value — the operator picks one.
                    「未定」 is a real choice, but never the silent default it used to be. */}
                <select
                  name="paymentTerms"
                  value={paymentTerms}
                  onChange={(event) => setPaymentTerms(event.target.value)}
                  required
                  aria-describedby={[paymentFeedback.describedBy, paymentTerms === UNDECIDED_TERMS ? undecidedWarningId : null].filter(Boolean).join(' ') || undefined}
                  aria-invalid={paymentFeedback.invalid}
                  data-feedback-label="支払条件"
                  style={{ ...inputStyle, width: '100%', maxWidth: 340 }}
                >
                  <option value="" disabled>
                    選んでください
                  </option>
                  {paymentTermsChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={paymentFeedback.errorId} message={paymentFeedback.error} />
              {paymentTerms === UNDECIDED_TERMS ? (
                <p id={undecidedWarningId} className="field-warning" role="status">
                  <span aria-hidden="true">⚠</span> {UNDECIDED_TERMS_WARNING}
                </p>
              ) : null}
              <span id={paymentFeedback.hintId} style={noteStyle}>
                {PAYMENT_TERMS_HINT}
              </span>
            </div>
          )}
        </FieldFeedback>
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        <span style={{ fontSize: 13 }}>明細（説明・数量・単位）</span>
        {lines.map((line, index) => (
          <div key={index} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 }}>
            <span style={noteStyle}>明細{index + 1}</span>
            <LineInputs index={index} line={line} unitChoices={unitChoices} onChange={(patch) => updateLine(index, patch)} />
            {lines.length > 1 ? (
              <button
                type="button"
                style={subtleButtonStyle}
                onClick={() => setLines(lines.filter((_, i) => i !== index))}
              >
                削除
              </button>
            ) : null}
          </div>
        ))}
        <div>
          <button
            type="button"
            style={subtleButtonStyle}
            onClick={() => setLines([...lines, { description: '', quantity: '', unit: unitChoices[0]?.value ?? '' }])}
          >
            {orderKind === 'film' ? '明細を追加（フィルム発注）' : '明細を追加（充填発注）'}
          </button>
        </div>
      </div>

      <div className="form-actions">
        <SubmitLock>
          {(locked) => (
            <button
              type="submit"
              aria-disabled={pending || undefined}
              disabled={locked || undefined}
              style={{ ...buttonStyle, opacity: pending || locked ? 0.6 : 1 }}
            >
              {pending ? '作成中…' : SUBMIT_LABEL}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
