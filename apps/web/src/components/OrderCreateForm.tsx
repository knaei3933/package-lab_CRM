'use client';

import { useActionState, useState } from 'react';
import type { FormAction } from './ActionForm.js';
import type { Choice } from '../lib/types.js';
import { buttonStyle, errorMessageStyle, inputStyle, noteStyle, okMessageStyle, subtleButtonStyle } from '../lib/ui.js';

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
}

/**
 * Criterion 3: the film supply order form (code, lines with description /
 * quantity / unit, optional seven PO) and the filling order form. Lines are
 * edited as rows and serialized into one hidden field, which the server action
 * numbers and validates before posting to the API.
 */
export function OrderCreateForm({ action, unitChoices, orderKind, sevenPurchaseOrderChoices }: OrderCreateFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [lines, setLines] = useState<LineRow[]>([{ description: '', quantity: '', unit: unitChoices[0]?.value ?? '' }]);
  const [code, setCode] = useState('');
  const [sevenPurchaseOrderId, setSevenPurchaseOrderId] = useState('');

  const serialized = JSON.stringify(
    lines.map((line) => ({ description: line.description, orderedQuantity: line.quantity, unit: line.unit }))
  );

  function updateLine(index: number, patch: Partial<LineRow>): void {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      <input type="hidden" readOnly name="lines" value={serialized} />
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 13 }}>
          発注コード<span style={{ color: '#b91c1c' }}>（必須）</span>
        </span>
        <input
          name="code"
          value={code}
          required
          onChange={(event) => setCode(event.target.value)}
          placeholder={orderKind === 'film' ? 'FSO-...' : 'FLO-...'}
          style={{ ...inputStyle, width: 280 }}
        />
      </label>

      {sevenPurchaseOrderChoices && sevenPurchaseOrderChoices.length > 0 ? (
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>セブン化学発注書の紐付け（任意）</span>
          <select
            name="sevenPurchaseOrderId"
            value={sevenPurchaseOrderId}
            onChange={(event) => setSevenPurchaseOrderId(event.target.value)}
            style={{ ...inputStyle, width: 340 }}
          >
            <option value="">紐付けない</option>
            {sevenPurchaseOrderChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        <span style={{ fontSize: 13 }}>明細（説明・数量・単位）</span>
        {lines.map((line, index) => (
          <div key={index} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={noteStyle}>明細{index + 1}</span>
            <input
              value={line.description}
              placeholder="説明"
              aria-label={`明細${index + 1}の説明`}
              onChange={(event) => updateLine(index, { description: event.target.value })}
              style={{ ...inputStyle, width: 260 }}
            />
            <input
              value={line.quantity}
              placeholder="数量"
              aria-label={`明細${index + 1}の数量`}
              inputMode="decimal"
              onChange={(event) => updateLine(index, { quantity: event.target.value })}
              style={{ ...inputStyle, width: 120 }}
            />
            <select
              value={line.unit}
              aria-label={`明細${index + 1}の単位`}
              onChange={(event) => updateLine(index, { unit: event.target.value })}
              style={{ ...inputStyle, width: 140 }}
            >
              {unitChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
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
            明細を追加
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? '作成中…' : '発注を作成する'}
        </button>
        {state ? <span style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span> : null}
      </div>
    </form>
  );
}
