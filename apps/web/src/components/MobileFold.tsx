'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** The width under which a long, read-only block folds into its summary (the card's 600px breakpoint, app/p5-web.css). */
export const MOBILE_FOLD_QUERY = '(max-width: 600px)';

/**
 * p5 R2 / M12: whether a MobileFold is open. On a phone a block folds into its one-line summary — unless something in it must be
 * seen before the representative decides (a warning, a stamp that is not an approval): `keepOpen`. Everywhere else it is open.
 */
export function foldOpenState({ narrow, keepOpen }: { narrow: boolean; keepOpen: boolean }): boolean {
  return keepOpen || !narrow;
}

/**
 * p5 R2 / M12: the evidence of the approval card (lines, approved file, 押印欄, セブン化学発注書, recipient) is long: at 390px it put the
 * amount field 7 screens down. The markup is OPEN (no script, a desktop and a wide screen read it as before); on a narrow screen the
 * script closes it to its summary, which says what stands (「顧客 承認・セブン化学 承認」). The summary is hidden on a wide screen
 * (app/p5-web.css), where the block is not a disclosure at all. Nothing is removed from the page: a folded block opens with its summary.
 */
export function MobileFold({ summary, keepOpen = false, className, children }: { summary: ReactNode; keepOpen?: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_FOLD_QUERY);
    const apply = () => {
      if (ref.current) ref.current.open = foldOpenState({ narrow: query.matches, keepOpen });
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [keepOpen]);
  return (
    <details ref={ref} className={`p5-fold${className ? ` ${className}` : ''}`} open data-keep-open={keepOpen ? 'true' : 'false'}>
      <summary className="p5-fold-summary">{summary}</summary>
      {children}
    </details>
  );
}
