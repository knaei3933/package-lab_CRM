import Link from 'next/link';
import { Bilingual } from '../components/Bilingual';
import { ViewerPageNotice } from '../components/RoleGate';
import { callApi, loadSessionUser } from '../lib/api';
import { documentTypeText, issuerText, loadEvidenceMetadata, shortHash } from '../lib/evidence-data';
import type { EvidenceDocumentView } from '../lib/evidence-data';
import { isAuditorRole, normalizeRole } from '../lib/permissions';
import { projectPath } from '../lib/project-route';
import { formatTimestamp, VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';
import type { ProjectScreenProps } from './screen-props';

/**
 * P2 P-2 (contract §7, DESIGN §7): /p/{案件}/evidence — the project's evidence
 * files as records: type, filename, order, version, short SHA-256, who filed it
 * and its check. Read only for every role: no form but the order filter (a GET
 * form that works without JS), no download link, and never the bytes, a path,
 * a note or an amount. A viewer is told the page is not theirs and no read is made.
 */
export const EVIDENCE_LIST_LIMIT = 200;

interface OrderOption { id: string; code: string }

async function loadOrderOptions(projectId: string): Promise<OrderOption[]> {
  const result = await callApi<{ orders: Array<{ id?: unknown; code?: unknown }> }>(`/api/projects/${encodeURIComponent(projectId)}/film-supply-orders`);
  if (!result.ok || !result.data || !Array.isArray(result.data.orders)) return [];
  return result.data.orders.flatMap((order) => (typeof order?.id === 'string' && typeof order.code === 'string' ? [{ id: order.id, code: order.code }] : []));
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export async function EvidenceScreen(props: ProjectScreenProps & {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const { projectId, projectCode } = props;
  const user = await loadSessionUser();
  if (!user) return null;
  const auditor = isAuditorRole(user.role);
  const role = normalizeRole(user.role);
  const title = <Bilingual ja="証跡の一覧" ko="증빙 목록" />;
  if (role === 'viewer' && !auditor) {
    return (
      <section className="p2-evidence" aria-labelledby="evidence-title">
        <h1 id="evidence-title" className="p1-title" tabIndex={-1}>{title}</h1>
        <p className="role-notice">閲覧者はこの画面を使えません。</p>
      </section>
    );
  }
  const filter = firstValue((await props.searchParams)?.filmSupplyOrderId);
  const [orders, read] = await Promise.all([
    loadOrderOptions(projectId),
    loadEvidenceMetadata(projectId, { filmSupplyOrderId: filter || null, limit: EVIDENCE_LIST_LIMIT })
  ]);
  const orderById = new Map(orders.map((order) => [order.id, order.code]));
  const filterCode = filter ? (orderById.get(filter) ?? null) : null;
  return (
    <section className="p2-evidence" aria-labelledby="evidence-title">
      <h1 id="evidence-title" className="p1-title" tabIndex={-1}>{title}</h1>
      <p className="p1-lead">
        この案件の証跡ファイルの記録です（新しい順）。ファイルの中身は表示しません。
        {auditor ? '見積書・セブン化学発注書のファイル名は非表示です。' : ''}
      </p>
      <ViewerPageNotice role={user.role} />
      <form method="get" className="p2-evidence-filter">
        <label className="p2-evidence-filter-field">
          <span>発注で絞り込む</span>
          <select name="filmSupplyOrderId" defaultValue={filter}>
            <option value="">すべての発注</option>
            {orders.map((order) => <option key={order.id} value={order.id}>{order.code}</option>)}
          </select>
        </label>
        <button type="submit" className="p1-button p1-button--quiet">絞り込む</button>
        {filter ? <Link className="p1-button p1-button--quiet" href={projectPath(projectCode, 'evidence')}>絞り込みを外す</Link> : null}
      </form>
      {read.ok === false ? (
        read.status === 403 ? (
          <p className="role-notice">この画面を使える権限がありません。</p>
        ) : (
          <p className="p1-banner p1-banner--error" role="alert">証跡の一覧を読み込めませんでした（{read.error}）。</p>
        )
      ) : (
        <>
          {read.data.truncated ? (
            <p className="field-warning" role="status"><span aria-hidden="true">⚠ </span>新しい順に{read.data.limit ?? EVIDENCE_LIST_LIMIT}件まで表示しています。古い証跡は発注で絞り込むと見られます。</p>
          ) : null}
          {read.data.documents.length === 0 ? (
            <p className="p1-muted">{filter ? `${filterCode ?? '選んだ発注'} の証跡はまだありません。` : 'この案件の証跡はまだありません。'}</p>
          ) : (
            <EvidenceTable documents={read.data.documents} />
          )}
        </>
      )}
    </section>
  );
}

const COLUMNS = ['文書の種類', 'ファイル名', '発注・デザイン', '版', 'SHA-256', '登録', '確認状態'] as const;

function EvidenceTable({ documents }: { documents: EvidenceDocumentView[] }) {
  return (
    <div className="table-scroll" role="region" aria-label="証跡の一覧" tabIndex={0}>
      <table className="p1-history p2-audit-history p2-evidence-table" role="table">
        <caption className="visually-hidden">証跡の一覧</caption>
        <thead role="rowgroup">
          <tr role="row">{COLUMNS.map((name) => <th key={name} scope="col" role="columnheader">{name}</th>)}</tr>
        </thead>
        <tbody role="rowgroup">
          {documents.map((doc) => {
            const latest = [...doc.versions].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))[0] ?? null;
            const filename = doc.filenameHidden ? null : (latest?.originalFilename ?? doc.originalFilename);
            const verified = doc.verificationStatus === 'verified';
            return (
              <tr key={doc.documentId} id={`doc-${doc.documentId}`} role="row">
                <td role="cell" data-label="文書の種類">
                  {documentTypeText(doc.documentType)}
                  <span className="p2-audit-sub p1-muted-inline">{issuerText(doc.issuerEntity)}</span>
                </td>
                <td role="cell" data-label="ファイル名" translate="no">{filename ?? <span className="p1-muted-inline">ファイル名は非表示</span>}</td>
                <td role="cell" data-label="発注・デザイン">
                  {doc.orderCode ? <span translate="no">{doc.orderCode}</span> : '—'}
                  {doc.designKey ? <span className="p2-audit-sub p1-muted-inline" translate="no">{doc.designKey}</span> : null}
                </td>
                <td role="cell" data-label="版">
                  {latest?.versionNumber != null ? `第${latest.versionNumber}版` : '—'}
                  {doc.versions.length > 1 ? (
                    <>
                      <span className="p2-audit-sub p1-muted-inline" aria-label={`版 ${doc.versions.length}件`}>版 {doc.versions.length}件</span>
                      <ol className="p2-evidence-versions">
                        {doc.versions.map((version) => (
                          <li key={version.versionId}>
                            第{version.versionNumber ?? '?'}版 ・ {version.uploadedAt ? formatTimestamp(version.uploadedAt) : '—'}
                            {shortHash(version.sha256) ? <span className="p1-hash" translate="no"> SHA-256 {shortHash(version.sha256)}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                </td>
                <td role="cell" data-label="SHA-256" className="p1-hash" translate="no">{shortHash(latest?.sha256 ?? null) ?? '—'}</td>
                <td role="cell" data-label="登録">
                  {doc.createdBy ?? latest?.uploadedBy ?? '—'}
                  <span className="p2-audit-sub p1-muted-inline p1-figure">{formatTimestamp(doc.createdAt ?? latest?.uploadedAt)}</span>
                </td>
                <td role="cell" data-label="確認状態">
                  {verified ? (VERIFICATION_STATUS_LABELS.verified ?? '確認済み') : doc.verificationStatus === 'mismatch' ? (VERIFICATION_STATUS_LABELS.mismatch ?? '相違あり') : '未確認'}
                  {verified && (doc.verifiedBy || doc.verifiedAt) ? (
                    <span className="p2-audit-sub p1-muted-inline p1-figure">{[doc.verifiedBy, doc.verifiedAt ? formatTimestamp(doc.verifiedAt) : null].filter(Boolean).join(' ・ ')}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
