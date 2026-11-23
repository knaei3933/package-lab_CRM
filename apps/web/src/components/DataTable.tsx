import type { ReactNode } from 'react';
import { tableStyle } from '../lib/ui';

/**
 * UI batch C (2-⑤・2-⑥): every operator table — a short Japanese <caption>
 * and a keyboard-focusable horizontal scroll region, so a wide table scrolls
 * inside its card at 390px instead of widening the page. `captionHidden` keeps
 * the caption for screen readers only, when the same title already stands
 * right above the table.
 */
export function DataTable({
  caption,
  captionHidden = false,
  cards = false,
  children
}: {
  caption: string;
  captionHidden?: boolean;
  /**
   * P4 M12: below 600px of its own width the table becomes one card per row — each
   * cell shows its column name (the cell's data-label) — instead of a sideways scroll.
   */
  cards?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0} data-cards={cards ? 'true' : undefined}>
      <table style={tableStyle} className={cards ? 'ui-table--cards' : undefined}>
        <caption className={captionHidden ? 'visually-hidden' : 'table-caption'}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}
