'use client';

import { useActionState, useId, useState } from 'react';
import type { FormAction } from './ActionForm';
import { FeedbackForm, FieldError, FieldFeedback, FormErrorSummary, FormResult, resolverFromOptions, summaryFromFields } from './form-feedback';
import type { ConfirmOptions, ConfirmResolver } from './form-feedback';
import { OffsetDateTimeField } from './OffsetDateTimeField';
import { approvalConfirmSpec } from '../lib/confirm-summary';
import type { Choice } from '../lib/types';
import { buttonStyle, inputStyle, noteStyle } from '../lib/ui';

interface ApprovalDecisionFormProps {
  action: FormAction;
  revisionId: string;
  designKey: string;
  evidenceChoices: Choice[];
  evidenceSourceChoices: Choice[];
  defaultEventTime: string;
  /** UI batch C: replaces the built-in per-organization confirmation. */
  confirm?: ConfirmOptions | undefined;
  /** Appended after 「記録しました。」. */
  successHint?: string | undefined;
}

/** UI batch C (1-③): the organization comes from the button that was pressed (texts: lib/confirm-summary). */
const approvalConfirm: ConfirmResolver = (form, submitter) => {
  const organization = submitter instanceof HTMLButtonElement ? submitter.value : '';
  const [evidence, eventTime] = summaryFromFields(form, ['evidenceDocumentVersionId', 'eventTime']);
  return approvalConfirmSpec(organization, evidence?.value, eventTime?.value);
};

/** UI batch C (review L5): the label wraps the caption + control; error and help follow it. */
const labelOnly = { display: 'grid', gap: 4 } as const;

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
  defaultEventTime,
  confirm,
  successHint
}: ApprovalDecisionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [evidenceIdentifier, setEvidenceIdentifier] = useState(
    evidenceChoices[0]?.autoEvidenceIdentifier ?? ''
  );
  const [selectedEvidenceVersionId, setSelectedEvidenceVersionId] = useState(
    evidenceChoices[0]?.value ?? ''
  );
  const evidenceHelpId = useId();
  /** The shared G6 help first, then this field's error when there is one. */
  const describedBy = (errorId: string | undefined) => (errorId ? `${evidenceHelpId} ${errorId}` : evidenceHelpId);

  function onEvidenceChange(value: string): void {
    const selected = evidenceChoices.find((choice) => choice.value === value);
    setSelectedEvidenceVersionId(value);
    setEvidenceIdentifier(selected?.autoEvidenceIdentifier ?? '');
  }

  if (evidenceChoices.length === 0) {
    return (
      <p style={noteStyle}>
        このデザインに使える承認証跡のバージョンがまだありません。文書画面から
        「{designKey}」に紐付けた承認証跡をアップロードしてください。
      </p>
    );
  }

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      confirm={resolverFromOptions(confirm, '承認する') ?? approvalConfirm}
      dialogDefaults={{
        options: confirm ?? { title: '承認を記録しますか？', body: '' },
        confirmLabel: confirm?.confirmLabel ?? '承認する'
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <input type="hidden" readOnly name="revisionId" value={revisionId} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <FieldFeedback name="evidenceDocumentVersionId">
          {(versionFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 380px' }}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>
                  承認証跡の書類バージョン<span style={{ color: 'var(--danger)' }}>（必須・両組織で同じ版を引用します）</span>
                </span>
                <select
                  name="evidenceDocumentVersionId"
                  required
                  aria-describedby={describedBy(versionFeedback.error ? versionFeedback.errorId : undefined)}
                  aria-invalid={versionFeedback.invalid}
                  data-feedback-label="承認証跡の書類バージョン"
                  autoComplete="off"
                  onChange={(event) => onEvidenceChange(event.target.value)}
                  style={{ ...inputStyle, width: '100%', maxWidth: 380 }}
                >
                  {evidenceChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={versionFeedback.errorId} message={versionFeedback.error} />
              <p id={evidenceHelpId} style={noteStyle}>
                保存済みEMLのMessage-IDはシステムが自動抽出します。PDF・画像などEML以外だけ入力できます。
              </p>
            </div>
          )}
        </FieldFeedback>
        <FieldFeedback name="evidenceIdentifier">
          {(identifierFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 300px' }}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>
                  承認証跡識別子<span style={{ color: 'var(--danger)' }}>（必須・組織ごとに固有）</span>
                </span>
                <input
                  name="evidenceIdentifier"
                  required
                  value={evidenceIdentifier}
                  onChange={(event) => setEvidenceIdentifier(event.target.value)}
                  aria-describedby={describedBy(identifierFeedback.error ? identifierFeedback.errorId : undefined)}
                  aria-invalid={identifierFeedback.invalid}
                  data-feedback-label="承認証跡識別子"
                  readOnly={Boolean(evidenceChoices.find((choice) => choice.value === selectedEvidenceVersionId)?.autoEvidenceIdentifier)}
                  minLength={8}
                  placeholder="例：メールは自動入力、PDFは署名ブロックのハッシュ"
                  spellCheck={false}
                  style={{ ...inputStyle, width: '100%', maxWidth: 300 }}
                />
              </label>
              <FieldError id={identifierFeedback.errorId} message={identifierFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        <FieldFeedback name="evidenceSource">
          {(sourceFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 220px' }}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>証跡の入手経路<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                <select
                  name="evidenceSource"
                  required
                  aria-describedby={sourceFeedback.describedBy}
                  aria-invalid={sourceFeedback.invalid}
                  data-feedback-label="証跡の入手経路"
                  style={{ ...inputStyle, width: '100%', maxWidth: 220 }}
                >
                  {evidenceSourceChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={sourceFeedback.errorId} message={sourceFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        <OffsetDateTimeField
          name="eventTime"
          label="承認日時（外部イベントの時刻）"
          required
          defaultValue={defaultEventTime}
          width={240}
        />
        <label className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 180px' }}>
          <span style={{ fontSize: 13 }}>承認者名（任意・そのまま記録します）</span>
          <input name="approverName" style={{ ...inputStyle, width: '100%', maxWidth: 180 }} />
        </label>
        <label className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 180px' }}>
          <span style={{ fontSize: 13 }}>外部承認者の組織（任意）</span>
          <input name="externalApproverOrg" style={{ ...inputStyle, width: '100%', maxWidth: 180 }} />
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" name="organization" value="customer" aria-disabled={pending || undefined} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          顧客として承認する
        </button>
        <button type="submit" name="organization" value="seven" aria-disabled={pending || undefined} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          セブン化学として承認する
        </button>
        <span style={noteStyle}>どちらが先でも構いません。2つ目の承認でダブル承認（校了）になります。</span>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
