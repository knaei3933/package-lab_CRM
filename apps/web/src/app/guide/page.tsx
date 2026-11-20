import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../../components/AstryxIsland';
import { loadSessionUser } from '../../lib/api';
import { GUIDE_DAYS, GUIDE_STEPS, GUIDE_TERMS, GUIDE_TROUBLES } from '../../lib/guide';
import { normalizeRole } from '../../lib/permissions';
import { SCREEN_NAMES } from '../../lib/project-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '使い方ガイド' };

/**
 * UI nav-dashboard (C): the guide for a first-time operator — the order of the
 * work, a day per role, the terms, and the situations people get stuck in.
 * Static content (lib/guide.ts); the signed-in role's day is listed first.
 */
export default async function GuidePage() {
  const user = await loadSessionUser();
  const role = user ? normalizeRole(user.role) : null;
  const days = role ? [...GUIDE_DAYS].sort((a, b) => Number(b.role === role) - Number(a.role === role)) : GUIDE_DAYS;

  return (
    <AstryxIsland>
      <VStack as="section" gap={5}>
        <VStack gap={2}>
          <Heading level={1}>使い方ガイド</Heading>
          <Text as="p" type="supporting">
            <span lang="ko">
              KANEI CRM（F1）은 セブン化学発注書 접수부터 納品・受領確認・手数料準備까지의 필름 発注을 기록하는 장부입니다.
              메일・発注은 사람이 직접 보내고, CRM에는 그 증거（証跡）를 남깁니다.
            </span>
          </Text>
        </VStack>

        <Card>
          <VStack gap={3}>
            <Heading level={2}><span lang="ko">업무 순서（8段階）</span></Heading>
            <Text as="p" type="supporting">
              <span lang="ko">각 화면 위의 진행 표시（済・いま）와 같은 이름입니다. 앞 단계가 끝나야 다음으로 진행할 수 있습니다.</span>
            </Text>
            <ol className="guide-steps" lang="ko">
              {GUIDE_STEPS.map((step) => (
                <li key={step.name}>
                  <p className="guide-step-name" lang="ja">{step.name}</p>
                  <p>{step.what}</p>
                  <p className="guide-step-meta">
                    담당: {step.who}　화면:{' '}
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
            <p className="guide-rule" lang="ko">
              금지: デザイン 업로드만으로, 또는 顧客 단독 승인만으로 メーカー 발주를 할 수 없습니다. セブン化学発注書도 メーカー発注書를 대신하지 않습니다.
            </p>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}><span lang="ko">역할별 하루 흐름</span></Heading>
            <div className="guide-days" lang="ko">
              {days.map((day) => (
                <div key={day.role}>
                  <h3>
                    {day.title}
                    {day.role === role ? <span className="guide-you">（지금 로그인한 역할）</span> : null}
                  </h3>
                  <ol>
                    {day.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                </div>
              ))}
            </div>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}><span lang="ko">용어집</span></Heading>
            <dl className="guide-terms" lang="ko">
              {GUIDE_TERMS.map((entry) => (
                <div key={entry.term}>
                  <dt lang="ja">{entry.term}</dt>
                  <dd>{entry.meaning}</dd>
                </div>
              ))}
            </dl>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}><span lang="ko">자주 막히는 상황</span></Heading>
            <div className="guide-troubles" lang="ko">
              {GUIDE_TROUBLES.map((trouble) => (
                <details key={trouble.question}>
                  <summary>{trouble.question}</summary>
                  <p>{trouble.answer}</p>
                </details>
              ))}
            </div>
          </VStack>
        </Card>
      </VStack>
    </AstryxIsland>
  );
}
