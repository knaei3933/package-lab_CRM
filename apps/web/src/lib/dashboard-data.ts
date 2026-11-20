import { callApi } from './api';
import { ACTIVITY_READ_LIMIT } from './dashboard';
import { loadMakerPaperCleanup, loadMakerPoBoard } from './maker-po-data';
import type { MakerPoBoard } from './maker-po-data';
import type { AuditEventView } from './project-data';

/**
 * UI nav-dashboard: the reads behind the dashboard, all existing GET endpoints
 * answered per role by the API — the maker PO board (which loads the project
 * workspace) and one project-wide audit read for the recent activity.
 */
export interface DashboardData {
  board: MakerPoBoard;
  /** Oldest first, as the API answers; null when the read failed. */
  activity: AuditEventView[] | null;
}

export async function loadDashboardData(projectId: string): Promise<DashboardData> {
  const [board, activity] = await Promise.all([
    loadMakerPoBoard(projectId),
    callApi<{ events: AuditEventView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/audit-history?limit=${ACTIVITY_READ_LIMIT}`
    )
  ]);
  // Review H: loadMakerPoBoard skips the maker paper cleanup of cancelled and
  // frozen orders (the /maker-po page computes it from its own read). Without
  // it a cancelled order with live paper had no next action on the dashboard.
  const closed = board.boards.filter((entry) => entry.closure !== null).map((entry) => entry.order.id);
  const makerPaperCleanup = closed.length > 0 ? await loadMakerPaperCleanup(projectId, closed) : {};
  return {
    board: { ...board, workspace: { ...board.workspace, makerPaperCleanup } },
    activity: activity.ok && activity.data && Array.isArray(activity.data.events) ? activity.data.events : null
  };
}
