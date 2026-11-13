import { ActionForm } from '../../components/ActionForm.js';
import { DocumentUploadForm } from '../../components/DocumentUploadForm.js';
import { SelectField, TextField } from '../../components/fields.js';
import { uploadDocumentAction, verifyDocumentAction } from '../actions.js';
import { readSelectedProjectId } from '../../lib/api.js';
import { labelLookup, loadWorkspace } from '../../lib/project-data.js';
import {
  cardStyle,
  infoBoxStyle,
  monoStyle,
  noteStyle,
  tableStyle,
  tdStyle,
  thStyle
} from '../../lib/ui.js';
import {
  DOCUMENT_TYPE_LABELS,
  formatTimestamp,
  documentTypeChoices,
  contentTypeChoices,
  ISSUER_ENTITY_LABELS,
  issuerEntityChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary.js';

export const dynamic = 'force-dynamic';

/**
 * Criterion 4: 文書. Upload posts contentBase64 (read in the browser) to
 * POST /api/projects/:projectId/documents, the list replays the document
 * audit history of the selected project, and the verify control calls
 * POST /api/documents/:id/verify with verificationStatus verified/mismatch.
 */
export default async function DocumentsPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const workspace = await loadWorkspace(projectId);
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));

  const verificationChoices = [
    { value: 'verified', label: VERIFICATION_STATUS_LABELS.verified ?? '確認済み' },
    { value: 'mismatch', label: VERIFICATION_STATUS_LABELS.mismatch ?? '相違あり' }
  ];

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>文書</h1>
        <p style={noteStyle}>
          発注書・見積書・校正ゲラ・各種証跡を案件に登録し、人の確認（確認済み／相違あり）を記録します。
          承認と納品確認で引用するのは、ここで登録した書類のバージョンです。
        </p>
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>書類をアップロードする</h2>
        <p style={noteStyle}>
          セブン化学発注書（seven_po）は先行発注参照として記録される場合があります。正式書類（校正ゲラ・各種証跡）は、
          セブン発注書の公式登録と真性確認がすんでいる必要があります。
        </p>
        <DocumentUploadForm
          action={uploadDocumentAction}
          documentTypeChoices={documentTypeChoices()}
          issuerEntityChoices={issuerEntityChoices()}
          contentTypeChoices={contentTypeChoices()}
          sevenPurchaseOrderChoices={workspace.sevenPurchaseOrders.map((po) => ({ value: po.id, label: po.poNumber }))}
          filmSupplyOrderChoices={workspace.filmOrders.map((order) => ({
            value: order.id,
            label: `${order.code}（${stateLabel(order.status)}）`
          }))}
        />
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>書類一覧</h2>
        <p style={noteStyle}>
          同じ（種別・発行主体・ファイル名）の書類に別の内容を送ると新しい版になります。版のIDは承認・納品確認で引用します。
        </p>
        {workspace.documents.length === 0 ? (
          <p style={noteStyle}>書類はまだありません。</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>書類種別</th>
                <th style={thStyle}>発行主体</th>
                <th style={thStyle}>ファイル名</th>
                <th style={thStyle}>紐付け</th>
                <th style={thStyle}>検証状態</th>
                <th style={thStyle}>登録</th>
                <th style={thStyle}>確認を記録する</th>
              </tr>
            </thead>
            <tbody>
              {workspace.documents.map((document) => (
                <tr key={document.id}>
                  <td style={tdStyle}>
                    {DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS]
                      ?? document.documentType}
                    <div style={monoStyle}>{document.id}</div>
                  </td>
                  <td style={tdStyle}>
                    {ISSUER_ENTITY_LABELS[document.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS]
                      ?? document.issuerEntity}
                  </td>
                  <td style={tdStyle}>
                    {document.filename}
                    {document.note ? <div style={noteStyle}>{document.note}</div> : null}
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ fontSize: 12, cursor: 'pointer' }}>版（{document.versions.length}件）</summary>
                      {document.versions.map((version) => (
                        <div key={version.id} style={monoStyle}>
                          版{version.versionNumber}／{version.sha256.slice(0, 12)}…／ID {version.id}
                        </div>
                      ))}
                    </details>
                  </td>
                  <td style={tdStyle}>
                    {document.sevenPurchaseOrderId ? (
                      <div>セブン発注書: {poLabelById.get(document.sevenPurchaseOrderId) ?? document.sevenPurchaseOrderId}</div>
                    ) : null}
                    {document.filmSupplyOrderId ? (
                      <div>
                        フィルム発注: {workspace.filmOrders.find((order) => order.id === document.filmSupplyOrderId)?.code
                          ?? document.filmSupplyOrderId}
                        {document.designKey ? <div>デザインキー: {document.designKey}</div> : null}
                      </div>
                    ) : null}
                    {!document.sevenPurchaseOrderId && !document.filmSupplyOrderId ? '—' : null}
                  </td>
                  <td style={tdStyle}>
                    {VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus}
                    {document.verificationNote ? <div style={noteStyle}>{document.verificationNote}</div> : null}
                  </td>
                  <td style={tdStyle}>{formatTimestamp(document.createdAt)}</td>
                  <td style={{ ...tdStyle, minWidth: 240 }}>
                    <ActionForm
                      action={verifyDocumentAction}
                      submitLabel="確認を記録する"
                      hint="確認結果は書類ごとに上書き記録されます（実施者と日時も記録されます）。"
                    >
                      <input type="hidden" readOnly name="documentId" value={document.id} />
                      <SelectField name="verificationStatus" label="確認結果" required choices={verificationChoices} width={180} />
                      <TextField name="verificationNote" label="確認メモ" width={220} />
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
