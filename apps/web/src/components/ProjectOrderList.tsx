import Link from 'next/link';
import { StatusBadge } from './StatusBadge';
import { knownStatus, labelLookup, STATUS_PROGRESS_STEP } from '../lib/project-data';
import type { Workspace } from '../lib/project-data';
import { orderPath } from '../lib/project-route';
import { HIDDEN_BY_ROLE_LABEL } from '../lib/redaction';
import { formatQuantityWithUnit } from '../lib/number-format';

/**
 * P1 R20/R21: the project's film orders as rows (not cards), each a link to the
 * order's own screen. The state is the API's label; the quantity is written
 * with its unit (R31). A failed read says so — never 「まだありません」.
 */
export function ProjectOrderList({ workspace, projectCode, loadFailed }: { workspace: Workspace; projectCode: string; loadFailed: boolean }) {
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  if (workspace.filmOrders.length === 0) {
    return <p className="p1-muted">{loadFailed ? '発注を読み込めませんでした。画面上部の案内を確認してください。' : 'フィルム発注はまだありません。'}</p>;
  }
  return (
    <ul className="p1-order-rows" aria-label="フィルム発注">
      {workspace.filmOrders.map((order) => {
        const status = knownStatus(order);
        const step = status ? (STATUS_PROGRESS_STEP as Readonly<Record<string, number | null>>)[status] : null;
        const quantities = order.lines.map((line) => formatQuantityWithUnit(line.orderedQuantity, line.unit)).join('・');
        return (
          <li key={order.id}>
            <Link className="p1-order-row" href={orderPath(projectCode, order.code)}>
              <span className="p1-order-row-code" translate="no">{order.code}</span>
              <span className="p1-order-row-state">
                {status === null
                  ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                  : <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} />}
              </span>
              <span className="p1-order-row-meta">{quantities || (order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : '明細なし')}</span>
              <span className="p1-order-row-go" aria-hidden="true">{typeof step === 'number' ? '開く' : '開く'}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
