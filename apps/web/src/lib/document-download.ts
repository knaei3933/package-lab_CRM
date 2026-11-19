/**
 * UI batch F (server F1 R1-4 / F2): downloading a stored document version
 * through the web. The browser follows a same-origin link to the relay
 * (app/api/document-versions/[versionId]/download/route.ts), which replays the
 * operator's session to GET /api/document-versions/:versionId/download. The
 * API decides access (assigned staff and the representative; viewer and other
 * projects refused) and records DOCUMENT_VERSION_DOWNLOADED. A refusal comes
 * back to the documents screen as a Japanese notice instead of raw JSON.
 *
 * Plain <a> links only — never next/link, which prefetches and would make the
 * API record a download nobody asked for.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDocumentVersionId(value: string): boolean {
  return UUID.test(value);
}

/** The same-origin link a document version row offers. */
export function documentDownloadHref(versionId: string): string {
  return `/api/document-versions/${encodeURIComponent(versionId)}/download`;
}

export type DownloadRefusal = 'login' | 'forbidden' | 'missing' | 'integrity' | 'invalid' | 'unavailable';

export const DOWNLOAD_REFUSAL_MESSAGES: Readonly<Record<DownloadRefusal, string>> = {
  login: 'ログインの有効期限が切れました。もう一度ログインしてから、ダウンロードしてください。',
  forbidden: 'この書類をダウンロードする権限がありません（閲覧者、または担当外の案件です）。',
  missing: '書類が見つからないか、書類ファイルを読み取れませんでした。一覧を再読み込みして確認してください。',
  integrity: '書類ファイルが登録時の内容と一致しないため、ダウンロードを止めました。管理者に連絡してください。',
  invalid: 'ダウンロードする書類の指定が正しくありません。一覧のリンクから操作してください。',
  unavailable: 'ダウンロードできませんでした。時間をおいてもう一度お試しください。'
};

export function downloadRefusalForStatus(status: number): DownloadRefusal {
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'missing';
  if (status === 409) return 'integrity';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

/** The notice for ?download=…, or null for anything this module did not write. */
export function downloadRefusalMessage(value: unknown): string | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOWNLOAD_REFUSAL_MESSAGES, value)
    ? DOWNLOAD_REFUSAL_MESSAGES[value as DownloadRefusal]
    : null;
}

/** Where a refused download sends the browser back to (relative, same origin). */
export function downloadRefusalLocation(reason: DownloadRefusal): string {
  return `/documents?download=${reason}`;
}
