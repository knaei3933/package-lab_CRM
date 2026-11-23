import type { ProjectSummary } from '../lib/project-data';
import { projectPath } from '../lib/project-route';
import { AssignmentRequest } from './AssignmentRequest';
import type { AssignmentRequester } from './AssignmentRequest';

/**
 * P1 R20 (K1): an address whose 案件コード this operator cannot open — a typo,
 * a deleted project, an assignment removed, or a link from another person. The
 * screen says so and lists the projects this operator can open (each a link),
 * so nobody is left on a dead end. When the list itself could not be read the
 * screen says that instead (never 「ありません」 after a failed read).
 */
export const PROJECT_NOT_FOUND_TITLE = 'この案件は見つかりません';

export function ProjectNotFound({
  code,
  projects,
  listError,
  requester
}: {
  code: string | null;
  projects: readonly ProjectSummary[];
  listError: string | null;
  /** P4 N1: who is asking; with no project to open, an assignable role gets 「代表者に割り当てを依頼」. */
  requester?: AssignmentRequester | undefined;
}) {
  return (
    <section className="p1-notfound" aria-labelledby="p1-notfound-title">
      <h1 id="p1-notfound-title" className="p1-title">{listError ? '案件の一覧を読み込めませんでした' : PROJECT_NOT_FOUND_TITLE}</h1>
      {listError ? (
        <p className="p1-lead">少し待ってから、この画面を再読み込みしてください。（理由: {listError}）</p>
      ) : (
        <>
          <p className="p1-lead">
            {code ? <>案件コード「<span translate="no">{code}</span>」は、</> : 'このアドレスの案件は、'}
            存在しないか、あなたの担当ではありません。開ける案件から選んでください。
          </p>
          {projects.length === 0 ? (
            <>
              <p className="p1-lead">あなたが開ける案件はありません。担当の割り当てを代表者に依頼してください。</p>
              {requester && requester.role !== 'admin' ? <AssignmentRequest requester={requester} /> : null}
            </>
          ) : (
            <ul className="p1-link-list" aria-label="開ける案件">
              {projects.map((project) => (
                <li key={project.id}>
                  <a href={projectPath(project.code)}>
                    <span translate="no">{project.code}</span>（{project.name}）
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
