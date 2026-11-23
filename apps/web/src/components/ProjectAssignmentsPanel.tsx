import { ActionForm } from './ActionForm';
import { FocusOnMount } from './FocusOnMount';
import { Bilingual } from './Bilingual';
import { SelectField, TextField } from './fields';
import { addAssignmentAction, removeAssignmentAction } from '../app/assignment-actions';
import { ASSIGNMENT_ROLE_LABELS } from '../lib/assignments';
import type { AssignableDirectory, AssignmentsView } from '../lib/assignments';
import type { AssignmentNotice } from '../lib/assignment-notice';
import { formatTimestamp } from '../lib/vocabulary';

/**
 * P4 N1: the project overview's 「担当者」 section. Only the representative sees it (the screen draws it
 * for the admin role; the API refuses everyone else, 403 CEO_ONLY). It shows who may open this project
 * and lets the representative add or remove a person — until now that was SQL only, so a new staff
 * member saw 「開ける案件がありません」 and nobody could fix it from the screen.
 *
 * p4/web3 (d): adding = picking the person by name from GET /api/assignable-users (active staff / viewer /
 * auditor, minus the people already here). The 利用者ID field is there only when the server cut that list
 * short (`truncated`). The representative is never listed: they open every project.
 * web2b review L-7: the section is 「割り当て」 (its old title 「担当者」 read the same as the staff role label).
 */
export function ProjectAssignmentsPanel({ view, directory, notice = null }: { view: AssignmentsView; directory: AssignableDirectory; notice?: AssignmentNotice | null }) {
  const roleName = (role: string) => ASSIGNMENT_ROLE_LABELS[role] ?? role;
  // The person's name: a removed one is back in the directory, an added one is in this project's list.
  const noticeName = notice
    ? (notice.kind === 'removed'
      ? directory.candidates.find((candidate) => candidate.userId === notice.userId)?.displayName
      : view.assignments.find((assignment) => assignment.userId === notice.userId)?.displayName) ?? '選んだ人'
    : null;
  const canAdd = !view.error && !directory.error && (directory.candidates.length > 0 || directory.truncated);
  return (
    <section className="p1-panel p4-assignments" aria-labelledby="project-assignments-title" data-section="assignments">
      <h2 id="project-assignments-title" className="p1-section-title">
        <Bilingual ja="割り当て（この案件を開ける人）" ko="담당 배정(이 안건을 열 수 있는 사람)" />
      </h2>
      {/* web2b review L-6: always on the page, so a removal (its row and result line are gone) is announced. */}
      <p id="assignment-status" tabIndex={-1} className="p4w3-status" role="status" data-assignment-notice={notice?.kind}>
        {notice && noticeName
          ? notice.kind === 'removed'
            ? `${noticeName} を担当から外しました（${formatTimestamp(notice.at)}）。この人は、この案件を開けなくなりました。`
            : `${noticeName} を担当者に割り当てました（${formatTimestamp(notice.at)}）。この人は、すぐにこの案件を開けます。`
          : null}
      </p>
      {/* p5 R9: after an assignment (or a removal) the result sentence takes the focus — the form that answered is gone. */}
      {notice && noticeName ? <FocusOnMount targetId="assignment-status" signal={`${notice.kind}:${notice.userId}:${notice.at}`} /> : null}
      <p className="p1-muted">
        <Bilingual
          ja="この案件を開ける人です。代表者は、すべての案件を開けるため、ここには出ません。割り当てると、その人はすぐにこの案件を開けます。"
          ko="이 안건을 열 수 있는 사람입니다. 대표자는 모든 안건을 열 수 있어 여기에 표시되지 않습니다. 배정하면 그 사람은 바로 이 안건을 열 수 있습니다."
        />
      </p>
      {view.error ? (
        <p className="p1-banner p1-banner--error" role="alert">担当者の一覧を読み込めませんでした。{view.error}</p>
      ) : view.assignments.length === 0 ? (
        <p className="p4-assignments-empty">
          <Bilingual
            ja="担当者はまだいません。下のフォームで割り当ててください。"
            ko="담당자가 아직 없습니다. 아래 양식에서 배정하세요."
          />
        </p>
      ) : (
        <ul className="p4-assignment-list" aria-label="担当者の一覧">
          {view.assignments.map((assignment) => (
            <li key={assignment.userId} className="p4-assignment" data-user-id={assignment.userId}>
              <div className="p4-assignment-who">
                <span className="p4-assignment-name">{assignment.displayName}</span>
                <span className="p1-muted-inline"> ・ {roleName(assignment.role)}</span>
                {assignment.isActive ? null : <span className="field-warning"> ・ 無効化されています</span>}
                {assignment.assignedAt ? <span className="p1-muted-inline"> ・ {formatTimestamp(assignment.assignedAt)}から</span> : null}
              </div>
              <ActionForm
                action={removeAssignmentAction}
                submitLabel="外す"
                tone="danger"
                submitContext={`${assignment.displayName} をこの案件の担当から`}
                confirm={{
                  title: '担当から外しますか？',
                  body: `${assignment.displayName}（${roleName(assignment.role)}）は、この案件を開けなくなります。`,
                  confirmLabel: '外す'
                }}
              >
                <input type="hidden" readOnly name="userId" value={assignment.userId} />
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      {directory.error ? (
        <p className="p1-banner p1-banner--error" role="alert" data-directory="error">割り当てられる人の一覧を読み込めませんでした。{directory.error}</p>
      ) : !view.error && directory.candidates.length === 0 && !directory.truncated ? (
        <p className="p1-muted" data-directory="empty">
          <Bilingual
            ja="割り当てられる人がいません（有効な担当者・閲覧・監査の利用者が、全員この案件に割り当て済みです）。"
            ko="배정할 수 있는 사람이 없습니다(활성 담당자·열람·감사 사용자가 모두 이 안건에 배정되어 있습니다)."
          />
        </p>
      ) : null}
      {canAdd ? (
        <ActionForm
          action={addAssignmentAction}
          submitLabel="担当者に割り当てる"
          hint="一覧は、有効な担当者・閲覧・監査の利用者です（代表者は割り当て不要）。"
          hintKo="목록은 활성 상태인 담당자·열람·감사 사용자입니다(대표자는 배정 불필요)."
        >
          <div className="p1-row">
            {directory.candidates.length > 0 ? (
              <SelectField
                name="candidateUserId"
                label="割り当てる人"
                required={!directory.truncated}
                includeBlank
                blankLabel="（選ぶ）"
                choices={directory.candidates.map((candidate) => ({
                  value: candidate.userId,
                  label: `${candidate.displayName}（${roleName(candidate.role)}）`
                }))}
                width={320}
              />
            ) : null}
            {directory.truncated ? (
              <TextField
                name="typedUserId"
                label="一覧にない人の利用者ID"
                width={380}
                autoComplete="off"
                spellCheck={false}
                placeholder="例 0192…（貼り付け）"
                hint="さらにいます。一覧にない人は、本人の画面に出る利用者IDを貼り付けてください。"
              />
            ) : null}
          </div>
        </ActionForm>
      ) : null}
    </section>
  );
}
