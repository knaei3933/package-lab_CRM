import Link from 'next/link';
import {
  groupOrdersForProgress,
  labelLookup,
  nextActionForOrder,
  nextActionWithoutOrders,
  orderProgress,
  PROGRESS_STEPS,
  SCREEN_NAMES,
  STATUS_HIDDEN_NOTICE
} from '../lib/project-data';
import type {
  FilmSupplyOrderView,
  NextActionView,
  ProgressStepMark,
  ScreenPath,
  Workspace
} from '../lib/project-data';

/**
 * UI batch B (①): the project's progress at the top of every operator screen —
 * one stepper per film order in progress (帳簿の押印: 済 stamps, いま for the
 * current step) and the 「次にやること」 card naming the next step, who does it
 * and where. Built only from the Workspace the screen already loaded; the
 * marks are always written out (済・いま・中断・番号), never colour alone.
 */
const MARK_TEXT: Record<Exclude<ProgressStepMark, 'unmarked' | 'upcoming'>, string> = {
  done: '済',
  current: 'いま',
  interrupted: '中断'
};

/** UI batch C (2-⑦): each stepper is named, so several on one screen stay apart. */
function Stepper({ marks, label }: { marks: ProgressStepMark[]; label: string }) {
  return (
    <ol className="stepper" aria-label={label}>
      {PROGRESS_STEPS.map((name, index) => {
        const mark = marks[index] ?? 'unmarked';
        return (
          <li key={name} className={`step step--${mark}`} aria-current={mark === 'current' ? 'step' : undefined}>
            {mark === 'unmarked' ? null : (
              <span className="step-mark">{mark === 'upcoming' ? index + 1 : MARK_TEXT[mark]}</span>
            )}
            <span className="step-label">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function OrderProgressRow({ order, stateLabel }: { order: FilmSupplyOrderView; stateLabel: (key: string) => string }) {
  const progress = orderProgress(order);
  return (
    <div className="progress-row">
      <p className="progress-head">
        <span className="progress-code">{order.code}</span>
        {progress.status === null ? null : progress.phase === 'exception' ? (
          <span className="progress-badge">{stateLabel(progress.status)}</span>
        ) : (
          <span>{stateLabel(progress.status)}</span>
        )}
      </p>
      <Stepper marks={progress.marks} label={`${order.code} の進み具合`} />
      {progress.phase === 'exception' && progress.interruptedStep === null ? (
        <p className="progress-note">中断した段階は記録から分かりません。</p>
      ) : null}
    </div>
  );
}

function NextActionBody({
  action,
  orderCode,
  currentPath
}: {
  action: NextActionView;
  orderCode: string | null;
  currentPath: ScreenPath;
}) {
  return (
    <>
      <p className="next-text">
        {orderCode ? <span className="next-order">{orderCode}</span> : null}
        {action.text}
      </p>
      {action.owner ? <p className="next-meta">担当: {action.owner}</p> : null}
      {action.refusal ? <p className="next-refusal">{action.refusal}</p> : null}
      {action.screens.length > 0 ? (
        <p className="next-links">
          {action.screens.map((screen) =>
            screen === currentPath ? (
              <span key={screen}>この画面の下にあります</span>
            ) : (
              <Link key={screen} href={screen}>
                {SCREEN_NAMES[screen]}画面を開く
              </Link>
            )
          )}
        </p>
      ) : null}
    </>
  );
}

export function ProjectProgress({
  workspace,
  role,
  currentPath
}: {
  workspace: Workspace;
  role: string | null | undefined;
  currentPath: ScreenPath;
}) {
  // Without the project (an unreadable or refused selection) there is no
  // progress to claim; the screen shows the API's error instead.
  if (!workspace.project) return null;
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const { active, completed, hidden } = groupOrdersForProgress(workspace.filmOrders);

  const items: Array<{ key: string; orderCode: string | null; action: NextActionView }> =
    workspace.filmOrders.length === 0
      ? [{ key: 'none', orderCode: null, action: nextActionWithoutOrders(workspace, role) }]
      : active.map((order) => ({
        key: order.id,
        orderCode: active.length > 1 ? order.code : null,
        action: nextActionForOrder(order, workspace, role)
      }));
  if (items.length === 0) {
    items.push(
      hidden[0]
        ? { key: 'hidden', orderCode: null, action: nextActionForOrder(hidden[0], workspace, role) }
        : {
          key: 'complete',
          orderCode: null,
          action: { text: 'この案件の発注はすべて完了しています。', owner: null, screens: [], operation: null, refusal: null }
        }
    );
  }

  return (
    <section className="progress" aria-label="発注の進み具合">
      {workspace.filmOrders.length === 0 ? (
        <div className="progress-row">
          <p className="progress-head">フィルム発注はまだありません</p>
          <Stepper marks={PROGRESS_STEPS.map((): ProgressStepMark => 'upcoming')} label="発注の進み具合" />
        </div>
      ) : null}
      {active.map((order) => (
        <OrderProgressRow key={order.id} order={order} stateLabel={stateLabel} />
      ))}
      {hidden.length > 0 ? (
        <div className="progress-row">
          <p className="progress-head">フィルム発注 {hidden.length}件</p>
          <Stepper marks={PROGRESS_STEPS.map((): ProgressStepMark => 'unmarked')} label="フィルム発注の進み具合" />
          <p className="progress-note">{STATUS_HIDDEN_NOTICE}</p>
        </div>
      ) : null}
      {completed.length > 0 ? (
        <details className="progress-completed">
          <summary>完了した発注 {completed.length}件</summary>
          {completed.map((order) => (
            <OrderProgressRow key={order.id} order={order} stateLabel={stateLabel} />
          ))}
        </details>
      ) : null}

      <div className="next-card">
        <h2>次にやること</h2>
        {items.length === 1 ? (
          <NextActionBody action={items[0]!.action} orderCode={items[0]!.orderCode} currentPath={currentPath} />
        ) : (
          <ul className="next-list">
            {items.map((item) => (
              <li key={item.key}>
                <NextActionBody action={item.action} orderCode={item.orderCode} currentPath={currentPath} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
