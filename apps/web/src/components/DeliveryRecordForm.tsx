'use client';

import { useActionState, useState } from 'react';
import type { FormAction } from './ActionForm';
import {
  FeedbackForm,
  FieldError,
  FieldFeedback,
  FormErrorSummary,
  FormResult,
  normalizeQuantityInput,
  SubmitLock,
  summaryFromFields
} from './form-feedback';
import type { ConfirmResolver } from './form-feedback';
import { OffsetDateTimeField } from './OffsetDateTimeField';
import {
  DELIVERY_RECORD_CONFIRM_BODY,
  DELIVERY_RECORD_CONFIRM_TITLE,
  DELIVERY_RECORD_SUBMIT_LABEL,
  deliveryRecordConfirmSpec
} from '../lib/confirm-summary';
import type { Choice } from '../lib/types';
import { buttonStyle, inputStyle, noteStyle } from '../lib/ui';

export interface DeliveryOrderOption {
  id: string;
  code: string;
  lines: Choice[];
}

interface DeliveryRecordFormProps {
  action: FormAction;
  kind: 'film' | 'filling';
  orders: DeliveryOrderOption[];
  unitChoices: Choice[];
  /** Appended after 「記録しました。」. */
  successHint?: string | undefined;
}

/** UI batch C (1-④): the old fixed width becomes the flex basis; the control fills it up to that width. */
const fieldLabel = (basis: number) => ({ display: 'grid', gap: 4, maxWidth: '100%', flex: `0 1 ${basis}px` }) as const;
/** UI batch C (review L5): the label wraps the caption + control; the error sits after it. */
const labelOnly = { display: 'grid', gap: 4 } as const;
const control = (max: number) => ({ ...inputStyle, width: '100%', maxWidth: max });

/** Review M3: the delivery is read back before it is recorded; an empty 納品日 is named as 「現在日時」 (texts: lib/confirm-summary). */
const deliveryConfirm: ConfirmResolver = (form) => {
  const [deliveredAt, ...rows] = summaryFromFields(form, ['deliveredAt', 'orderId', 'lineId', 'deliveredQuantity', 'unit']);
  return deliveryRecordConfirmSpec(rows, deliveredAt?.value ?? '');
};

/**
 * Criterion 6 (recording side): a delivery row has to exist before it can be
 * confirmed, so the confirmation screen also records deliveries. The line
 * select follows the selected order.
 */
export function DeliveryRecordForm({ action, kind, orders, unitChoices, successHint }: DeliveryRecordFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [orderId, setOrderId] = useState(orders[0]?.id ?? '');
  const [lineId, setLineId] = useState('');
  const [unit, setUnit] = useState(unitChoices[0]?.value ?? '');

  const lines = orders.find((order) => order.id === orderId)?.lines ?? [];

  if (orders.length === 0) {
    return (
      <p style={noteStyle}>
        {kind === 'film' ? 'フィルム発注' : '充填発注'}がまだありません。先に発注を作成してください。
      </p>
    );
  }

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      confirm={deliveryConfirm}
      dialogDefaults={{
        options: { title: DELIVERY_RECORD_CONFIRM_TITLE, body: DELIVERY_RECORD_CONFIRM_BODY },
        confirmLabel: DELIVERY_RECORD_SUBMIT_LABEL
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <input type="hidden" readOnly name="kind" value={kind} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <FieldFeedback name="orderId">
          {(orderFeedback) => (
            <div className="field" style={fieldLabel(300)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>発注<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                <select
                  name="orderId"
                  value={orderId}
                  onChange={(event) => {
                    setOrderId(event.target.value);
                    setLineId('');
                  }}
                  aria-describedby={orderFeedback.describedBy}
                  aria-invalid={orderFeedback.invalid}
                  data-feedback-label="発注"
                  style={control(300)}
                >
                  {orders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.code}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={orderFeedback.errorId} message={orderFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        <FieldFeedback name="lineId">
          {(lineFeedback) => (
            <div className="field" style={fieldLabel(300)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>明細<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                <select
                  name="lineId"
                  value={lineId}
                  onChange={(event) => setLineId(event.target.value)}
                  required
                  aria-describedby={lineFeedback.describedBy}
                  aria-invalid={lineFeedback.invalid}
                  data-feedback-label="明細"
                  style={control(300)}
                >
                  <option value="">明細を選択</option>
                  {lines.map((line) => (
                    <option key={line.value} value={line.value}>
                      {line.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={lineFeedback.errorId} message={lineFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        <FieldFeedback name="deliveredQuantity">
          {(quantityFeedback) => (
            <div className="field" style={fieldLabel(140)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>納品数量<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                {/* Review L7: spaces and full-width digits are normalized on blur (and before the check). */}
                <input
                  name="deliveredQuantity"
                  inputMode="decimal"
                  required
                  pattern="\d+(\.\d+)?"
                  onBlur={(event) => normalizeQuantityInput(event.currentTarget)}
                  aria-describedby={quantityFeedback.describedBy}
                  aria-invalid={quantityFeedback.invalid}
                  data-quantity-text=""
                  data-feedback-label="納品数量"
                  data-feedback-format="正の数（例 1000、12.5）"
                  style={control(140)}
                />
              </label>
              <FieldError id={quantityFeedback.errorId} message={quantityFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        <label className="field" style={fieldLabel(140)}>
          <span style={{ fontSize: 13 }}>単位<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select name="unit" value={unit} onChange={(event) => setUnit(event.target.value)} style={control(140)}>
            {unitChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <OffsetDateTimeField name="deliveredAt" label="納品日（任意・未入力は現在日時）" width={240} />
        <label className="field" style={fieldLabel(200)}>
          <span style={{ fontSize: 13 }}>運送業者参照（任意）</span>
          <input name="carrierReference" style={control(200)} />
        </label>
        <label className="field" style={fieldLabel(220)}>
          <span style={{ fontSize: 13 }}>備考（任意）</span>
          <input name="note" style={control(220)} />
        </label>
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
              {pending ? '記録中…' : DELIVERY_RECORD_SUBMIT_LABEL}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
