import { cookies } from 'next/headers';
import { loadSession, PROJECT_COOKIE } from './api';
import { loadSelectableProjectList } from './project-data';
import { decideProjectSelection } from './project-selection';
import type { ProjectSelection } from './project-selection';
import { decodeRouteCode, LAST_PROJECT_COOKIE } from './project-route';
import { pickLegacyProject } from './project-route-server';

/**
 * ui/fix-project-select → P1 R20: the project the home screen opens. The
 * remembered choice is the last project opened in this browser (the
 * LAST_PROJECT_COOKIE code middleware writes on /p/{code}), else the legacy
 * selection cookie, else the operator's only project. A remembered project that
 * is not in the operator's list is simply not opened (no message). The screen
 * then moves to /p/{code}; nothing here writes a cookie or decides a write.
 */
export async function projectSelectionFor(_returnTo: string): Promise<ProjectSelection> {
  // P0 R04 (B4): without a usable session the layout shows its notice; no list read.
  const session = await loadSession();
  if (session.kind !== 'user') return { kind: 'none' };
  const [store, list] = await Promise.all([cookies(), loadSelectableProjectList()]);
  const lastCode = decodeRouteCode(store.get(LAST_PROJECT_COOKIE)?.value ?? null);
  const legacyId = store.get(PROJECT_COOKIE)?.value ?? null;
  if (list.error) return decideProjectSelection(null, list).selection;
  const remembered = pickLegacyProject({ lastCode, legacyId }, list.projects);
  if (remembered) return { kind: 'open', projectId: remembered.id };
  return decideProjectSelection(null, list).selection;
}
