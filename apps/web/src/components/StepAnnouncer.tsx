'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { announcementText, takeSubmitIntent } from '../lib/submit-intent';

/**
 * P1 R34 (M14): after a step is recorded the screen is drawn again and the
 * panel shows the next step — the form that answered is gone with its result
 * line. So the panel says what was recorded here: when the order's progress
 * (progressKey: the step and its slots) changes while the screen is open, the
 * newest record is announced in a status region that takes focus, followed by
 * what to do now. On the first draw nothing is announced.
 */
export function StepAnnouncer({
  progressKey,
  latest,
  now,
  children
}: {
  progressKey: string;
  /** The newest record of this order, in the screens' words (「顧客の承認を記録」). */
  latest: string | null;
  /** The current step's title (「6 校了」), or null when nothing is left. */
  now: string | null;
  children: ReactNode;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const seen = useRef(progressKey);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seen.current === progressKey) return;
    seen.current = progressKey;
    // p6 X6: the submit's own action (the button's words) first; the newest record only when the change was not this screen's submit.
    setMessage(announcementText({ intent: takeSubmitIntent(), latest, now }));
  }, [progressKey, latest, now]);
  useEffect(() => {
    if (message) region.current?.focus();
  }, [message]);
  return (
    <>
      {/* P4 N15: the focus alone announces this (a role=status on a focused element was read twice). No
          aria-label: a label would replace the message as the element's name (review L-1). */}
      <div ref={region} tabIndex={-1} className={message ? 'p1-announce p1-announce--on' : 'p1-announce'}>
        {message ? <><span aria-hidden="true">✓ </span>{message}</> : null}
      </div>
      {children}
    </>
  );
}
