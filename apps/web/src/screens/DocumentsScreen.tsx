import { orderPath } from '../lib/project-route';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { ViewerPageNotice } from '../components/RoleGate';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TechDetails } from '../components/TechDetails';
import { loadSessionUser } from '../lib/api';
import { canRoleOperate } from '../lib/permissions';
import { loadWorkspace } from '../lib/project-data';
import { shortId } from '../lib/short-id';
import {
  DOCUMENT_TYPE_LABELS,
  formatTimestamp,
  ISSUER_ENTITY_LABELS,
  VERIFICATION_STATUS_LABELS
} from '../lib/vocabulary';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../lib/redaction';
import { documentDownloadHref, downloadRefusalMessage } from '../lib/document-download';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

/**
 * Criterion 4: 文書. Upload posts contentBase64 (read in the browser) to
 * POST /api/projects/:projectId/documents, the list replays the document
 * audit history of the selected project, and the verify control calls
 * POST /api/documents/:id/verify with verificationStatus verified/mismatch.
 */
export async function DocumentsScreen(props: ProjectScreenProps & {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const { projectId, projectCode } = props;
  // UI batch F: a refused download comes back here with ?download=<reason>.
  // (Optional chaining on props too: the screen tests call the page without props.)
  const downloadNotice = downloadRefusalMessage((await props?.searchParams)?.download);

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="文書" reason={workspace.error} returnTo="/documents" />;
  const role = user?.role ?? null;
  // UI batch B (④): the 確認 column only for a role that may record it.
  const showVerifyColumn = canRoleOperate(role, 'document:verify');
  // UI batch F: download links only for a role the API lets read the files
  // (assigned staff, the representative); the API still decides each request.
  const canDownload = canRoleOperate(role, 'document:read');
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));

  const orderCodeOf = (orderId: string): string | null => workspace.filmOrders.find((order) => order.id === orderId)?.code ?? null;

  return (
    <section className="sx-11bfff5">
      <header>
        <h1 className="sx-15b888e">文書</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/documents" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        <p className="ui-note">
          発注書・見積書・校正ゲラ・各種証跡を案件に登録し、人の確認（確認済み／相違あり）を記録します。
          承認と納品確認で引用するのは、ここで登録した書類のバージョンです。
        </p>
        {workspace.error ? <div className="ui-info">{workspace.error}</div> : null}
        {downloadNotice ? <div className="ui-info" role="alert">{downloadNotice}</div> : null}
      </header>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">書類の登録と確認</h2>
        {/* P4 §0: the file of each step is registered in that step of the order screen (its type,
            issuer and links are fixed by the step); the checks are made there too. */}
        <p className="ui-note">
          書類は発注の画面の各手順で登録します（発注書・デザイン入稿データ・校正ゲラ・承認証跡・受領証跡）。種類と発行元は手順が決めるので、ここで選ぶ必要はありません。
          確認の記録も発注の画面（「その他の操作」の書類の確認、各手順）で行います。この一覧は閲覧用です。
        </p>
      </div>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">書類一覧</h2>
        <p className="ui-note">
          同じ（種別・発行主体・ファイル名）の書類に別の内容を送ると新しい版になります。版のIDは承認・納品確認で引用します。
        </p>
        <p className="ui-note">
          {canDownload
            ? '各版の「ダウンロード」で書類ファイルを保存できます（ダウンロードは記録されます）。'
            : role === null
              ? '役割を確認できないため、ダウンロードのリンクは表示していません。'
              : '閲覧者は書類ファイルをダウンロードできません（一覧の閲覧のみ）。'}
        </p>
        {workspace.documents.length === 0 ? (
          <p className="ui-note">書類はまだありません。</p>
        ) : (
          <DataTable caption="書類の一覧" captionHidden cards>
            <thead>
              <tr>
                <th className="ui-th" scope="col">書類種別</th>
                <th className="ui-th" scope="col">発行主体</th>
                <th className="ui-th" scope="col">ファイル名</th>
                <th className="ui-th" scope="col">紐付け</th>
                <th className="ui-th" scope="col">検証状態</th>
                <th className="ui-th" scope="col">登録</th>
                {showVerifyColumn ? <th className="ui-th" scope="col">発注の画面</th> : null}
              </tr>
            </thead>
            <tbody>
              {workspace.documents.map((document) => (
                <tr key={document.id} data-record-id={document.id}>
                  <td className="ui-td" data-label="書類種別">
                    {document.typeHidden
                      ? HIDDEN_BY_ROLE_LABEL
                      : DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS]
                        ?? document.documentType}
                    <TechDetails context="ID">{document.id}</TechDetails>
                  </td>
                  <td className="ui-td" data-label="発行主体">
                    {document.detailsHidden
                      ? HIDDEN_BY_ROLE_LABEL
                      : ISSUER_ENTITY_LABELS[document.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS]
                        ?? document.issuerEntity}
                  </td>
                  <td className="ui-td" data-label="ファイル名">
                    {document.filename}
                    {document.note ? <div className="ui-note">{document.note}</div> : null}
                    <details className="sx-c71373e">
                      <summary className="sx-9162155">
                        {/* UI batch A follow-up (P1-4): versions whose document link is
                            withheld cannot be counted here — never claim 「0件」. */}
                        {document.versions.length === 0 && workspace.documentVersionsWithheld
                          ? `版（${HIDDEN_BY_ROLE_SHORT}）`
                          : `版（${document.versions.length}件）`}
                      </summary>
                      {document.versions.map((version) => (
                        <div className="ui-mono" key={version.id}>
                          版{version.versionNumber}／{version.sha256
                            ? `${version.sha256.slice(0, 12)}…`
                            : version.sha256Hidden ? `ハッシュ ${HIDDEN_BY_ROLE_SHORT}` : 'ハッシュ未記録'}
                          {canDownload ? (
                            <>
                              {' '}
                              <a
                                href={documentDownloadHref(version.id)}
                                rel="nofollow"
                                aria-label={`${document.filename} 版${version.versionNumber}をダウンロード`}
                              >
                                ダウンロード
                              </a>
                            </>
                          ) : null}
                          <TechDetails context="版ID">{version.id}</TechDetails>
                        </div>
                      ))}
                    </details>
                  </td>
                  <td className="ui-td" data-label="紐付け">
                    {document.sevenPurchaseOrderId ? (
                      <div>セブン化学発注書: {poLabelById.get(document.sevenPurchaseOrderId) ?? shortId(document.sevenPurchaseOrderId)}</div>
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
                  <td className="status-cell ui-td" data-label="検証状態">
                    {document.verificationHidden
                      ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                      : (
                        <StatusBadge
                          domain="verification"
                          status={document.verificationStatus}
                          label={VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus}
                        />
                      )}
                    {document.verificationNote ? <div className="ui-note">{document.verificationNote}</div> : null}
                    {/* UI batch E (F-19): the send itself is confirmed on the maker PO screen, not here. */}
                    {document.documentType === 'send_evidence' && !document.verificationHidden && document.verificationStatus === 'unverified' ? (
                      <div className="ui-note">送信が確認済みかどうかは、発注の画面の手順9「メーカーへ送信」に表示されます（この欄は書類そのものの確認です）。</div>
                    ) : null}
                  </td>
                  <td className="ui-td" data-label="登録">{formatTimestamp(document.createdAt)}</td>
                  {showVerifyColumn ? (
                    <td className="ui-td" data-label="発注の画面">
                      {document.filmSupplyOrderId && orderCodeOf(document.filmSupplyOrderId) ? (
                        <a href={orderPath(projectCode, orderCodeOf(document.filmSupplyOrderId)!)} className="p4w2-row-link">
                          {document.verificationStatus === 'verified' ? '発注の画面を開く' : '発注の画面で確認する'}
                          <span className="visually-hidden">（{document.filename}）</span>
                        </a>
                      ) : <span className="ui-note">—</span>}
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
