import Link from 'next/link';
import { StatusBadge } from './StatusBadge';
import { knownStatus, labelLookup } from '../lib/project-data';
import type { Workspace } from '../lib/project-data';
import { orderPath } from '../lib/project-route';
import { HIDDEN_BY_ROLE_LABEL } from '../lib/redaction';
import { formatQuantityWithUnit } from '../lib/number-format';
import { orderScreenRefused } from '../lib/order-lookup';

/**
 * P1 R20/R21: the project's film orders as rows (not cards), each a link to the
 * order's own screen. The state is the API's label; the quantity is written
 * with its unit (R31). A failed read says so — never 「まだありません」.
 *
 * p6/rc (a): a role refused the order screen (viewer — H10 is the code and the stage only) reads the
 * same row without the link and without 「開く」, so it is never sent to the permission page.
 */
export function ProjectOrderList({ workspace, projectCode, loadFailed, role }: { workspace: Workspace; projectCode: string; loadFailed: boolean; role: string | null | undefined }) {
  const linked = !orderScreenRefused(role);
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  if (workspace.filmOrders.length === 0) {
    return <p className="p1-muted">{loadFailed ? '発注を読み込めませんでした。画面上部の案内を確認してください。' : 'フィルム発注はまだありません。'}</p>;
  }
  return (
    <ul className="p1-order-rows" aria-label="フィルム発注">
      {workspace.filmOrders.map((order) => {
        const status = knownStatus(order);
        const quantities = order.lines.map((line) => formatQuantityWithUnit(line.orderedQuantity, line.unit)).join('・');
        return (
          <li key={order.id}>
            {linked ? (
              <Link className="p1-order-row" href={orderPath(projectCode, order.code)}>
                <OrderRowCells order={order} status={status} stateLabel={stateLabel} quantities={quantities} />
                <span className="p1-order-row-go" aria-hidden="true">開く</span>
              </Link>
            ) : (
              <div className="p1-order-row p1-order-row--static">
                <OrderRowCells order={order} status={status} stateLabel={stateLabel} quantities={quantities} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OrderRowCells({ order, status, stateLabel, quantities }: {
  order: Workspace['filmOrders'][number];
  status: string | null;
  stateLabel: (key: string) => string;
  quantities: string;
}) {
  return (
    <>
      <span className="p1-order-row-code" translate="no">{order.code}</span>
      <span className="p1-order-row-state">
        {status === null
          ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
          : <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} />}
      </span>
      <span className="p1-order-row-meta">{quantities || (order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : '明細なし')}</span>
    </>
  );
}
