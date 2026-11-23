import { cookies } from 'next/headers';
import { loadSession, PROJECT_COOKIE } from './api';
import type { SessionState } from './api';
import { loadSelectableProjectList } from './project-data';
import type { ProjectSummary } from './project-data';
import { decodeRouteCode, LAST_PROJECT_COOKIE, projectPath } from './project-route';

/**
 * P1 R20: the server half of the URL routes. A project code from the address
 * is resolved against GET /api/projects (admin: every live project, staff and
 * viewer: their assignments — the same list the header offers), so an address
 * can at most open a project the operator could open anyway. The API still
 * decides every read and write.
 */
export type RouteProject =
  | { kind: 'open'; project: ProjectSummary; projects: ProjectSummary[] }
  | { kind: 'not-found'; code: string | null; projects: ProjectSummary[] }
  | { kind: 'list-failed'; error: string }
  | { kind: 'no-session'; session: Exclude<SessionState, { kind: 'user' }> };

export async function resolveRouteProject(segment: string): Promise<RouteProject> {
  // P0 R04 (B4): without a usable session the layout shows its notice; no list read.
  const session = await loadSession();
  if (session.kind !== 'user') return { kind: 'no-session', session };
  const code = decodeRouteCode(segment);
  const list = await loadSelectableProjectList();
  if (list.error) return { kind: 'list-failed', error: list.error };
  const project = code ? list.projects.find((candidate) => candidate.code === code) : undefined;
  return project
    ? { kind: 'open', project, projects: list.projects }
    : { kind: 'not-found', code, projects: list.projects };
}

/** Pure: which project an old address (/orders …) opens, from the remembered values and the list. */
export function pickLegacyProject(
  remembered: { lastCode: string | null; legacyId: string | null },
  projects: readonly ProjectSummary[]
): ProjectSummary | null {
  const byCode = remembered.lastCode ? projects.find((project) => project.code === remembered.lastCode) : undefined;
  if (byCode) return byCode;
  const byId = remembered.legacyId ? projects.find((project) => project.id === remembered.legacyId) : undefined;
  if (byId) return byId;
  return projects.length === 1 ? projects[0]! : null;
}

/**
 * The address an old cookie-scoped screen moves to: the same screen under the
 * last project opened here (or the legacy selection cookie, or the operator's
 * only project). Null when there is no such project — the caller sends the
 * operator to the project cards instead.
 */
export async function legacyProjectTarget(screen: string, search: string): Promise<string | null> {
  const session = await loadSession();
  if (session.kind !== 'user') return null;
  const store = await cookies();
  const lastCode = decodeRouteCode(store.get(LAST_PROJECT_COOKIE)?.value ?? null);
  const legacyId = store.get(PROJECT_COOKIE)?.value ?? null;
  const list = await loadSelectableProjectList();
  if (list.error) return null;
  const project = pickLegacyProject({ lastCode, legacyId }, list.projects);
  if (!project) return null;
  return `${projectPath(project.code, screen)}${search}`;
}
