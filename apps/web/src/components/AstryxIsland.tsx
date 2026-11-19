'use client';

import type { ReactNode } from 'react';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import jaJP from '@astryxdesign/core/locales/ja-JP.generated.js';

/**
 * Astryx trial: the boundary of a migrated region (DESIGN_RULES §1).
 *
 * - `data-astryx-theme="neutral"` lets the theme's @scope CSS (tokens and its
 *   element reset) reach this subtree only. We do not use <Theme>: as the root
 *   provider it writes data-astryx-theme onto <html> after hydration, which
 *   would spread the theme's reset to every screen that is not migrated.
 * - Light only: `color-scheme: light` in astryx-bridge.css (the theme reads
 *   `data-theme` only on <html>, so it is not set here).
 * - Astryx's own strings (「必須」, close buttons, live announcements) in
 *   Japanese from the shipped ja-JP catalog.
 * The wrapper is `display: contents` (astryx-bridge.css), so it adds no box.
 */
// Module constant: a new object per render would reset the provider's memo.
const MESSAGES = { 'ja-JP': jaJP };

export function AstryxIsland({ children }: { children: ReactNode }) {
  return (
    <div className="ax-island" data-astryx-theme="neutral">
      <InternationalizationProvider locale="ja-JP" messages={MESSAGES}>
        {children}
      </InternationalizationProvider>
    </div>
  );
}
