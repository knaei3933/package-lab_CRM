import { describe, expect, it, vi } from 'vitest';

/**
 * P0 integration (found in the end-to-end run): a document version is made by
 * DOCUMENT_VERSION_UPLOADED only. DOCUMENT_VERSION_VIEWED (each Message-ID read
 * of the approvals screen) and DOCUMENT_VERSION_DOWNLOADED on the same entity
 * were listed as extra versions; each render then read every copy again and the
 * list doubled (511 view rows for one EML).
 */
const DOC = '01a1f7d6-78dc-71f1-b81e-0ccc20195fcc';
const VERSION = DOC;
const row = (action: string, entityType: string, entityId: string, after: Record<string, unknown>, minute: number) => ({
  id: `${action}-${minute}`, action, entityType, entityId, beforeState: null, afterState: after,
  occurredAt: `2026-11-20T07:${String(minute).padStart(2, '0')}:00.000Z`, requestMetadata: null, actor: null
});
const events: Record<string, unknown[]> = {
  document: [row('DOCUMENT_CREATED', 'document', DOC, { documentType: 'approval_evidence', issuerEntity: 'seven', originalFilename: 'approval.eml', verificationStatus: 'unverified' }, 1)],
  document_version: [
    row('DOCUMENT_VERSION_UPLOADED', 'document_version', VERSION, { documentId: DOC, versionNumber: 1, originalFilename: 'approval.eml' }, 2),
    ...Array.from({ length: 5 }, (_, i) => row('DOCUMENT_VERSION_VIEWED', 'document_version', VERSION, { documentId: DOC }, 3 + i)),
    row('DOCUMENT_VERSION_DOWNLOADED', 'document_version', VERSION, { documentId: DOC }, 9)
  ]
};
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project-a',
  loadSession: async () => ({ kind: 'anonymous' }),
  loadSessionUser: async () => null,
  callApi: async (path: string) => {
    const entity = /entityType=([a-z_]+)/.exec(path)?.[1];
    if (entity) return { ok: true, status: 200, data: { events: events[entity] ?? [] }, error: null };
    if (path.startsWith('/api/projects/')) return { ok: true, status: 200, data: { id: 'project-a', code: 'P', name: 'P', route: 'F1', status: 'active' }, error: null };
    return { ok: true, status: 200, data: {}, error: null };
  }
}));

const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');

describe('document versions come from uploads only', () => {
  it('one upload + views + a download is one version', async () => {
    const workspace = await loadWorkspace('project-a');
    const document = workspace.documents.find((entry) => entry.id === DOC);
    expect(document?.versions.map((version) => version.id)).toEqual([VERSION]);
  });
});
