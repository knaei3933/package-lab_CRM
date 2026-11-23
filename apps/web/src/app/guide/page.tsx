import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../../components/AstryxIsland';
import { loadSessionUser } from '../../lib/api';
import { displayLanguage } from '../../lib/locale-server';
import { GUIDE_DAYS, GUIDE_FORBIDDEN, GUIDE_STEPS, GUIDE_TERMS, GUIDE_TROUBLES } from '../../lib/guide';
import { normalizeRole } from '../../lib/permissions';
import { SCREEN_NAMES } from '../../lib/project-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '使い方ガイド' };

/**
 * The Korean explanation under one guide section: closed by default, marked
 * lang="ko" (the page itself is Japanese, like every screen).
 */
function KoreanNote({ children, show }: { children: ReactNode; show: boolean }) {
  // p5 R7: the explanation follows the display language (P-7): a Japanese-only reader gets none.
  if (!show) return null;
  return (
    <details className="guide-ko" lang="ko">
      <summary>한국어 설명</summary>
      <div className="guide-ko-body">{children}</div>
    </details>
  );
}

/**
 * UI nav-dashboard (C): the guide for a first-time operator — the order of the
 * work, a day per role, the terms, and the situations people get stuck in.
 * Static content (lib/guide.ts); the signed-in role's day is listed first.
 */
export default async function GuidePage() {
  const user = await loadSessionUser();
  const role = user ? normalizeRole(user.role) : null;
  const { showKorean } = await displayLanguage(user);
  const days = role ? [...GUIDE_DAYS].sort((a, b) => Number(b.role === role) - Number(a.role === role)) : GUIDE_DAYS;

  return (
    <AstryxIsland>
      <VStack as="section" gap={5}>
        <VStack gap={2}>
          <Heading level={1}>使い方ガイド</Heading>
          <Text as="p" type="supporting">
            KANEI CRM（F1）は、セブン化学発注書の受付から納品の確認・手数料準備までのフィルム発注を記録する台帳です。メールや発注は人が送り、CRMにはその証跡を残します。
          </Text>
          <KoreanNote show={showKorean}>
            <p>KANEI CRM(F1)은 セブン化学発注書 접수부터 납품 확인·수수료 준비까지의 필름 발주를 기록하는 장부입니다. 메일·발주는 사람이 직접 보내고, CRM에는 그 증빙을 남깁니다.</p>
          </KoreanNote>
        </VStack>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>作業の順番（8段階）</Heading>
            <Text as="p" type="supporting">各画面の上の進み具合（済・いま）と同じ名前です。前の段階が終わると次へ進めます。</Text>
            <ol className="guide-steps">
              {GUIDE_STEPS.map((step) => (
                <li key={step.name}>
                  <p className="guide-step-name">{step.name}</p>
                  <p>{step.what}</p>
                  <p className="guide-step-meta">
                    担当: {step.who}　画面:{' '}
                    {step.screens.map((screen, index) => (
                      <span key={screen}>
                        {index > 0 ? '・' : null}
                        <Link href={screen}>{SCREEN_NAMES[screen]}</Link>
                      </span>
                    ))}
                  </p>
                </li>
              ))}
            </ol>
            <p className="guide-rule">{GUIDE_FORBIDDEN.text}</p>
            <KoreanNote show={showKorean}>
              <ol>
                {GUIDE_STEPS.map((step) => <li key={step.name}><span lang="ja">{step.name}</span>: {step.ko}</li>)}
              </ol>
              <p>{GUIDE_FORBIDDEN.ko}</p>
            </KoreanNote>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>役割ごとの一日の流れ</Heading>
            <div className="guide-days">
              {days.map((day) => (
                <div key={day.role}>
                  <h3>
                    {day.title}
                    {day.role === role ? <span className="guide-you">（いまログインしている役割）</span> : null}
                  </h3>
                  <ol>
                    {day.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                </div>
              ))}
            </div>
            <KoreanNote show={showKorean}>
              {days.map((day) => (
                <div key={day.role}>
                  <p className="guide-ko-head"><span lang="ja">{day.title}</span></p>
                  <ol>
                    {day.ko.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                </div>
              ))}
            </KoreanNote>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>用語集</Heading>
            <dl className="guide-terms">
              {GUIDE_TERMS.map((entry) => (
                <div key={entry.term}>
                  <dt>{entry.term}</dt>
                  <dd>{entry.meaning}</dd>
                </div>
              ))}
            </dl>
            <KoreanNote show={showKorean}>
              <dl className="guide-terms">
                {GUIDE_TERMS.map((entry) => (
                  <div key={entry.term}>
                    <dt lang="ja">{entry.term}</dt>
                    <dd>{entry.ko}</dd>
                  </div>
                ))}
              </dl>
            </KoreanNote>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>よく止まる場面</Heading>
            <div className="guide-troubles">
              {GUIDE_TROUBLES.map((trouble) => (
                <details key={trouble.question}>
                  <summary>{trouble.question}</summary>
                  <p>{trouble.answer}</p>
                </details>
              ))}
            </div>
            <KoreanNote show={showKorean}>
              <ul>
                {GUIDE_TROUBLES.map((trouble) => (
                  <li key={trouble.question}><span lang="ja">{trouble.question}</span>: {trouble.ko}</li>
                ))}
              </ul>
            </KoreanNote>
          </VStack>
        </Card>
      </VStack>
    </AstryxIsland>
  );
}
