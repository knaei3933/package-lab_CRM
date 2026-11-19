import { apiBaseUrl, readSessionToken, SESSION_COOKIE } from '../../../../../lib/api';
import {
  downloadRefusalForStatus,
  downloadRefusalLocation,
  isDocumentVersionId
} from '../../../../../lib/document-download';
import type { DownloadRefusal } from '../../../../../lib/document-download';

/**
 * UI batch F: same-origin download relay (lib/document-download). Only the
 * session cookie goes up; only the file and its download headers come back —
 * always as an attachment, never sniffed, never cached. Any refusal sends the
 * browser back to the documents screen with a Japanese notice.
 */
export const dynamic = 'force-dynamic';

function backToDocuments(reason: DownloadRefusal): Response {
  return new Response(null, {
    status: 303,
    headers: { location: downloadRefusalLocation(reason), 'cache-control': 'no-store' }
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> }
): Promise<Response> {
  // Review L2: a link on another site must not make the API record a download
  // in the operator's name (the Lax session cookie rides top-level navigations).
  if (request.headers.get('sec-fetch-site') === 'cross-site') return backToDocuments('invalid');
  const { versionId } = await params;
  if (!isDocumentVersionId(versionId)) return backToDocuments('invalid');
  const token = await readSessionToken();
  if (!token) return backToDocuments('login');

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl}/api/document-versions/${encodeURIComponent(versionId)}/download`, {
      method: 'GET',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
      // Review L3: the session cookie is never carried to wherever a redirect points.
      redirect: 'manual'
    });
  } catch {
    return backToDocuments('unavailable');
  }
  if (!upstream.ok || upstream.body === null) {
    // A refusal body is a short JSON message; read it to the end (cancelling
    // the stream instead never settled under Next's fetch — found live).
    await upstream.arrayBuffer().catch(() => undefined);
    return backToDocuments(downloadRefusalForStatus(upstream.status));
  }

  const disposition = upstream.headers.get('content-disposition') ?? '';
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    // The API names the file; anything that is not an attachment is made one.
    'content-disposition': /^attachment(;|$)/i.test(disposition) ? disposition : 'attachment',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox"
  });
  // fetch hands over decoded bytes, so the length only holds for an unencoded answer.
  const length = upstream.headers.get('content-length');
  if (length && /^\d+$/.test(length) && !upstream.headers.get('content-encoding')) headers.set('content-length', length);
  return new Response(upstream.body, { status: 200, headers });
}
