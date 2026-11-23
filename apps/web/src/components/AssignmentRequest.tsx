import { Bilingual } from './Bilingual';
import { ASSIGNMENT_ROLE_LABELS } from '../lib/assignments';

/**
 * P4 N1: the person has no project to open. They ask the representative to assign them — and this
 * block gives the representative what the 担当者 form needs (the 利用者ID), ready to send. The API has
 * no user directory, so the representative's name cannot be looked up here: the request is written
 * for whoever the person asks (chat, mail, in person).
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
    '割り当ては、案件の画面の「担当者」から行えます。'
  ].join('\n');
}

export function AssignmentRequest({ requester }: { requester: AssignmentRequester }) {
  const text = assignmentRequestText(requester);
  return (
    <section className="p4-assignment-request" aria-labelledby="assignment-request-title" data-section="assignment-request">
      <h3 id="assignment-request-title" className="p4-assignment-request-title">
        <Bilingual ja="代表者に割り当てを依頼" ko="대표자에게 배정을 요청" />
      </h3>
      <p>
        <Bilingual
          ja="下の文を代表者に送ってください。代表者が案件の「担当者」であなたを割り当てると、この画面を再読み込みするだけで案件が開けます。"
          ko="아래 문장을 대표자에게 보내세요. 대표자가 안건의 「担当者」에서 배정하면, 이 화면을 새로고침하는 것만으로 안건을 열 수 있습니다."
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
