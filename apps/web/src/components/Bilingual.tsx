'use client';

import { useRenderedContext } from './RenderedContext';

/**
 * P1 R29: a Japanese text with its Korean gloss (REDESIGN §4). The Japanese is
 * always shown (it is the business wording everyone shares); the Korean line
 * follows in the bilingual mode only, marked lang="ko" so screen readers and
 * the browser read it as Korean. Codes and names are never translated (§4-4).
 */
export function Bilingual({ ja, ko }: { ja: string; ko: string }) {
  const context = useRenderedContext();
  // 한국어 mode: Korean first, the Japanese business wording kept next to it (§4-2 ③).
  if (context?.lang === 'ko') {
    return (
      <>
        <span lang="ko">{ko}</span>
        <span className="p1-ja">{ja}</span>
      </>
    );
  }
  return (
    <>
      {ja}
      {context?.showKorean ? <span className="p1-ko" lang="ko">{ko}</span> : null}
    </>
  );
}
