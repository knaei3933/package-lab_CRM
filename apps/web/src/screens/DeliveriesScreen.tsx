import { orderPath } from '../lib/project-route';
import { FILM_DELIVERY_CONFIRMATION_LABELS } from '../components/DeliveryReceiptStep';
import { ActionForm } from '../components/ActionForm';
import { DeliveryRecordForm } from '../components/DeliveryRecordForm';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { RoleGate, ViewerPageNotice } from '../components/RoleGate';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TechDetails } from '../components/TechDetails';
import { SelectField, TextField } from '../components/fields';
import { confirmDeliveryAction, recordDeliveryAction } from '../app/actions';
import { loadSessionUser } from '../lib/api';
import { canRoleOperate } from '../lib/permissions';
import { labelLookup, loadWorkspace } from '../lib/project-data';
import { formatQuantityWithUnit } from '../lib/number-format';
import { isOwnEvidenceOfStaff } from '../lib/self-verification';
import { shortId } from '../lib/short-id';
import type { DeliveryView } from '../lib/project-data';
import { HIDDEN_BY_ROLE_LABEL } from '../lib/redaction';
import { formatTimestamp, READINESS_BLOCKING_LABELS, unitChoices, VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

/**
 * Criterion 6: 納品確認・手数料準備. Deliveries are listed with their
 * confirmation state (the Japanese labels come from GET /api/status-labels),
 * each pending one offers a confirm control that posts to the delivery
 * confirmation endpoints with a verified acceptance-evidence version, and the
 * commission readiness panel shows readinessState / isReady /
 * commissionCalculationAllowed / blocking in Japanese.
 */
export async function DeliveriesScreen({ projectId, projectCode }: ProjectScreenProps) {

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="納品確認・手数料準備" reason={workspace.error} returnTo="/deliveries" />;
  const role = user?.role ?? null;
  // UI batch B (④): the 確認 column only for a role that may record it.
  const showConfirmColumn = canRoleOperate(role, 'delivery_confirmation:record');
  const confirmationLabel = labelLookup(workspace.labels, 'fillingDeliveryConfirmationStates');
  const readinessStateLabel = labelLookup(workspace.labels, 'commissionReadinessStates');

  const orderCode = (orderId: string) =>
    workspace.filmOrders.find((order) => order.id === orderId)?.code
      ?? workspace.fillingOrders.find((order) => order.id === orderId)?.code
      ?? `発注 ${shortId(orderId)}`;
  /** UI batch A follow-up (P1-4): a withheld value reads 閲覧権限なし, a missing one 未記録. */
  const orderText = (delivery: DeliveryView) =>
    delivery.orderId ? orderCode(delivery.orderId) : delivery.detailsHidden ? HIDDEN_BY_ROLE_LABEL : '（発注未記録）';
  const hiddenOr = (delivery: DeliveryView, value: string) => (delivery.detailsHidden ? HIDDEN_BY_ROLE_LABEL : value);

  // Confirmation evidence: 受領証跡（acceptance_evidence）のうち人が確認済みの
  // バージョンだけが納品確認に使える。フィルム納品は発注への紐付けも一致が必要
  // （APIが検証するので、ここでは候補を絞り込んで提示する）。
  const acceptanceChoices = (delivery: DeliveryView) =>
    workspace.documents
      .filter((document) => document.documentType === 'acceptance_evidence'
        && document.verificationStatus === 'verified'
        && (delivery.kind === 'filling'
          || (delivery.orderId !== null && document.filmSupplyOrderId === delivery.orderId)))
      // P1 P-4: staff never confirm a delivery on a 受領証跡 version they uploaded (SELF_VERIFICATION_FORBIDDEN).
      .flatMap((document) => document.versions.filter((version) => !isOwnEvidenceOfStaff(role, user?.id ?? null, version.uploadedByUserId)).map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${shortId(version.id)}）`
      })));

  // P4 H14 ③: no filling order in the project = film only (the server's own rule, delivery-status filmOnly).
  const filmOnly = workspace.fillingOrders.length === 0;
  const filmOrderCode = (delivery: DeliveryView): string | null =>
    delivery.orderId ? workspace.filmOrders.find((order) => order.id === delivery.orderId)?.code ?? null : null;
  const fillingOrderOptions = workspace.fillingOrders.map((order) => ({
    id: order.id,
    code: order.code,
    lines: order.lines.map((line) => ({
      value: line.id,
      label: `明細${line.lineNumber}：${line.description}（${formatQuantityWithUnit(line.orderedQuantity, line.unit)}）`,
      unit: line.unit
    }))
  }));

  /** The cited evidence by its document name; the version id stays under 「詳細」. */
  const evidenceText = (versionId: string): string => {
    for (const document of workspace.documents) {
      const version = document.versions.find((candidate) => candidate.id === versionId);
      if (version) return `${document.filename}（版${version.versionNumber}）`;
    }
    return `書類バージョン ${shortId(versionId)}`;
  };

  const readiness = workspace.readiness;
  const readinessIsReady = readiness?.isReady === true;

  return (
    <section className="sx-11bfff5">
      <header>
        <h1 className="sx-15b888e">納品確認・手数料準備</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/deliveries" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        <p className="ui-note">
          納品行の受領を、確認済みの受領証跡を引用して確認します。すべての納品が確認できて
          セブン化学発注書の本登録がそろったとき、手数料計算の準備が整います（{readinessStateLabel('READY')}）。
        </p>
        {workspace.error ? <div className="ui-info">{workspace.error}</div> : null}
      </header>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">手数料計算の準備状態</h2>
        {readiness ? (
          <DataTable caption="手数料計算の準備状態" captionHidden>
            <tbody>
              <tr>
                <th className="ui-th" scope="row">準備状態</th>
                <td className="ui-td">
                  {readiness.hidden ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} /> : (
                    <>
                      <StatusBadge
                        domain="readiness"
                        status={readiness.readinessState}
                        label={readinessStateLabel(readiness.readinessState)}
                      />
                      <TechDetails context="コード">{readiness.readinessState}</TechDetails>
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <th className="ui-th" scope="row">準備完了</th>
                <td className="ui-td">{readiness.hidden ? HIDDEN_BY_ROLE_LABEL : readinessIsReady ? 'はい' : 'いいえ'}</td>
              </tr>
              <tr>
                <th className="ui-th" scope="row">手数料計算</th>
                <td className="ui-td">
                  {readiness.hidden ? HIDDEN_BY_ROLE_LABEL : readinessIsReady ? '可能です' : 'まだできません'}
                  <span className="ui-note">（「{readinessStateLabel('READY')}」のときだけ手数料計算ができます）</span>
                </td>
              </tr>
              <tr>
                <th className="ui-th" scope="row">未達の要件</th>
                <td className="ui-td">
                  {readiness.hidden
                    ? HIDDEN_BY_ROLE_LABEL
                    : readiness.blocking.length === 0
                    ? 'ありません'
                    : (
                      <ul className="sx-7857254">
                        {readiness.blocking.map((code) => (
                          <li key={code}>
                            {READINESS_BLOCKING_LABELS[code] ?? code}
                            <TechDetails context="コード">{code}</TechDetails>
                          </li>
                        ))}
                      </ul>
                    )}
                </td>
              </tr>
              <tr>
                <th className="ui-th" scope="row">評価日時</th>
                <td className="ui-td">{formatTimestamp(readiness.evaluatedAt)}</td>
              </tr>
            </tbody>
          </DataTable>
        ) : (
          <p className="ui-note">まだ評価されていません。発注の画面の手順12で受領証跡による納品確認をすると評価されます。</p>
        )}
        <div className="sx-9c9cee2">
          {/* P4 §0 / H14: the evaluation runs with the delivery confirmation on the order screen (step 12). */}
          <p className="ui-note">準備状態は、発注の画面（手順12 納品）で受領証跡による納品確認をすると評価し直されます。評価し直すボタンも手順12にあります。</p>
        </div>
      </div>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">納品 一覧と確認</h2>
        <p className="ui-note">
          確認には引用する受領証跡のバージョンが必須で、未確認の納品は手数料計算の準備を進めません。
        </p>
        {workspace.deliveries.length === 0 ? (
          <p className="ui-note">納品の記録はまだありません。</p>
        ) : (
          <DataTable caption="納品の一覧" captionHidden cards>
            <thead>
              <tr>
                <th className="ui-th" scope="col">種別</th>
                <th className="ui-th" scope="col">発注</th>
                <th className="ui-th" scope="col">数量／単位</th>
                <th className="ui-th" scope="col">連番</th>
                <th className="ui-th" scope="col">納品日</th>
                <th className="ui-th" scope="col">確認状態</th>
                <th className="ui-th" scope="col">引用した証跡</th>
                {showConfirmColumn ? <th className="ui-th" scope="col">確認</th> : null}
              </tr>
            </thead>
            <tbody>
              {workspace.deliveries.map((delivery) => (
                <tr key={delivery.id} data-record-id={delivery.id}>
                  <td className="ui-td" data-label="種別">{delivery.kind === 'film' ? 'フィルム納品' : '充填製品納品'}</td>
                  <td className="ui-td p4-nowrap" data-label="発注" translate="no">
                    {orderText(delivery)}
                    <TechDetails context="ID">{delivery.id}</TechDetails>
                  </td>
                  <td className="ui-td" data-label="数量／単位">{hiddenOr(delivery, formatQuantityWithUnit(delivery.deliveredQuantity, delivery.unit))}</td>
                  <td className="ui-td" data-label="連番">{hiddenOr(delivery, delivery.deliverySequence === null ? '未記録' : String(delivery.deliverySequence))}</td>
                  <td className="ui-td" data-label="納品日">{hiddenOr(delivery, delivery.deliveredAt ? formatTimestamp(delivery.deliveredAt) : '未記録')}</td>
                  <td className="status-cell ui-td" data-label="確認状態">
                    {delivery.confirmationHidden ? (
                      <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                    ) : (
                      <StatusBadge
                        domain="deliveryConfirmation"
                        status={delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION'}
                        label={delivery.kind === 'film'
                          // P4 H14 ②: a film delivery is never called 「充填製品の…」.
                          ? FILM_DELIVERY_CONFIRMATION_LABELS[delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION'].ja
                          : confirmationLabel(delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION')}
                      />
                    )}
                  </td>
                  <td className="ui-td" data-label="引用した証跡">
                    {delivery.confirmationHidden
                      ? HIDDEN_BY_ROLE_LABEL
                      : delivery.evidenceDocumentVersionId
                        ? (
                          <>
                            {evidenceText(delivery.evidenceDocumentVersionId)}
                            <TechDetails context="ID">{delivery.evidenceDocumentVersionId}</TechDetails>
                          </>
                        )
                        : '—'}
                    {delivery.confirmedAt ? <div>確認 {formatTimestamp(delivery.confirmedAt)}</div> : null}
                  </td>
                  {showConfirmColumn ? (
                    <td className="ui-td sx-576879f" data-label="確認">
                      {delivery.confirmed ? (
                        <span className="ui-note">確認済みです（確認は1回だけ記録できます）。</span>
                      ) : delivery.kind === 'film' ? (
                        // P4 §0 / H14: a film delivery is confirmed on the order screen (step 12, receipt evidence).
                        filmOrderCode(delivery) ? (
                          <a className="p4w2-row-link" href={orderPath(projectCode, filmOrderCode(delivery)!, 12)}>
                            発注の画面で確認する（手順12）<span className="visually-hidden">（{orderText(delivery)}）</span>
                          </a>
                        ) : <span className="ui-note">発注の画面で確認します。</span>
                      ) : (
                        <ActionForm
                          action={confirmDeliveryAction}
                          submitLabel="納品を確認する"
                          confirm={{
                            title: '納品を確認済みにしますか？',
                            body: `${orderText(delivery)} の納品を、選んだ受領証跡を引用して確認済みにします。確認は1回だけ記録でき、取り消せません。`,
                            summaryFields: ['evidenceDocumentVersionId', 'note']
                          }}
                          hint={
                            acceptanceChoices(delivery).length === 0
                              ? '確認済みの受領証跡がまだありません。充填発注の受領証跡を登録し、確認を記録してください。'
                              : undefined
                          }
                        >
                          <input type="hidden" readOnly name="kind" value={delivery.kind} />
                          <input type="hidden" readOnly name="deliveryId" value={delivery.id} />
                          <SelectField
                            name="evidenceDocumentVersionId"
                            label="受領証跡の書類バージョン（確認済みのみ）"
                            required
                            width={360}
                            choices={acceptanceChoices(delivery)}
                          />
                          <TextField name="note" label="確認メモ（任意）" width={220} />
                        </ActionForm>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">納品の記録</h2>
        <p className="ui-note">
          納品行の記録と受領の確認は別の操作です。記録だけでは準備状態は進まず、確認（証跡の引用）がそろって初めて進みます。
        </p>
        <h3 className="sx-3562d27">フィルム納品</h3>
        {/* P4 §0: a film delivery is recorded at step 12 of its order screen (with its receipt evidence). */}
        <p className="ui-note">フィルムの納品は、発注の画面の手順12「納品」で記録します（受領証跡があれば同時に確認できます）。</p>
        {filmOnly ? (
          // P4 H14 ③: a film-only project has no filling delivery to record.
          <p className="ui-note">この案件は充填発注がないため、フィルムのみの案件です（充填の納品は対象外）。</p>
        ) : (
          <>
            <hr className="sx-0682822" />
            <h3 className="sx-e6251b7">充填製品納品</h3>
            {/* P4 §0 exception: a filling order has no order screen yet, so its delivery is recorded here. */}
            <RoleGate role={role} operation="filling_delivery:create" label="充填製品納品の記録">
              <DeliveryRecordForm
                action={recordDeliveryAction}
                kind="filling"
                orders={fillingOrderOptions}
                unitChoices={unitChoices('filling')}
              />
            </RoleGate>
          </>
        )}
      </div>
    </section>
  );
}
