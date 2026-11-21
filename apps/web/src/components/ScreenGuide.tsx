'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { screenGuideFor } from '../lib/navigation';
import { parseProjectPath, scopeHref, unscopedPath } from '../lib/project-route';

/**
 * UI nav-dashboard (C): one line above every operator screen (Japanese, like the screens) — where this
 * screen sits in the flow, what is done here, and which screen usually comes
 * next. Static guide copy (lib/navigation.ts SCREEN_GUIDES); the live next step
 * of each order stays in the screen's own 「次にやること」.
 */
export function ScreenGuideLine() {
  const pathname = usePathname();
  // P1 R20: the guide of the list a /p/{code}/… address stands for; the order screen has none.
  const guide = screenGuideFor(unscopedPath(pathname));
  const projectCode = parseProjectPath(pathname)?.projectCode ?? null;
  if (!guide) return null;
  return (
    // A plain block, not a landmark: it sits inside <main> above the screen's h1.
    <div className="screen-guide">
      <p className="screen-guide-phase">
        {guide.step === null ? guide.phase : <>手順{guide.step}｜{guide.phase}</>}
      </p>
      <p className="screen-guide-text">
        <span className="screen-guide-label">この画面でやること</span>
        {guide.doHere}
      </p>
      {guide.next ? (
        <p className="screen-guide-text">
          <span className="screen-guide-label">次の段階</span>
          {guide.next.text}<Link href={scopeHref(projectCode, guide.next.href)}>{guide.next.label}画面を開く</Link>
        </p>
      ) : null}
    </div>
  );
}
