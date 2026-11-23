import { ActionForm } from './ActionForm';
import { KoGloss } from './RenderedContext';
import { EvidenceLineText, hasEvidenceWarning, SenderFromLine, SenderStatusNote, SenderWarningNotes } from './EvidenceFacts';
import { StatusBadge } from './StatusBadge';
import { TechDetails } from './TechDetails';
import { SelectField, TextField } from './fields';
import { verifyEvidenceManualAction } from '../app/actions';
import { operationRefusal } from '../lib/permissions';
import { declarationLineOf } from '../lib/sender-check';
import type { PendingManualVerificationView } from '../lib/project-data';
import { formatTimestamp, ISSUER_ENTITY_LABELS } from '../lib/vocabulary';
import type { IssuerEntity } from '@kanei/core';
import type { Choice } from '../lib/types';

/**
 * P4 §0: the representative's manual check of PDF / image approval evidence —
 * moved out of the old 承認 screen (ApprovalsScreen) so step 6 of the order
 * screen records it in place (it used to link to /approvals#manual-verification).
 * Same server action (POST /api/artwork-approval-events/:id/manual-verification).
 * `readOnly` (the old list) shows the facts and where the check is recorded, no form.
 */

/** The result select of the verification form. */
/** P0 R02: a mismatched issuer without the declared exception can only be rejected (the API refuses 「確認」). */
/** P0 review (EVIDENCE_REQUIRES_REPLACEMENT): an older held-back approval is re-recorded, not checked. */
const REPLACEMENT_GUIDANCE =
  'この承認は確認の記録ができない古い記録です。この発注の画面の手順6「校了」で、この組織が発行した承認証跡を登録して承認を記録し直してください。';

const REJECT_ONLY_CHOICES: Choice[] = [{ value: 'rejected', label: '却下（発行元が承認する組織と違う／確認できなかった）' }];

/**
 * P0 R02 (B2): the facts the representative checks before 「確認」, spelled out —
 * the evidence's issuer, the organization approving, whether they match, the
 * shared-evidence exception and its reason, and whether 「確認」 is possible.
 */
export function EvidenceIssuerCheck({
  entry,
  organizationText
}: {
  entry: PendingManualVerificationView;
  organizationText: (key: string) => string;
}) {
  const issuer = entry.evidenceIssuerEntity ? ISSUER_ENTITY_LABELS[entry.evidenceIssuerEntity as IssuerEntity] ?? '（不明）' : '（記録なし）';
  const expected = entry.expectedIssuerEntity ? ISSUER_ENTITY_LABELS[entry.expectedIssuerEntity as IssuerEntity] ?? '（不明）' : '—';
  const matches = entry.issuerMatchesOrganization;
  const declaration = declarationLineOf(entry);
  const warnings = entry.warnings ?? [];
  return (
    <dl className={`issuer-check${hasEvidenceWarning(declaration, entry) ? ' issuer-check--warning' : ''}`} data-evidence-facts="server">
      <div>
        <dt>承認する組織</dt>
        <dd>{organizationText(entry.organization)}</dd>
      </div>
      <div>
        <dt>証跡の発行元</dt>
        <dd>{issuer}</dd>
      </div>
      <div>
        <dt>照合</dt>
        <dd data-reconciliation={declaration?.code ?? 'none'}>
          {matches === false ? (
            <>
              <StatusBadge tone="blocked" label="不一致" />
              {` 必要な発行元: ${expected}`}
            </>
          ) : declaration ? (
            // p4/web4 (server2 §13): the server's own line — 「申告どおり」 only when it judged the mail's From too.
            <EvidenceLineText line={declaration} kind="declaration" />
          ) : (
            '（照合結果なし）'
          )}
        </dd>
      </div>
      {entry.fromAddress || entry.senderVerdict || (!entry.senderVerdict && entry.senderStatus) ? (
        <div>
          <dt>差出人</dt>
          <dd>
            <SenderFromLine facts={entry} className="p4w4-sender" />
            <SenderStatusNote facts={entry} className="p4w4-sender" />
          </dd>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div>
          <dt>注意</dt>
          <dd><SenderWarningNotes warnings={warnings} className="p4w4-warning" /></dd>
        </div>
      ) : null}
      <div>
        <dt>識別子</dt>
        <dd translate="no">{entry.evidenceIdentifier ?? '（記録なし）'}</dd>
      </div>
      {entry.sameContentUsedByOtherOrganization ? (
        <div>
          <dt>内容の重複</dt>
          <dd>もう一方の組織の承認と同じ内容の証跡です（同じ書類またはまったく同じファイル）。共有証跡の例外がなければ数えられません。</dd>
        </div>
      ) : null}
      {entry.sharedEvidenceException ? (
        <div>
          <dt>共有証跡の例外</dt>
          <dd>あり（理由: {entry.sharedEvidenceException.reason ?? '記録なし'}）</dd>
        </div>
      ) : null}
      {entry.confirmable ? null : (
        <div>
          <dt>確認</dt>
          <dd>発行元が承認する組織と違うため「確認」は記録できません。「却下」を記録し、その組織が発行した承認証跡を登録し直してください。</dd>
        </div>
      )}
    </dl>
  );
}

const VERIFICATION_RESULT_CHOICES: Choice[] = [
  { value: 'confirmed', label: '確認（識別子を原本証跡で確認した）' },
  { value: 'rejected', label: '却下（確認できなかった）' }
];

/**
 * M8-OPER2 FIX 2: the pending evidence verifications of one order. Admin sees
 * the original evidence (원본 증빙) next to the proof revision it is checked
 * against (교정본) and records the append-only verification; every other role
 * reads why the approval is not counting yet and waits for the representative.
 */
export function PendingVerificationSection({
  pending,
  role,
  canVerify,
  evidenceLabel,
  organizationText,
  readOnly = false,
  recordHref = null
}: {
  pending: PendingManualVerificationView[];
  role: string | null;
  canVerify: boolean;
  evidenceLabel: (versionId: string | null) => string;
  organizationText: (key: string) => string;
  /** P4 §0: the old list — the facts only; the check is recorded on the order screen (recordHref). */
  readOnly?: boolean;
  recordHref?: string | null;
}) {
  return (
    <div className="sx-1f27ed4">
      <h3 className="sx-e6251b7">
        承認証跡の手動確認（PDF・画像の識別子確認）— {pending.length}件
      </h3>
      <p className="ui-note">
        バイナリ証跡（PDF・画像）の承認は、識別子を自動検証できないため手動確認待ちとして記録されます。
        確認が記録されるまで両組織の承認には算入されません。確認の記録は代表者だけです。
      </p>
      {pending.map((entry) => (
        <div className="sx-045aac8" key={entry.approvalEventId}>
          <div className="ui-info sx-ab544d4">
            <StatusBadge tone="waiting" label="手動確認待ち" /><KoGloss ko="수동 확인 대기" />{' '}
            <strong>{organizationText(entry.organization)}</strong> の承認（デザイン {entry.designKey}／版
            {entry.revisionNo}）は手動確認待ちです。
            <EvidenceIssuerCheck entry={entry} organizationText={organizationText} />
            <div className="ui-note">
              原本証跡: {evidenceLabel(entry.evidenceDocumentVersionId)}
              <TechDetails context="ID・識別子">
                <p>証跡バージョンID: {entry.evidenceDocumentVersionId ?? '—'}</p>
                <p>承認証跡識別子: {entry.evidenceIdentifier ?? '—'}</p>
                <p>版ハッシュ（approved_file_sha256）: {entry.approvedFileSha256}</p>
              </TechDetails>
              確認対象の校正: デザイン {entry.designKey} ／ 版{entry.revisionNo} ／{' '}
              {formatTimestamp(entry.eventTime)} 承認（記録 {formatTimestamp(entry.recordedAt)}）
              {entry.manualVerification ? (
                <div>
                  前回の確認: {entry.manualVerification.result === 'confirmed' ? '確認' : '却下'} ／ 検証者{' '}
                  {entry.manualVerification.verifierName} ／ {formatTimestamp(entry.manualVerification.verifiedAt)}
                </div>
              ) : null}
            </div>
          </div>
          {canVerify && !entry.recordedAsPending ? (
            <p className="role-notice">{REPLACEMENT_GUIDANCE}</p>
          ) : null}
          {readOnly ? (
            <p className="ui-note">
              {recordHref ? <a href={recordHref}>発注の画面（手順6 校了）で確認を記録する</a> : '確認は発注の画面（手順6 校了）で記録します。'}
            </p>
          ) : canVerify && entry.recordedAsPending ? (
            <ActionForm
              action={verifyEvidenceManualAction}
              submitLabel="手動確認を記録する"
              submitLabelKo="수동 확인을 기록"
              submitContext={`${organizationText(entry.organization)}・デザイン ${entry.designKey}`}
              hint="確認の記録は新しい追記型イベントです。元の承認イベントとその監査記録は書き換えられません。"
              hintKo="확인 기록은 새로 추가되는 이벤트입니다. 원래의 승인 이벤트와 감사 기록은 수정되지 않습니다."
              confirm={{
                title: '承認証跡の手動確認を記録しますか？',
                body: `${organizationText(entry.organization)} の承認（デザイン ${entry.designKey}／版${entry.revisionNo}）に、選んだ結果を記録します。「確認」は両組織の承認に算入されます。記録は追記型で、あとから書き換えられません。`,
                summaryFields: ['result', 'reasonNote']
              }}
            >
              <input type="hidden" readOnly name="approvalEventId" value={entry.approvalEventId} />
              <div className="sx-f11b79b">
                {/* P0 R11 (M3): the API records the signed-in representative and the server time. */}
                <SelectField
                  name="result"
                  label="結果"
                  required
                  width={320}
                  choices={entry.confirmable ? VERIFICATION_RESULT_CHOICES : REJECT_ONLY_CHOICES}
                />
                <TextField
                  name="reasonNote"
                  label="根拠（原本証跡のどこで識別子を確認したか）"
                  required
                  width={420}
                />
              </div>
            </ActionForm>
          ) : (
            <p className="role-notice">
              次のアクション: 代表者による原本証跡の確認を待ちます。<KoGloss ko="다음 작업: 대표의 원본 증빙 확인을 기다립니다." />{operationRefusal(role, 'artwork_approval:verify_evidence', '手動確認の記録')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

