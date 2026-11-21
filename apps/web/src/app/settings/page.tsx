import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LanguageForm } from '../../components/LanguageForm';
import { loadSession } from '../../lib/api';
import { LANGUAGE_COOKIE, LANGUAGE_LABELS, LANGUAGE_MODES, languageFor } from '../../lib/locale';
import { setLanguageAction } from '../settings-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '表示言語' };

/** P1 R29 (REDESIGN §4-2): /settings — the display language of this operator. */
export default async function SettingsPage() {
  const session = await loadSession();
  if (session.kind === 'anonymous') redirect('/');
  if (session.kind !== 'user') return null;
  const current = languageFor((await cookies()).get(LANGUAGE_COOKIE)?.value, session.user);
  return (
    <section className="p1-new" aria-labelledby="settings-title">
      <h1 id="settings-title" className="p1-title">表示言語 <span className="p1-ko" lang="ko">표시 언어</span></h1>
      <p className="p1-lead">
        画面の言葉を選びます。業務の用語・会社名・番号・入力した原文は翻訳しません。外に出す書類とメールは日本語のままです。
        <span className="p1-ko" lang="ko">화면의 언어를 고릅니다. 업무 용어·회사명·번호·입력한 원문은 번역하지 않습니다.</span>
      </p>
      <LanguageForm
        action={setLanguageAction}
        current={current}
        choices={LANGUAGE_MODES.map((mode) => ({ value: mode, label: LANGUAGE_LABELS[mode] }))}
      />
    </section>
  );
}
