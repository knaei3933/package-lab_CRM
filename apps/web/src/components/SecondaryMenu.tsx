'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { KoGloss } from './RenderedContext';

export interface SecondaryMenuItem {
  key: string;
  label: string;
  ko?: string | undefined;
  /** Who may do it, said on the button (display only; the API decides). */
  who?: string | undefined;
  content: ReactNode;
}

/**
 * P4 M6: the order screen's 「その他の操作」 — the exceptions (止める・変更する・
 * 取り消す) and the checks that used to live only in the old list tables. The
 * one primary action stays in the step panel; these are a row of buttons, each
 * opening its own form below (aria-expanded / aria-controls, one open at a time).
 * The forms are rendered on the server and only shown or hidden here, so a
 * refused submit keeps its values and its message.
 */
export function SecondaryMenu({ id, title, items }: { id?: string; title: string; items: readonly SecondaryMenuItem[] }) {
  const base = useId();
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <section id={id} className="p4w2-more" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} className="p1-section-title">{title}</h2>
      <ul className="p4w2-more-buttons" role="list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="ui-button--subtle p4w2-more-button"
              aria-expanded={open === item.key}
              aria-controls={`${base}-${item.key}`}
              data-menu-item={item.key}
              onClick={() => setOpen((current) => (current === item.key ? null : item.key))}
            >
              {item.label}
              {item.who ? <span className="p4w2-more-who">（{item.who}）</span> : null}
              <KoGloss ko={item.ko} />
            </button>
          </li>
        ))}
      </ul>
      {items.map((item) => (
        <div
          key={item.key}
          id={`${base}-${item.key}`}
          className="p4w2-more-panel"
          role="region"
          aria-label={item.label}
          hidden={open !== item.key}
          data-menu-panel={item.key}
        >
          {item.content}
        </div>
      ))}
    </section>
  );
}
