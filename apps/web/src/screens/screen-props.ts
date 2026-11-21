/**
 * P1 R20: what every project-scoped screen is drawn for — the project the URL
 * names (/p/{code}/…), already resolved against the operator's project list.
 * The screens never read the project from a cookie.
 */
export interface ProjectScreenProps {
  projectId: string;
  projectCode: string;
}
