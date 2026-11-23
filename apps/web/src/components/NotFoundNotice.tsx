import { Bilingual } from './Bilingual';

/**
 * P4 N7: the 404 in the product's own words (Next's default is English:
 * 「This page could not be found.」). Two ways out: the home screen, and the
 * project list (the dashboard is where a project is chosen). Codes are never
 * translated; the Korean line follows the display mode (REDESIGN §4).
 */
export const NOT_FOUND_TITLE = 'ページが見つかりません';

export function NotFoundNotice({ scope }: { scope: 'site' | 'project' }) {
  return (
    <section className="p1-notfound" aria-labelledby="p4-notfound-title">
      <h1 id="p4-notfound-title" className="p1-title">
        <Bilingual ja={scope === 'project' ? 'この案件のページが見つかりません' : NOT_FOUND_TITLE} ko="페이지를 찾을 수 없습니다" />
      </h1>
      <p className="p1-lead">
        <Bilingual
          ja="アドレスが間違っているか、ページが移動した可能性があります。下のリンクから開き直してください。"
          ko="주소가 틀렸거나 페이지가 이동했을 수 있습니다. 아래 링크에서 다시 여세요."
        />
      </p>
      <ul className="p1-link-list" aria-label="移動先">
        <li><a href="/home"><Bilingual ja="ホームへ" ko="홈으로" /></a></li>
        <li><a href="/dashboard"><Bilingual ja="案件を選ぶ" ko="안건 선택" /></a></li>
      </ul>
    </section>
  );
}
