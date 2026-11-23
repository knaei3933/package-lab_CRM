import { ActionForm } from './ActionForm';
import { Bilingual } from './Bilingual';
import { SelectField, TextField } from './fields';
import { addAssignmentAction, removeAssignmentAction } from '../app/assignment-actions';
import { ASSIGNMENT_ROLE_LABELS } from '../lib/assignments';
import type { AssignmentCandidate, AssignmentsView } from '../lib/assignments';
import { formatTimestamp } from '../lib/vocabulary';

/**
 * P4 N1: the project overview's 「担当者」 section. Only the representative sees it (the screen draws it
 * for the admin role; the API refuses everyone else, 403 CEO_ONLY). It shows who may open this project
 * and lets the representative add or remove a person — until now that was SQL only, so a new staff
 * member saw 「開ける案件がありません」 and nobody could fix it from the screen.
 *
 * Adding: pick a person already assigned to another project, or paste the 利用者ID the person shows on
 * their own 「開ける案件がありません」 screen (the API has no user directory). The representative is never
 * listed: they open every project.
 */
export function ProjectAssignmentsPanel({ view, candidates }: { view: AssignmentsView; candidates: AssignmentCandidate[] }) {
  const roleName = (role: string) => ASSIGNMENT_ROLE_LABELS[role] ?? role;
  return (
    <section className="p1-panel p4-assignments" aria-labelledby="project-assignments-title" data-section="assignments">
      <h2 id="project-assignments-title" className="p1-section-title">
        <Bilingual ja="担当者" ko="담당자" />
      </h2>
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
      <ActionForm
        action={addAssignmentAction}
        submitLabel="担当者に割り当てる"
        hint="別の案件の担当者から選ぶか、本人が見せる「利用者ID」を貼り付けます。代表者を割り当てる必要はありません。"
        hintKo="다른 안건의 담당자 중에서 고르거나, 본인이 보여 주는 「利用者ID」를 붙여 넣습니다. 대표자는 배정할 필요가 없습니다."
      >
        <div className="p1-row">
          {candidates.length > 0 ? (
            <SelectField
              name="candidateUserId"
              label="ほかの案件の担当者から選ぶ"
              includeBlank
              blankLabel="（選ばない）"
              choices={candidates.map((candidate) => ({
                value: candidate.userId,
                label: `${candidate.displayName}（${ASSIGNMENT_ROLE_LABELS[candidate.role] ?? candidate.role}）`
              }))}
              width={320}
            />
          ) : null}
          <TextField
            name="typedUserId"
            label="利用者ID（本人の画面に出る文字列）"
            width={380}
            autoComplete="off"
            spellCheck={false}
            placeholder="例 0192…（貼り付け）"
          />
        </div>
      </ActionForm>
    </section>
  );
}
