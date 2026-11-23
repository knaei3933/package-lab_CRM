import { Bilingual } from './Bilingual';
import { ASSIGNMENT_ROLE_LABELS } from '../lib/assignments';

/**
 * P4 N1: the person has no project to open. They ask the representative to assign them — this block
 * is the request, ready to send (chat, mail, in person). p4/web3 (d): the representative now picks the
 * person by name from the list (GET /api/assignable-users), and the name is the session's own (GET
 * /api/me displayName); the 利用者ID stays in the text to tell two people of the same name apart.
 *
 * A read-only field holds the whole request so it can be selected in one go; nothing is sent from here.
 */
export interface AssignmentRequester {
  id: string;
  displayName?: string | undefined;
  role: string;
}

/** The request text: name, role and the 利用者ID the representative pastes into 担当者. */
export function assignmentRequestText(requester: AssignmentRequester): string {
  const role = ASSIGNMENT_ROLE_LABELS[requester.role] ?? requester.role;
  return [
    '案件への割り当てをお願いします。',
    `名前: ${requester.displayName ?? '（名前なし）'}`,
    `役割: ${role}`,
    `利用者ID: ${requester.id}`,
    '代表者は、案件の画面の「割り当て」で名前を選んで割り当てられます。'
  ].join('\n');
}

export function AssignmentRequest({ requester }: { requester: AssignmentRequester }) {
  const text = assignmentRequestText(requester);
  return (
    <section className="p4-assignment-request" aria-labelledby="assignment-request-title" data-section="assignment-request">
      {/* web2b review L-6: it sits under the screen's h1 — an h2, not a skipped level. */}
      <h2 id="assignment-request-title" className="p4-assignment-request-title">
        <Bilingual ja="代表者に割り当てを依頼" ko="대표자에게 배정을 요청" />
      </h2>
      <p>
        <Bilingual
          ja="下の文を代表者に送ってください。代表者が案件の「割り当て」であなたを選ぶと、この画面を再読み込みするだけで案件が開けます。"
          ko="아래 문장을 대표자에게 보내세요. 대표자가 안건의 「割り当て」에서 당신을 선택하면, 이 화면을 새로고침하는 것만으로 안건을 열 수 있습니다."
        />
      </p>
      <label htmlFor="assignment-request-text" className="p4-assignment-request-label">依頼の文（そのまま送れます）</label>
      <textarea
        id="assignment-request-text"
        className="p4-assignment-request-text"
        readOnly
        rows={5}
        value={text}
        translate="no"
      />
    </section>
  );
}
