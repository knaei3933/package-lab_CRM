import Link from 'next/link';
import type { ReactNode } from 'react';
import { newOrderPath, orderPath, scopeHref } from '../lib/project-route';
import { READ_ONLY_LISTS } from '../lib/navigation';
import { STEP_COUNT, stepForStatus } from '../lib/order-flow';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../components/AstryxIsland';
import { EmptyNote } from '../components/EmptyNote';
import { OrderCreateForm } from '../components/OrderCreateForm';
import { RepresentativeQueuePanel } from '../components/RepresentativeQueue';
import { failedRepresentativeQueue, loadRepresentativeQueue } from '../lib/representative-queue';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { RoleGate, ViewerPageNotice } from '../components/RoleGate';
import { TechDetails } from '../components/TechDetails';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { createFillingOrderAction } from '../app/actions';
import { loadSessionUser } from '../lib/api';
import { PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import { canRoleOperate } from '../lib/permissions';
import {
  knownStatus,
  labelLookup,
  loadSelectableProjectList,
  loadWorkspace,
  officialRegistrationText,
  sevenPurchaseOrderChoiceLabel,
  UNLINKED_ORDER_REMEDY
} from '../lib/project-data';
import type { FilmSupplyOrderView } from '../lib/project-data';
import { holdSummaryText, paymentTermsText } from '../lib/decision-facts';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../lib/redaction';
import { formatTimestamp, unitChoices, VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';
import { formatQuantityWithUnit } from '../lib/number-format';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

//** Astryx trial: the empty note when the workspace read failed (the Banner above says why). */
const LOAD_FAILED_NOTE = '一覧を表示できませんでした。画面上部の案内を確認してください。';

/** UI batch E (F-23): the queue of every project but the open one; a failed list read says so (review M1). */
async function representativeQueueFor(openProjectId: string | null) {
  const list = await loadSelectableProjectList();
  if (list.error) return failedRepresentativeQueue(list.error);
  // P4 H3: the server's own queue (it holds the manual checks the web's status replay misses); the web replay is the fallback.
  return loadRepresentativeQueue(list.projects.filter((project) => project.id !== openProjectId), { server: true });
}

export async function OrdersScreen({ projectId, projectCode }: ProjectScreenProps) {
  // UI batch E (F-23, review M3): the other projects' waiting decisions (this project's are in
  // 「次にやること」 below), read alongside the workspace, admin only.
  const [user, workspace, representativeQueue] = await Promise.all([
    loadSessionUser(),
    loadWorkspace(projectId),
    loadSessionUser().then((who) => (who?.role === 'admin' ? representativeQueueFor(projectId) : null))
  ]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="発注の一覧" reason={workspace.error} returnTo="/orders" />;
  const role = user?.role ?? null;
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const readinessLabel = labelLookup(workspace.labels, 'commissionReadinessStates');
  // UI batch B (④): the 操作 column only when the role has a form to show in it.
  const showOrderOperations = canRoleOperate(role, 'film_order:transition');
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));
  const poChoices = workspace.sevenPurchaseOrders.map((po) => ({
    value: po.id,
    label: sevenPurchaseOrderChoiceLabel(po)
  }));

  // A failed read leaves the lists empty: then say so, never 「まだありません」 + "create one".
  const loadFailed = Boolean(workspace.error);
  const canCreateFilmOrder = canRoleOperate(role, 'film_order:create');
  const canCreateFillingOrder = canRoleOperate(role, 'filling_order:create');

  // Astryx trial: this screen is an Astryx island (DESIGN_RULES §1). The tables,
  // status badges and forms are still ours — their markup is the tested contract.
  return (
    <AstryxIsland>
    <VStack as="section" gap={5}>
      <header>
        <Heading level={1}>発注の一覧</Heading>
        <ProjectProgress workspace={workspace} role={role} currentPath="/orders" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        {workspace.project ? (
          <Text as="p" type="supporting">
            案件 {workspace.project.code}（{workspace.project.name}）／ ルート {workspace.project.route}
          </Text>
        ) : (
          <TechDetails context="案件ID">{projectId}</TechDetails>
        )}
        {workspace.error ? <Banner status="error" title={workspace.error} /> : null}
        {/* P4 §0: the other read-only lists (not in the menu any more). */}
        <nav className="p4w2-lists" aria-label="ほかの一覧（閲覧）">
          {READ_ONLY_LISTS.map((list) => <Link key={list.href} href={scopeHref(projectCode, list.href)}>{list.label}</Link>)}
        </nav>
        {representativeQueue && (representativeQueue.tasks.length > 0 || representativeQueue.listError) ? (
          <details className="progress-completed sx-9c9cee2">
            <summary>ほかの案件の代表者の対応待ち（{representativeQueue.tasks.length}件）</summary>
            <RepresentativeQueuePanel queue={representativeQueue} currentProjectId={projectId} />
          </details>
        ) : null}
      </header>

      <SevenPurchaseOrderSection
        orders={workspace.sevenPurchaseOrders}
        poChoices={poChoices}
        verificationLabel={VERIFICATION_STATUS_LABELS}
        role={role}
        loadFailed={loadFailed}
        filmOrders={workspace.filmOrders}
        projectCode={projectCode}
      />

      <Card>
        <VStack gap={3}>
        <Heading level={2}>フィルム発注 一覧</Heading>
        <Text as="p" type="supporting">
          この一覧は閲覧用です。記録・状態の変更・保留や取消は、行の「発注の画面」で行います。
        </Text>
        {workspace.filmOrders.length === 0 ? (
          loadFailed ? <EmptyNote title={LOAD_FAILED_NOTE} next={null} /> : <EmptyNote title="フィルム発注はまだありません" next={canCreateFilmOrder ? '下の「新しいフィルム発注を登録する」で登録します。' : null} />
        ) : (
          <DataTable caption="フィルム発注の一覧" captionHidden cards>
            <thead>
              <tr>
                <th className="ui-th" scope="col">発注コード</th>
                <th className="ui-th" scope="col">状態</th>
                <th className="ui-th" scope="col">セブン化学発注書</th>
                <th className="ui-th" scope="col">支払条件</th>
                <th className="ui-th" scope="col">明細</th>
                <th className="ui-th" scope="col">作成</th>
                <th className="ui-th" scope="col">更新</th>
                {showOrderOperations ? <th className="ui-th" scope="col">発注の画面</th> : null}
              </tr>
            </thead>
            <tbody>
              {workspace.filmOrders.map((order) => {
                const status = knownStatus(order);
                return (
                  // UI nav-dashboard: the dashboard links to this row (#order-<id>).
                  <tr key={order.id} id={`order-${order.id}`} data-record-id={order.id} className="anchor-target">
                    <Td label="発注コード" className="p4-nowrap" translate="no">
                      {order.code}
                      <TechDetails context="ID">{order.id}</TechDetails>
                    </Td>
                    <td className="status-cell ui-td" data-label="状態">
                      {status === null
                        ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                        : <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} />}
                      {status === 'ON_HOLD' && order.hold ? <div className="ui-note">{holdSummaryText(order.hold)}</div> : null}
                    </td>
                    <td className="ui-td" data-label="セブン化学発注書">
                      {order.sevenPurchaseOrderId
                        ? poLabelById.get(order.sevenPurchaseOrderId) ?? '紐付けあり'
                        : order.detailsHidden
                          ? HIDDEN_BY_ROLE_LABEL
                          : '紐付けなし'}
                      {/* UI batch E (F-05): an unlinked draft cannot leave DRAFT — say what to do. */}
                      {!order.sevenPurchaseOrderId && !order.detailsHidden && status === 'DRAFT' ? (
                        <p className="role-notice">
                          {`この発注は「${stateLabel('SEVEN_PO_VERIFIED')}」へ進められません。${UNLINKED_ORDER_REMEDY(stateLabel)}。`}
                        </p>
                      ) : null}
                    </td>
                    {/* UI batch E3: the 支払条件 is shown to every role (amounts are not). */}
                    <td className="ui-td" data-label="支払条件">
                      {paymentTermsText(order)}
                      {/* P0 R01 (P-5): the change history stays readable after the 代表承認 too. */}
                      <PaymentTermsHistory order={order} />
                    </td>
                    <td className="ui-td" data-label="明細">
                      <OrderLinesCell order={order} />
                    </td>
                    <td className="ui-td" data-label="作成">{formatTimestamp(order.createdAt)}</td>
                    <td className="ui-td" data-label="更新">{formatTimestamp(order.updatedAt)}</td>
                    {showOrderOperations ? (
                      <Td label="発注の画面">
                        {/* P4 §0: every record of the order is made on its own screen (this list only reads). */}
                        <OrderScreenLink projectCode={projectCode} order={order} status={status} />
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
        </VStack>
      </Card>

      <Card>
        <VStack gap={3}>
        <Heading level={2}>新しいフィルム発注</Heading>
        <RoleGate role={role} operation="film_order:create" label="フィルム発注の作成">
          {/* P4 §0: the wizard registers the セブン化学発注書, its 照合 and the order in one submit. */}
          <p><Link className="p1-button p1-button--primary" href={newOrderPath(projectCode)}>新しいフィルム発注を登録する</Link></p>
          <Text as="p" type="supporting">セブン化学発注書の受付・照合と、発注内容（明細・支払条件）を1つの画面で登録します。登録済みの発注書に追加することもできます。</Text>
        </RoleGate>
        </VStack>
      </Card>

      <Card>
        <VStack gap={3}>
        <Heading level={2}>充填発注 一覧・作成</Heading>
        <Text as="p" type="supporting">
          充填製品（カプセル等）の発注です。単位はポッド／個。納品の確認状態は「納品確認・手数料準備」画面で扱います
          （準備状態: {workspace.readiness?.hidden
            ? HIDDEN_BY_ROLE_SHORT
            : readinessLabel(workspace.readiness?.readinessState ?? 'MISSING_DATA')}）。
        </Text>
        {workspace.fillingOrders.length === 0 ? (
          loadFailed ? <EmptyNote title={LOAD_FAILED_NOTE} next={null} /> : <EmptyNote title="充填発注はまだありません" next={canCreateFillingOrder ? '下のフォームで作成します。' : null} />
        ) : (
          <DataTable caption="充填発注の一覧" captionHidden>
            <thead>
              <tr>
                <th className="ui-th" scope="col">発注コード</th>
                <th className="ui-th" scope="col">明細</th>
                <th className="ui-th" scope="col">作成</th>
              </tr>
            </thead>
            <tbody>
              {workspace.fillingOrders.map((order) => (
                <tr key={order.id} id={`filling-order-${order.id}`} data-record-id={order.id} className="anchor-target">
                  <td className="ui-td">
                    {order.code}
                    <TechDetails context="ID">{order.id}</TechDetails>
                  </td>
                  <td className="ui-td">
                    {order.lines.length === 0 && order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : null}
                    {order.lines.map((line) => (
                      <div key={line.id}>
                        {line.lineNumber}. {line.description} ／ {formatQuantityWithUnit(line.orderedQuantity, line.unit)}
                        <TechDetails context="明細ID">{line.id}</TechDetails>
                      </div>
                    ))}
                  </td>
                  <td className="ui-td">{formatTimestamp(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <Divider />
        {/* P4 §0 exception: a filling order has no order screen of its own yet, so its creation stays here. */}
        <RoleGate role={role} operation="filling_order:create" label="充填発注の作成">
          <details className="collapsed-card">
            <summary>充填発注を作成する</summary>
            <OrderCreateForm action={createFillingOrderAction} orderKind="filling" unitChoices={unitChoices('filling')} />
          </details>
        </RoleGate>
        </VStack>
      </Card>
    </VStack>
    </AstryxIsland>
  );
}

/** P4 M12: a table cell that carries its column name, so the 390px card layout can label it. */
function Td({ label, className, translate, children }: { label: string; className?: string; translate?: 'no'; children: ReactNode }) {
  return <td className={className ? `ui-td ${className}` : 'ui-td'} data-label={label} translate={translate}>{children}</td>;
}

/** P4 §0: where the order's next record is made — its own screen, at its current step. */
function OrderScreenLink({ projectCode, order, status }: { projectCode: string; order: FilmSupplyOrderView; status: string | null }) {
  const step = status === null ? null : stepOfStatus(status);
  return (
    <a href={orderPath(projectCode, order.code, step)} className="p4w2-row-link">
      {step === null ? '発注の画面を開く' : `発注の画面で進める（手順${step}）`}
      <span className="visually-hidden">（{order.code}）</span>
    </a>
  );
}

/** P4 §0: a セブン化学発注書 is registered and checked at steps 1–2 of its order (or in the wizard). */
function SevenPoWhereLink({ po, orders, projectCode }: { po: { id: string; poNumber: string; officiallyRegistered: boolean; verificationStatus: string | null }; orders: readonly FilmSupplyOrderView[]; projectCode: string }) {
  const done = po.officiallyRegistered && po.verificationStatus === 'verified';
  const order = orders.find((candidate) => candidate.sevenPurchaseOrderId === po.id);
  if (done) return <span className="ui-note">本登録・照合済み</span>;
  if (order) {
    return (
      <a href={orderPath(projectCode, order.code, po.officiallyRegistered ? 2 : 1)} className="p4w2-row-link">
        {po.officiallyRegistered ? '発注の画面で照合する（手順2）' : '発注の画面で本登録する（手順1）'}
        <span className="visually-hidden">（{po.poNumber}）</span>
      </a>
    );
  }
  return (
    <a href={newOrderPath(projectCode)} className="p4w2-row-link">
      この発注書で発注を登録する<span className="visually-hidden">（{po.poNumber}）</span>
    </a>
  );
}

function stepOfStatus(status: string): number | null {
  const step = stepForStatus(status, { poRegistered: true, poVerified: true, makerPoStatus: null });
  return step !== null && step <= STEP_COUNT ? step : null;
}

function OrderLinesCell({ order }: { order: FilmSupplyOrderView }) {
  if (order.lines.length === 0) {
    if (order.lineCount > 0) return <span>{`${order.lineCount}行`}</span>;
    return <span>{order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : '—'}</span>;
  }
  return (
    <div>
      {order.lines.map((line) => (
        <div key={line.id}>
          {line.lineNumber}. {line.description} ／ {formatQuantityWithUnit(line.orderedQuantity, line.unit)}
        </div>
      ))}
    </div>
  );
}

/** P0 R01 (P-5): the 支払条件 changes on record — every change stays visible, oldest first. */
function PaymentTermsHistory({ order }: { order: FilmSupplyOrderView }) {
  const history = order.paymentTermsHistory ?? [];
  if (history.length === 0) return null;
  const label = (value: string | null) => (value ? PAYMENT_TERMS_LABELS[value] ?? '（不明）' : '（記録なし）');
  return (
    <div className="sx-082f6e5">
      <p className="ui-note sx-ff227d0">支払条件の変更履歴（{history.length}件）</p>
      <ol className="payment-terms-history sx-746a3eb">
        {history.map((change, index) => (
          <li className="sx-eefff2f" key={`${change.at}-${index}`}>
            {formatTimestamp(change.at)} {change.actorName ?? '（記録者不明）'}: {label(change.before)} → {label(change.after)}
            {change.reason ? `（理由: ${change.reason}）` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SevenPurchaseOrderSection({
  orders,
  poChoices,
  verificationLabel,
  role,
  loadFailed,
  filmOrders,
  projectCode
}: {
  filmOrders: readonly FilmSupplyOrderView[];
  projectCode: string;
  orders: Awaited<ReturnType<typeof loadWorkspace>>['sevenPurchaseOrders'];
  poChoices: Array<{ value: string; label: string }>;
  verificationLabel: Record<string, string>;
  role: string | null;
  loadFailed: boolean;
}) {
  // UI batch B (④): the 操作 column only for a role with a form to put in it.
  const showOperations = canRoleOperate(role, 'seven_po:register') || canRoleOperate(role, 'seven_po:verify');
  const canCreate = canRoleOperate(role, 'seven_po:create');
  return (
    <Card>
      <VStack gap={3}>
      <Heading level={2}>セブン化学発注書</Heading>
      <Text as="p" type="supporting">
        フィルム発注を進めるには、発注書の本登録と発注書の照合チェックの記録（確認済み）が必要です。
        記録は発注の画面の手順1・2（発注書の受付・照合）で行います。この一覧は閲覧用です。
      </Text>

      {orders.length === 0 ? (
        loadFailed ? <EmptyNote title={LOAD_FAILED_NOTE} next={null} /> : <EmptyNote title="セブン化学発注書はまだありません" next={canCreate ? '紙の発注書が届いたら、下の「セブン化学発注書を登録する」から登録します。' : null} />
      ) : (
        <DataTable caption="セブン化学発注書の一覧" captionHidden cards>
          <thead>
            <tr>
              <th className="ui-th" scope="col">発注番号</th>
              <th className="ui-th" scope="col">本登録</th>
              <th className="ui-th" scope="col">発注書の照合</th>
              {showOperations ? <th className="ui-th" scope="col">記録する画面</th> : null}
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id} id={`seven-po-${po.id}`} data-record-id={po.id} className="anchor-target">
                <Td label="発注番号" className="p4-nowrap" translate="no">
                  {po.poNumber}
                  <TechDetails context="ID">{po.id}</TechDetails>
                </Td>
                <td className="ui-td" data-label="本登録">
                  {officialRegistrationText(po)}
                </td>
                <td className="status-cell ui-td" data-label="発注書の照合">
                  {po.verificationStatus
                    ? (
                      <StatusBadge
                        domain="verification"
                        status={po.verificationStatus}
                        label={verificationLabel[po.verificationStatus] ?? po.verificationStatus}
                      />
                    )
                    : po.verificationHidden
                      ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                      : <StatusBadge tone="waiting" label="未記録" />}
                  {po.reviewPending ? <div className="ui-note">確認中（不一致レビュー）</div> : null}
                </td>
                {showOperations ? (
                  <Td label="記録する画面">
                    {/* P4 §0: 本登録・照合 are recorded at steps 1–2 of the order screen (or the wizard). */}
                    <SevenPoWhereLink po={po} orders={filmOrders} projectCode={projectCode} />
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <Divider />
      <RoleGate role={role} operation="seven_po:create" label="発注書の登録">
        <p><Link href={newOrderPath(projectCode)}>セブン化学発注書を登録する（新しいフィルム発注の画面）</Link></p>
      </RoleGate>
      {poChoices.length === 0 ? null : (
        <Text as="p" type="supporting">登録済み: {poChoices.length}件</Text>
      )}
      </VStack>
    </Card>
  );
}
