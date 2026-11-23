import { callApi } from './api';
import type { ProjectSummary } from './project-data';

/**
 * P4 N1: 担当の割り当て (p4-server REPORT §2-1). The API (admin only) lists, adds and removes a
 * project's assignments; the web shows them on the project overview, only to the representative.
 * The API decides every request (role, project, duplicates) — nothing here is a rule.
 *
 * The API has no user directory, so the representative picks from the people already assigned to
 * another project, or types a 利用者ID (the person shows their own ID on their 「開ける案件がありません」
 * screen — AssignmentRequest). Both end in the same POST {userId}.
 */
export interface ProjectAssignment {
  id: string;
  userId: string;
  displayName: string;
  role: string;
  isActive: boolean;
  assignedAt: string | null;
}

export interface AssignmentCandidate {
  userId: string;
  displayName: string;
  role: string;
}

export interface AssignmentsView {
  assignments: ProjectAssignment[];
  assignableRoles: string[];
  /** Set when the list could not be read (said on the screen, never shown as 「担当者なし」). */
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.trim());
}

/** The user to assign from the add form: the one picked from the list, else the typed 利用者ID. */
export function chosenUserId(formData: FormData): string | null {
  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };
  const value = read('candidateUserId') || read('typedUserId');
  return isUserId(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pure: one assignment row of the API's answer. */
export function assignmentFrom(value: unknown): ProjectAssignment | null {
  const row = record(value);
  const userId = str(row.userId);
  const displayName = str(row.displayName);
  if (!userId || !displayName) return null;
  return {
    id: str(row.id) ?? userId,
    userId,
    displayName,
    role: str(row.role) ?? '',
    isActive: row.isActive !== false,
    assignedAt: str(row.assignedAt)
  };
}

/** Pure: GET …/assignments in the screen's shape. */
export function assignmentsFrom(data: unknown): Omit<AssignmentsView, 'error'> {
  const body = record(data);
  const list = Array.isArray(body.assignments) ? body.assignments : [];
  return {
    assignments: list.map(assignmentFrom).filter((row): row is ProjectAssignment => row !== null),
    assignableRoles: Array.isArray(body.assignableRoles) ? body.assignableRoles.filter((role): role is string => typeof role === 'string') : []
  };
}

export async function loadProjectAssignments(projectId: string): Promise<AssignmentsView> {
  const result = await callApi<unknown>(`/api/projects/${encodeURIComponent(projectId)}/assignments`);
  if (!result.ok) {
    return { assignments: [], assignableRoles: [], error: result.error ?? '担当者の一覧を読み込めませんでした。' };
  }
  return { ...assignmentsFrom(result.data), error: null };
}

/** Pure: people assigned somewhere else and not (yet) here, once each, active ones only. */
export function candidatesFrom(
  here: readonly ProjectAssignment[],
  elsewhere: ReadonlyArray<readonly ProjectAssignment[]>
): AssignmentCandidate[] {
  const taken = new Set(here.map((row) => row.userId));
  const seen = new Map<string, AssignmentCandidate>();
  for (const rows of elsewhere) {
    for (const row of rows) {
      if (!row.isActive || taken.has(row.userId) || seen.has(row.userId)) continue;
      seen.set(row.userId, { userId: row.userId, displayName: row.displayName, role: row.role });
    }
  }
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
}

const CANDIDATE_PROJECT_LIMIT = 20;

/** The people assigned to the representative's other projects (one read each, a bounded number). */
export async function loadAssignmentCandidates(
  openProjectId: string,
  here: readonly ProjectAssignment[],
  projects: readonly Pick<ProjectSummary, 'id'>[]
): Promise<AssignmentCandidate[]> {
  const others = projects.filter((project) => project.id !== openProjectId).slice(0, CANDIDATE_PROJECT_LIMIT);
  const answers = await Promise.all(others.map((project) => loadProjectAssignments(project.id)));
  return candidatesFrom(here, answers.filter((answer) => !answer.error).map((answer) => answer.assignments));
}

export const ASSIGNMENT_ROLE_LABELS: Readonly<Record<string, string>> = {
  staff: '担当者',
  viewer: '閲覧',
  auditor: '監査'
};
