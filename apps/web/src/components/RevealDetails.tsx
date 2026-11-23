'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * p4/web4: a <details> that opens when a link to its anchor is followed (a link that points into a closed <details> only scrolls
 * to its summary). The refusal of a delivery confirmation links to the form for the customer's own receipt: the link opens it,
 * and so does arriving with the anchor in the address. `open` starts it opened (a stopped confirmation is waiting for it).
 * Without script the details still toggle with its summary.
 */
export function RevealDetails({ id, className, open = false, summary, children }: {
  id: string;
  className: string;
  open?: boolean | undefined;
  summary: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      if (ref.current) ref.current.open = true;
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor && anchor.getAttribute('href') === `#${id}`) reveal();
    };
    const onHash = () => {
      if (window.location.hash === `#${id}`) reveal();
    };
    onHash();
    document.addEventListener('click', onClick);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('hashchange', onHash);
    };
  }, [id]);
  return (
    <details ref={ref} className={className} id={id} open={open || undefined} data-alternative-receipt="">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
