import type { ReactNode } from 'react';

/**
 * UI batch B (⑤): ids, state codes and other system values, folded under
 * 「詳細」 so the working text stays in Japanese. Opened only by whoever needs
 * the value (代表者・開発者); the markup is plain <details>, keyboard-operable.
 * `context` names what is folded (「ID」「コード」), so a row of several 「詳細」
 * still tells them apart: 「詳細（ID）」.
 */
export function TechDetails({
  children,
  context,
  summary
}: {
  children: ReactNode;
  context?: string;
  /** A whole summary text, when 「詳細（context）」 does not fit. */
  summary?: string;
}) {
  return (
    <details className="tech-details">
      <summary>{summary ?? (context ? `詳細（${context}）` : '詳細')}</summary>
      <div className="tech-details-body">{children}</div>
    </details>
  );
}
