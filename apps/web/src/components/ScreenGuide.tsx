'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { screenGuideFor } from '../lib/navigation';

/**
 * UI nav-dashboard (C): one line above every operator screen — where this
 * screen sits in the flow, what is done here, and which screen usually comes
 * next. Static guide copy (lib/navigation.ts SCREEN_GUIDES); the live next step
 * of each order stays in the screen's own 「次にやること」.
 */
export function ScreenGuideLine() {
  const guide = screenGuideFor(usePathname());
  if (!guide) return null;
  return (
    // A plain block, not a landmark: it sits inside <main> above the screen's h1.
    <div className="screen-guide">
      <p className="screen-guide-phase">
        {guide.step === null ? guide.phase : <>手順{guide.step}｜{guide.phase}</>}
      </p>
      <p className="screen-guide-text" lang="ko">
        <span className="screen-guide-label">이 화면에서 할 일</span>
        {guide.doHere}
      </p>
      {guide.next ? (
        <p className="screen-guide-text" lang="ko">
          <span className="screen-guide-label">다음 단계</span>
          {guide.next.text} <Link href={guide.next.href}>{guide.next.label} 화면 열기</Link>
        </p>
      ) : null}
    </div>
  );
}
