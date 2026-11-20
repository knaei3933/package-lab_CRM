import type { ProjectSummary } from '../lib/project-data';
import type { ProjectSelection } from '../lib/project-selection';

/**
 * ui/fix-project-select: the dashboard before a project is open. Several
 * projects: one large card per project, the whole card is the button that
 * opens it (a plain form post — works before the script loads). None: why,
 * and what to do next for this role. List not readable: what to try.
 */
export const CHOOSE_TITLE = '作業する案件を選んでください';
export const NONE_TITLE = '開ける案件がありません';
export const LIST_FAILED_TITLE = '案件の一覧を読み込めませんでした';
export const OPEN_PROJECT_LABEL = 'この案件を開く';

export function chooseLead(count: number): string {
  return `あなたが開ける案件は${count}件です。案件を押すと、その案件の進み具合と、あなたが次にやることが表示されます。あとから画面上部の「案件」でいつでも切り替えられます。`;
}

export function noneMessage(role: string): { text: string; next: string } {
  return role === 'admin'
    ? {
        text: 'この環境には、開ける案件がまだ1件もありません（作成前か、すべて削除済みです）。',
        next: '案件の登録は管理者の手順（初期データ登録）で行います。登録したら、この画面を再読み込みしてください。'
      }
    : {
        text: 'あなたが担当する案件が、まだ割り当てられていません。',
        next: '代表者に「担当する案件への割り当て」を依頼してください。割り当てが済んだら、この画面を再読み込みすると案件が表示されます。'
      };
}

export const LIST_FAILED_NEXT = '少し待ってから、この画面を再読み込みしてください。何度も続く場合は、管理者にAPIが動いているか確認を依頼してください。';

export function ProjectChooser({
  selection,
  role,
  openAction
}: {
  selection: Exclude<ProjectSelection, { kind: 'open' }>;
  role: string;
  openAction: (formData: FormData) => Promise<void>;
}) {
  if (selection.kind === 'choose') {
    return (
      <section className="project-chooser" aria-labelledby="project-chooser-title">
        <h2 id="project-chooser-title" className="project-chooser-title">{CHOOSE_TITLE}</h2>
        <p className="project-chooser-lead">{chooseLead(selection.projects.length)}</p>
        <ul className="project-choice-list">
          {selection.projects.map((project: ProjectSummary) => (
            <li key={project.id}>
              <form action={openAction}>
                <input type="hidden" readOnly name="projectId" value={project.id} />
                <button type="submit" className="project-choice">
                  <span className="project-choice-name">{project.name}</span>
                  <span className="project-choice-code" translate="no">{project.code}</span>
                  <span className="project-choice-cta" aria-hidden="true">{OPEN_PROJECT_LABEL}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const message = selection.kind === 'none'
    ? { title: NONE_TITLE, ...noneMessage(role), detail: null }
    : { title: LIST_FAILED_TITLE, text: 'いまは案件の一覧を取得できません。', next: LIST_FAILED_NEXT, detail: selection.error };
  return (
    <section className="project-chooser project-chooser--empty" aria-labelledby="project-chooser-title">
      <h2 id="project-chooser-title" className="project-chooser-title">{message.title}</h2>
      <p className="project-chooser-lead">{message.text}</p>
      <p className="project-chooser-next"><strong>次にやること:</strong> {message.next}</p>
      <p><a className="dash-next-link" href="/dashboard">再読み込み</a></p>
      {message.detail ? <p className="project-chooser-detail">理由（システムの応答）: {message.detail}</p> : null}
    </section>
  );
}
