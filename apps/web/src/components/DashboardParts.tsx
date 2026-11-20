import Link from 'next/link';
import type { DashboardItem, DashboardView } from '../lib/dashboard';

/**
 * UI nav-dashboard: the parts of the dashboard screen. Server markup only;
 * every count and mark is written out as text, so nothing depends on colour.
 */

/** The flow strip: open orders per step of the film order flow, and the one next action. */
export function DashboardFlow({ view }: { view: DashboardView }) {
  const outside = [
    view.exceptionCount > 0 ? `止まっている ${view.exceptionCount}件` : null,
    view.completedCount > 0 ? `完了 ${view.completedCount}件` : null,
    view.cancelledCount > 0 ? `取消で終了 ${view.cancelledCount}件` : null,
    view.hiddenCount > 0 ? `状態が閲覧権限なし ${view.hiddenCount}件` : null,
    view.unknownCount > 0 ? `段階を表示できない状態 ${view.unknownCount}件` : null
  ].filter((part): part is string => part !== null);
  return (
    <section className="dash-flow" aria-labelledby="dash-flow-title">
      <h2 id="dash-flow-title" className="dash-flow-title">発注の流れ（段階ごとの件数）</h2>
      <ol className="dash-flow-steps">
        {view.flow.map((step) => (
          <li
            key={step.name}
            className={`dash-flow-step${step.count > 0 ? ' dash-flow-step--busy' : ''}${step.mine > 0 ? ' dash-flow-step--mine' : ''}`}
          >
            <span className="dash-flow-num" aria-hidden="true">{step.index + 1}</span>
            <span className="dash-flow-name">{step.name}</span>
            <span className="dash-flow-count">
              {step.count}
              <span className="dash-flow-unit">件</span>
            </span>
            {step.mine > 0 ? <span className="dash-flow-mine">自分の作業 {step.mine}件</span> : null}
          </li>
        ))}
      </ol>
      {outside.length > 0 ? <p className="dash-flow-outside">段階の外: {outside.join('、')}</p> : null}
      <div className="dash-next">
        <p className="dash-next-label">次にやること</p>
        <p className="dash-next-text">
          {view.nextAction.text}
          {view.nextAction.owner ? <span className="dash-next-owner">（担当: {view.nextAction.owner}）</span> : null}
        </p>
        {view.nextAction.href && view.nextAction.linkLabel ? (
          <Link href={view.nextAction.href} className="dash-next-link">{view.nextAction.linkLabel}</Link>
        ) : null}
      </div>
    </section>
  );
}

function ItemMeta({ item }: { item: DashboardItem }) {
  const parts = [
    item.owner ? `担当: ${item.owner}` : null,
    item.paymentTerms ? `決済条件: ${item.paymentTerms}` : null,
    item.amount ? `金額: ${item.amount}` : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? <span className="dash-item-meta">{parts.join('　')}</span> : null;
}

/** A list of dashboard items; each one is a link to the screen (and order) where it is done. */
export function DashboardItemList({ items, label, empty }: { items: readonly DashboardItem[]; label: string; empty: string }) {
  if (items.length === 0) return <p className="dash-empty">{empty}</p>;
  return (
    <ul className="dash-items" aria-label={label}>
      {items.map((item) => (
        <li key={item.key}>
          <Link href={item.href} className="dash-item">
            <span className="dash-item-head">
              {item.orderCode ? <span className="dash-item-code" translate="no">{item.orderCode}</span> : null}
              <span className="dash-item-title">{item.title}</span>
            </span>
            {item.detail ? <span className="dash-item-detail">{item.detail}</span> : null}
            <ItemMeta item={item} />
            <span className="dash-item-go">{item.linkLabel}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DashboardActivity({ view }: { view: DashboardView }) {
  return (
    <>
      {view.activity.length > 0 ? (
        <ol className="dash-activity" aria-label="最近の記録（新しい順）">
          {view.activity.map((row) => (
            <li key={row.key}>
              <span className="dash-activity-at">{row.at}</span>
              <span className="dash-activity-text">
                {row.href ? <Link href={row.href}>{row.text}</Link> : row.text}
                <span className="dash-activity-actor">{row.actor}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {view.activityNote ? <p className="dash-empty">{view.activityNote}</p> : null}
    </>
  );
}
