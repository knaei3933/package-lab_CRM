'use client';

import { useActionState, useState } from 'react';
import type { FormAction } from './ActionForm.js';
import type { Choice } from '../lib/types.js';
import { buttonStyle, errorMessageStyle, inputStyle, noteStyle, okMessageStyle } from '../lib/ui.js';

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
}

/**
 * Criterion 6 (recording side): a delivery row has to exist before it can be
 * confirmed, so the confirmation screen also records deliveries. The line
 * select follows the selected order.
 */
export function DeliveryRecordForm({ action, kind, orders, unitChoices }: DeliveryRecordFormProps) {
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
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      <input type="hidden" readOnly name="kind" value={kind} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>発注<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <select
            name="orderId"
            value={orderId}
            onChange={(event) => {
              setOrderId(event.target.value);
              setLineId('');
            }}
            style={{ ...inputStyle, width: 300 }}
          >
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.code}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>明細<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <select
            name="lineId"
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            required
            style={{ ...inputStyle, width: 300 }}
          >
            <option value="">明細を選択</option>
            {lines.map((line) => (
              <option key={line.value} value={line.value}>
                {line.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>納品数量<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <input name="deliveredQuantity" inputMode="decimal" required style={{ ...inputStyle, width: 140 }} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>単位<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <select name="unit" value={unit} onChange={(event) => setUnit(event.target.value)} style={{ ...inputStyle, width: 140 }}>
            {unitChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>納品日（任意・未入力は現在日時）</span>
          <input type="datetime-local" name="deliveredAt" style={{ ...inputStyle, width: 240 }} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>運送業者参照（任意）</span>
          <input name="carrierReference" style={{ ...inputStyle, width: 200 }} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>備考（任意）</span>
          <input name="note" style={{ ...inputStyle, width: 220 }} />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? '記録中…' : '納品を記録する'}
        </button>
        {state ? <span style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span> : null}
      </div>
    </form>
  );
}
