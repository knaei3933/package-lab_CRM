import type { Metadata } from 'next';
import { ActionForm } from '../../components/ActionForm';
import { DocumentUploadForm } from '../../components/DocumentUploadForm';
import { ProjectProgress } from '../../components/ProjectProgress';
import { RoleGate, ViewerPageNotice } from '../../components/RoleGate';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { TechDetails } from '../../components/TechDetails';
import { SelectField, TextField } from '../../components/fields';
import { uploadDocumentAction, verifyDocumentAction } from '../actions';
import { loadSessionUser, readSelectedProjectId } from '../../lib/api';
import { loadMakerPoChoices } from '../../lib/document-maker-po-server';
import { canRoleOperate } from '../../lib/permissions';
import { filmOrderChoiceLabel, labelLookup, loadWorkspace, NO_PROJECT_SELECTED_MESSAGE } from '../../lib/project-data';
import { shortId } from '../../lib/short-id';
import { cardStyle, infoBoxStyle, monoStyle, noteStyle, tdStyle, thStyle } from '../../lib/ui';
import {
  DOCUMENT_TYPE_LABELS,
  formatTimestamp,
  documentTypeChoices,
  contentTypeChoices,
  ISSUER_ENTITY_LABELS,
  issuerEntityChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../../lib/redaction';

export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: '文書' };

/**
 * Criterion 4: 文書. Upload posts contentBase64 (read in the browser) to
 * POST /api/projects/:projectId/documents, the list replays the document
 * audit history of the selected project, and the verify control calls
 * POST /api/documents/:id/verify with verificationStatus verified/mismatch.
 */
export default async function DocumentsPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>{NO_PROJECT_SELECTED_MESSAGE}</div>;
  }

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  const role = user?.role ?? null;
  // UI batch B (④): the 確認 column only for a role that may record it.
  const showVerifyColumn = canRoleOperate(role, 'document:verify');
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));

  const makerPurchaseOrderChoices = await loadMakerPoChoices(workspace.filmOrders);

  const verificationChoices = [
    { value: 'verified', label: VERIFICATION_STATUS_LABELS.verified ?? '確認済み' },
    { value: 'mismatch', label: VERIFICATION_STATUS_LABELS.mismatch ?? '相違あり' }
  ];

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>文書</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/documents" />
        <ViewerPageNotice role={role} />
        <p style={noteStyle}>
          発注書・見積書・校正ゲラ・各種証跡を案件に登録し、人の確認（確認済み／相違あり）を記録します。
          承認と納品確認で引用するのは、ここで登録した書類のバージョンです。
        </p>
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>書類をアップロードする</h2>
        <RoleGate role={role} operation="document:create" label="書類のアップロード">
          <p style={noteStyle}>
            セブン化学発注書は先行発注参照として記録される場合があります。正式書類（校正ゲラ・各種証跡）は、
            セブン発注書の公式登録と真性確認がすんでいる必要があります。
          </p>
          <DocumentUploadForm
            action={uploadDocumentAction}
            documentTypeChoices={documentTypeChoices()}
            issuerEntityChoices={issuerEntityChoices()}
            contentTypeChoices={contentTypeChoices()}
            sevenPurchaseOrderChoices={workspace.sevenPurchaseOrders.map((po) => ({ value: po.id, label: po.poNumber }))}
            makerPurchaseOrderChoices={makerPurchaseOrderChoices}
            filmSupplyOrderChoices={workspace.filmOrders.map((order) => ({
              value: order.id,
              label: filmOrderChoiceLabel(order, stateLabel)
            }))}
          />
        </RoleGate>
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>書類一覧</h2>
        <p style={noteStyle}>
          同じ（種別・発行主体・ファイル名）の書類に別の内容を送ると新しい版になります。版のIDは承認・納品確認で引用します。
        </p>
        {workspace.documents.length === 0 ? (
          <p style={noteStyle}>書類はまだありません。</p>
        ) : (
          <DataTable caption="書類の一覧" captionHidden>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>書類種別</th>
                <th scope="col" style={thStyle}>発行主体</th>
                <th scope="col" style={thStyle}>ファイル名</th>
                <th scope="col" style={thStyle}>紐付け</th>
                <th scope="col" style={thStyle}>検証状態</th>
                <th scope="col" style={thStyle}>登録</th>
                {showVerifyColumn ? <th scope="col" style={thStyle}>確認を記録する</th> : null}
              </tr>
            </thead>
            <tbody>
              {workspace.documents.map((document) => (
                <tr key={document.id}>
                  <td style={tdStyle}>
                    {document.typeHidden
                      ? HIDDEN_BY_ROLE_LABEL
                      : DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS]
                        ?? document.documentType}
                    <TechDetails context="ID">{document.id}</TechDetails>
                  </td>
                  <td style={tdStyle}>
                    {document.detailsHidden
                      ? HIDDEN_BY_ROLE_LABEL
                      : ISSUER_ENTITY_LABELS[document.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS]
                        ?? document.issuerEntity}
                  </td>
                  <td style={tdStyle}>
                    {document.filename}
                    {document.note ? <div style={noteStyle}>{document.note}</div> : null}
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ fontSize: 12, cursor: 'pointer' }}>
                        {/* UI batch A follow-up (P1-4): versions whose document link is
                            withheld cannot be counted here — never claim 「0件」. */}
                        {document.versions.length === 0 && workspace.documentVersionsWithheld
                          ? `版（${HIDDEN_BY_ROLE_SHORT}）`
                          : `版（${document.versions.length}件）`}
                      </summary>
                      {document.versions.map((version) => (
                        <div key={version.id} style={monoStyle}>
                          版{version.versionNumber}／{version.sha256
                            ? `${version.sha256.slice(0, 12)}…`
                            : version.sha256Hidden ? `ハッシュ ${HIDDEN_BY_ROLE_SHORT}` : 'ハッシュ未記録'}
                          <TechDetails context="版ID">{version.id}</TechDetails>
                        </div>
                      ))}
                    </details>
                  </td>
                  <td style={tdStyle}>
                    {document.sevenPurchaseOrderId ? (
                      <div>セブン発注書: {poLabelById.get(document.sevenPurchaseOrderId) ?? shortId(document.sevenPurchaseOrderId)}</div>
                    ) : null}
                    {document.filmSupplyOrderId ? (
                      <div>
                        フィルム発注: {workspace.filmOrders.find((order) => order.id === document.filmSupplyOrderId)?.code
                          ?? shortId(document.filmSupplyOrderId)}
                        {document.designKey ? <div>デザインキー: {document.designKey}</div> : null}
                      </div>
                    ) : null}
                    {!document.sevenPurchaseOrderId && !document.filmSupplyOrderId
                      ? document.detailsHidden
                        ? HIDDEN_BY_ROLE_LABEL
                        : '—'
                      : null}
                  </td>
                  <td style={tdStyle} className="status-cell">
                    {document.verificationHidden
                      ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                      : (
                        <StatusBadge
                          domain="verification"
                          status={document.verificationStatus}
                          label={VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus}
                        />
                      )}
                    {document.verificationNote ? <div style={noteStyle}>{document.verificationNote}</div> : null}
                  </td>
                  <td style={tdStyle}>{formatTimestamp(document.createdAt)}</td>
                  {showVerifyColumn ? (
                    <td style={{ ...tdStyle, minWidth: 'min(240px, 80vw)' }}>
                      <ActionForm
                        action={verifyDocumentAction}
                        submitLabel="確認を記録する"
                        hint="確認結果は書類ごとに上書き記録されます（実施者と日時も記録されます）。"
                        confirm={{
                          title: '書類の確認結果を記録しますか？',
                          body: `「${document.filename}」の確認結果を記録します。前の確認結果は上書きされ、実施者と日時が記録されます。`,
                          summaryFields: ['verificationStatus', 'verificationNote']
                        }}
                      >
                        <input type="hidden" readOnly name="documentId" value={document.id} />
                        <SelectField name="verificationStatus" label="確認結果" required choices={verificationChoices} width={180} />
                        <TextField name="verificationNote" label="確認メモ" width={220} />
                      </ActionForm>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </section>
  );
}
