import { ORDER_STEPS } from '../lib/order-flow';
import type { StepMark } from '../lib/order-flow';

/**
 * P1 R21: the order's 12 steps as an ordered list. Each mark is written out
 * (✓ 済 / ● いま / 中断 / 番号), never colour alone; the current step carries
 * aria-current="step". Under 640px the list folds to the current step line
 * (CSS), and the panel takes the full width (REDESIGN §5-3 390px).
 */
const MARK_TEXT: Record<StepMark, string> = {
  done: '済',
  current: 'いま',
  interrupted: '中断',
  upcoming: '',
  unknown: ''
};

export function OrderTimeline({ marks, current }: { marks: readonly StepMark[]; current: number | null }) {
  return (
    <ol className="p1-timeline" aria-label="この発注の手順（12）">
      {ORDER_STEPS.map((step, index) => {
        const mark = marks[index] ?? 'unknown';
        return (
          <li
            key={step.key}
            className={`p1-tl-step p1-tl-step--${mark}`}
            aria-current={step.no === current && mark === 'current' ? 'step' : undefined}
          >
            <span className="p1-tl-mark" aria-hidden="true">{mark === 'done' ? '✓' : mark === 'current' ? '●' : mark === 'interrupted' ? '!' : step.no}</span>
            <span className="p1-tl-name">
              <span className="p1-tl-no">{step.no}</span>
              {step.title}
            </span>
            {MARK_TEXT[mark] ? <span className="p1-tl-state">{MARK_TEXT[mark]}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
