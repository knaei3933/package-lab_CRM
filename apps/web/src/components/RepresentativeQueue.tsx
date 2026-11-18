import { ActionForm } from './ActionForm';
import type { FormAction } from './ActionForm';
import { DataTable } from './DataTable';
import type { RepresentativeQueue } from '../lib/representative-queue';
import { noteStyle, tdStyle, thStyle } from '../lib/ui';

/**
 * UI batch E (F-23): 「代表者の対応待ち」 across every project, on the first
 * screen after login. Each row opens its project (the same select action as
 * the header's 「案件」); the work itself is recorded on that project's screens.
 */
export function RepresentativeQueuePanel({
  queue,
  selectAction,
  currentProjectId
}: {
  queue: RepresentativeQueue;
  selectAction: FormAction;
  currentProjectId: string | null;
}) {
  const notes = [
    queue.unreadProjects.length > 0 ? `読み込めなかった案件: ${queue.unreadProjects.join('、')}。` : null,
    queue.skippedProjects > 0 ? `案件が多いため、ほかの${queue.skippedProjects}件は表示していません（各案件の画面で確認してください）。` : null
  ].filter((note): note is string => note !== null);
  return (
    <div>
      {queue.tasks.length === 0 ? (
        <p style={noteStyle}>代表者の対応待ちはありません。</p>
      ) : (
        <DataTable caption="代表者の対応待ち（全案件）" captionHidden>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>案件</th>
              <th scope="col" style={thStyle}>発注コード</th>
              <th scope="col" style={thStyle}>代表者がやること</th>
              <th scope="col" style={thStyle}>開く</th>
            </tr>
          </thead>
          <tbody>
            {queue.tasks.map((task) => (
              <tr key={`${task.projectId}-${task.orderCode}-${task.status}`}>
                <td style={tdStyle}>{task.projectLabel}</td>
                <td style={tdStyle}>{task.orderCode}</td>
                <td style={tdStyle}>{task.work}</td>
                <td style={tdStyle}>
                  {task.projectId === currentProjectId ? (
                    <span style={noteStyle}>この案件です（下に表示）</span>
                  ) : (
                    <ActionForm action={selectAction} submitLabel="この案件を開く">
                      <input type="hidden" readOnly name="projectId" value={task.projectId} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {notes.map((note) => (
        <p key={note} style={noteStyle}>{note}</p>
      ))}
    </div>
  );
}
