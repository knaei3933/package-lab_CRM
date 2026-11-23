import { ActionForm } from './ActionForm';
import { ChangeRequestFields } from './ChangeRequestFields';
import type { ChangeEvidenceChoiceProps } from './ChangeRequestFields';
import { RoleGate } from './RoleGate';
import { StepFileField } from './StepFileField';
import { SelectField, TextField } from './fields';
import { registerArtworkRevisionAction } from '../app/actions';
import { uploadChangeProofStepAction } from '../app/step-actions';
import type { DocumentView, FilmSupplyOrderView, SevenPurchaseOrderView } from '../lib/project-data';
import { ARTWORK_REVISION_LIVE_PAPER_REFUSAL } from '../lib/maker-po-data';

/**
 * P4 §0: 「デザインを差し替える（変更依頼）」 on the order screen — the old 承認 screen's
 * 「校正ゲラの版を登録する」 (with the controlled change request, server R1-9 / F2),
 * scoped to one order. Two forms: register the replacement proof file, then the 版
 * with the change facts (依頼組織・理由・証憑・影響・実費・ロット表記). The API keeps
 * every rule: a design with approval history needs the change facts, live maker
 * paper blocks a new 版, a printed order needs the representative.
 */
export function DesignChangeForms({
  order,
  projectCode,
  po,
  role,
  designKeys,
  documents,
  historyKeys,
  printedOrderIds,
  evidenceChoices,
  livePapers = []
}: {
  /** Recheck 8 Low-5: the maker paper not cancelled (its names) — the API refuses a new 版 while one exists. */
  livePapers?: readonly string[];
  order: FilmSupplyOrderView;
  projectCode: string;
  po: SevenPurchaseOrderView | null;
  role: string | null;
  designKeys: readonly string[];
  documents: readonly DocumentView[];
  historyKeys: readonly string[];
  printedOrderIds: readonly string[];
  evidenceChoices: readonly ChangeEvidenceChoiceProps[];
}) {
  const designChoices = designKeys.map((key) => ({ value: key, label: key }));
  const proofChoices = documents
    .filter((document) => document.documentType === 'proof' && document.filmSupplyOrderId === order.id)
    .flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.designKey ?? 'デザイン未指定'}／${document.filename}（版${version.versionNumber}・登録 ${version.createdAt.slice(0, 10)}）`
    })))
    .reverse();
  if (livePapers.length > 0) {
    return (
      <RoleGate role={role} operation="artwork_revision:create" label="デザインの差し替え">
        <p className="role-notice">{`取り消されていないメーカー発注書（${livePapers.join('、')}）があります。`}{ARTWORK_REVISION_LIVE_PAPER_REFUSAL}</p>
      </RoleGate>
    );
  }
  return (
    <RoleGate role={role} operation="artwork_revision:create" label="デザインの差し替え">
      <p className="ui-note">
        承認の記録があるデザインを差し替えると、その承認は無効になり承認待ちに戻ります。差し替えは変更依頼として扱われ、
        依頼組織・変更理由・証憑・影響（納期／数量／金額）・実費（なければ0）・ロット表記の記録が必要です。
        取り消されていないメーカー発注書がある間は、版は登録できません。
      </p>
      {po ? (
        <ActionForm action={uploadChangeProofStepAction} submitLabel="差し替えの校正ゲラを登録する" submitContext={order.code} quiet>
          <input type="hidden" readOnly name="orderId" value={order.id} />
          <input type="hidden" readOnly name="orderCode" value={order.code} />
          <input type="hidden" readOnly name="projectCode" value={projectCode} />
          <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
          <SelectField name="designKey" label="差し替えるデザイン" required includeBlank blankLabel="（選ぶ）" choices={designChoices} width={240} />
          <StepFileField label="新しい校正ゲラのファイル" hint="5MBまで。形式はファイルから判別します。" />
        </ActionForm>
      ) : null}
      <ActionForm action={registerArtworkRevisionAction} submitLabel="版を登録する（変更依頼）" submitContext={order.code}>
        {/* The change fields read the order select and the design input of this form. */}
        <SelectField name="orderId" label="フィルム発注" required width={240} choices={[{ value: order.id, label: order.code }]} defaultValue={order.id} />
        <TextField name="designKey" label="差し替えるデザイン名" required width={240} hint={`登録済み: ${designKeys.join('・') || 'なし'}`} autoComplete="off" />
        <SelectField
          name="fileDocumentVersionId"
          label="版ファイル（この発注の校正ゲラ）"
          required
          includeBlank
          blankLabel="（選ぶ）"
          width={420}
          choices={proofChoices}
        />
        <TextField name="lotMarking" label="ロット表記（変更依頼では必須）" width={240} />
        <TextField name="note" label="備考（任意）" width={320} />
        <ChangeRequestFields
          historyKeys={historyKeys}
          printedOrderIds={printedOrderIds}
          evidenceChoices={evidenceChoices}
          canRecordPrinted={role === 'admin'}
        />
      </ActionForm>
    </RoleGate>
  );
}
