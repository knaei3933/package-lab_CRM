'use client';

import { useActionState, useId, useState } from 'react';
import type { FormAction } from './ActionForm';
import { FeedbackForm, FieldError, FieldFeedback, FormErrorSummary, FormResult, resolverFromOptions, SubmitLock, summaryFromFields } from './form-feedback';
import type { ConfirmOptions, ConfirmResolver } from './form-feedback';
import { OffsetDateTimeField } from './OffsetDateTimeField';
import { approvalConfirmSpec } from '../lib/confirm-summary';
import type { Choice } from '../lib/types';
import { buttonStyle, inputStyle, noteStyle } from '../lib/ui';

type ApprovalOrganization = 'customer' | 'seven';

const ORGANIZATION_LABEL: Record<ApprovalOrganization, string> = { customer: '顧客', seven: 'セブン化学' };

/** P0 R02: the issuer each organization's approval evidence must have (the shared exception allows either). */
const ISSUER_FOR: Record<ApprovalOrganization, string> = { customer: 'customer_generated', seven: 'seven' };

/** Exported for tests. A choice without an issuer (older data shape) stays offered; the API decides. */
export function matchesOrganization(choice: Choice, organization: ApprovalOrganization, shared: boolean): boolean {
  if (choice.issuerEntity === undefined) return true;
  if (shared) return choice.issuerEntity === 'customer_generated' || choice.issuerEntity === 'seven';
  return choice.issuerEntity === ISSUER_FOR[organization];
}

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
  // P0 R02 (B2, policy P-1): the organization is chosen first; only evidence that
  // organization issued is offered (顧客 → 顧客作成, セブン化学 → セブン化学). The shared
  // exception (one paper carries both approvals) needs a tick and a reason, and the
  // API then always holds the approval for the representative's manual check.
  const [organization, setOrganization] = useState<ApprovalOrganization>(
    evidenceChoices.some((choice) => matchesOrganization(choice, 'customer', false)) || !evidenceChoices.some((choice) => matchesOrganization(choice, 'seven', false))
      ? 'customer'
      : 'seven'
  );
  const [shared, setShared] = useState(false);
  const offered = evidenceChoices.filter((choice) => matchesOrganization(choice, organization, shared));
  const [evidenceIdentifier, setEvidenceIdentifier] = useState(
    offered[0]?.autoEvidenceIdentifier ?? ''
  );
  const [selectedEvidenceVersionId, setSelectedEvidenceVersionId] = useState(
    offered[0]?.value ?? ''
  );
  const organizationGroupId = useId();

  function chooseOrganization(next: ApprovalOrganization, nextShared: boolean): void {
    setOrganization(next);
    setShared(nextShared);
    const first = evidenceChoices.find((choice) => matchesOrganization(choice, next, nextShared));
    setSelectedEvidenceVersionId(first?.value ?? '');
    setEvidenceIdentifier(first?.autoEvidenceIdentifier ?? '');
  }
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
      <fieldset className="approval-organization" aria-describedby={organizationGroupId}>
        <legend style={{ fontSize: 13 }}>承認する組織<span style={{ color: 'var(--danger)' }}>（必須）</span></legend>
        {(['customer', 'seven'] as const).map((value) => (
          <label key={value} style={{ marginRight: 16 }}>
            <input
              type="radio"
              name="_approvalOrganization"
              value={value}
              checked={organization === value}
              onChange={() => chooseOrganization(value, shared)}
            />{' '}
            {ORGANIZATION_LABEL[value]}
          </label>
        ))}
        <p id={organizationGroupId} style={noteStyle}>
          選んだ組織が発行した承認証跡だけを表示します（顧客の承認は「顧客作成」、セブン化学の承認は「セブン化学」）。
        </p>
      </fieldset>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <FieldFeedback name="evidenceDocumentVersionId">
          {(versionFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%', flex: '0 1 380px' }}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>
                  承認証跡の書類バージョン<span style={{ color: 'var(--danger)' }}>（必須・{ORGANIZATION_LABEL[organization]}が発行した証跡）</span>
                </span>
                <select
                  name="evidenceDocumentVersionId"
                  required
                  aria-describedby={describedBy(versionFeedback.error ? versionFeedback.errorId : undefined)}
                  aria-invalid={versionFeedback.invalid}
                  data-feedback-label="承認証跡の書類バージョン"
                  autoComplete="off"
                  value={selectedEvidenceVersionId}
                  onChange={(event) => onEvidenceChange(event.target.value)}
                  style={{ ...inputStyle, width: '100%', maxWidth: 380 }}
                >
                  {offered.length === 0 ? <option value="">（この組織が発行した承認証跡がありません）</option> : null}
                  {offered.map((choice) => (
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
      <div className="shared-evidence" style={{ display: 'grid', gap: 6 }}>
        <label>
          <input
            type="checkbox"
            name="sharedEvidence"
            checked={shared}
            onChange={(event) => chooseOrganization(organization, event.target.checked)}
          />{' '}
          1通の証跡に両組織の承認が含まれている（例外。代表者の手動確認が必要になります）
        </label>
        {shared ? (
          <FieldFeedback name="sharedEvidenceReason">
            {(reasonFeedback) => (
              <div className="field" style={{ display: 'grid', gap: 4, maxWidth: 520 }}>
                <label style={labelOnly}>
                  <span style={{ fontSize: 13 }}>両組織で同じ証跡を使う理由<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                  <textarea
                    name="sharedEvidenceReason"
                    required
                    maxLength={1000}
                    rows={2}
                    aria-describedby={reasonFeedback.describedBy}
                    aria-invalid={reasonFeedback.invalid}
                    data-feedback-label="両組織で同じ証跡を使う理由"
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </label>
                <FieldError id={reasonFeedback.errorId} message={reasonFeedback.error} />
              </div>
            )}
          </FieldFeedback>
        ) : null}
      </div>
      <div className="form-actions">
        {/* Review M1: disabled until hydration, so neither button records an approval past the dialog. */}
        <SubmitLock>
          {(locked) => (
            <>
              <button
                type="submit"
                name="organization"
                value="customer"
                hidden={organization !== 'customer' || undefined}
                aria-disabled={pending || undefined}
                disabled={locked || undefined}
                style={{ ...buttonStyle, opacity: pending || locked ? 0.6 : 1 }}
              >
                顧客として承認する
              </button>
              <button
                type="submit"
                name="organization"
                value="seven"
                hidden={organization !== 'seven' || undefined}
                aria-disabled={pending || undefined}
                disabled={locked || undefined}
                style={{ ...buttonStyle, opacity: pending || locked ? 0.6 : 1 }}
              >
                セブン化学として承認する
              </button>
            </>
          )}
        </SubmitLock>
        <span style={noteStyle}>どちらの組織が先でも構いません。両組織の承認がそろうとダブル承認（校了）になります。</span>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
