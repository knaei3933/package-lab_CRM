'use client';

import { useActionState } from 'react';
import type { FormAction } from './ActionForm';
import type { Choice } from '../lib/types';
import { buttonStyle, errorMessageStyle, inputStyle, noteStyle, okMessageStyle } from '../lib/ui';

interface ApprovalDecisionFormProps {
  action: FormAction;
  revisionId: string;
  designKey: string;
  evidenceChoices: Choice[];
  evidenceSourceChoices: Choice[];
  defaultEventTime: string;
}

/**
 * Criterion 5: the two approval buttons of one design. Either organization can
 * approve first; both buttons submit the same form, so the second approval
 * necessarily cites the same evidence document version the first one did.
 * The screen re-renders after each click and the gate state moves with it.
 */
export function ApprovalDecisionForm({
  action,
  revisionId,
  designKey,
  evidenceChoices,
  evidenceSourceChoices,
  defaultEventTime
}: ApprovalDecisionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);

  if (evidenceChoices.length === 0) {
    return (
      <p style={noteStyle}>
        このデザインに使える承認証跡（approval_evidence）のバージョンがまだありません。文書画面から
        「{designKey}」に紐付けた承認証跡をアップロードしてください。
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      <input type="hidden" readOnly name="revisionId" value={revisionId} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>
            承認証跡の書類バージョン<span style={{ color: '#b91c1c' }}>（必須・両組織で同じ版を引用します）</span>
          </span>
          <select name="evidenceDocumentVersionId" required style={{ ...inputStyle, width: 380 }}>
            {evidenceChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>
            承認証跡識別子<span style={{ color: '#b91c1c' }}>（必須・組織ごとに固有）</span>
          </span>
          <input
            name="evidenceIdentifier"
            required
            minLength={8}
            placeholder="例：メールのMessage-IDや署名ブロックのハッシュ"
            style={{ ...inputStyle, width: 300 }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>証跡の入手経路<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <select name="evidenceSource" required style={{ ...inputStyle, width: 220 }}>
            {evidenceSourceChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>承認日時（外部イベントの時刻）<span style={{ color: '#b91c1c' }}>（必須）</span></span>
          <input type="datetime-local" name="eventTime" required defaultValue={defaultEventTime} style={{ ...inputStyle, width: 240 }} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>承認者名（任意・そのまま記録します）</span>
          <input name="approverName" style={{ ...inputStyle, width: 180 }} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>外部承認者の組織（任意）</span>
          <input name="externalApproverOrg" style={{ ...inputStyle, width: 180 }} />
        </label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <button type="submit" name="organization" value="customer" disabled={pending} style={buttonStyle}>
          顧客として承認する
        </button>
        <button type="submit" name="organization" value="seven" disabled={pending} style={buttonStyle}>
          セブン化学として承認する
        </button>
        <span style={noteStyle}>どちらが先でも構いません。2つ目の承認でダブル承認（校了）になります。</span>
        {state ? <span style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span> : null}
      </div>
    </form>
  );
}
