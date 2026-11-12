import { cookies } from 'next/headers';

/**
 * M5 Japanese status surface (design section 8). Server-rendered: the labels
 * are fetched from the API endpoint that serves the shared @kanei/core mapping
 * (GET /api/status-labels) with the caller's session cookie, so the web
 * skeleton never re-spells a label of its own. Without a session the page says
 * so instead of inventing labels.
 */
export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'kanei_mvp_session';
const apiBaseUrl = process.env.KANEI_API_BASE_URL ?? 'http://127.0.0.1:3081';

interface StatusLabelEntryView {
  key: string;
  label: string;
}

interface StatusLabelsPayload {
  filmSupplyOrderStates: StatusLabelEntryView[];
  makerPurchaseOrderStatuses: StatusLabelEntryView[];
  commissionReadinessStates: StatusLabelEntryView[];
  fillingDeliveryConfirmationStates: StatusLabelEntryView[];
  approvalOrganizations: StatusLabelEntryView[];
}

const sectionTitles: Array<{ heading: string; note: string; key: keyof StatusLabelsPayload }> = [
  { heading: 'フィルム発注の状態', note: '発注から納品・受領確認までのF1フィルム商材の流れ', key: 'filmSupplyOrderStates' },
  { heading: '製造先発注書の状態', note: 'メーカー発注書の承認・送信・受領の状態', key: 'makerPurchaseOrderStatuses' },
  { heading: '校了の組織', note: 'デザインごとの校了（承認）組織', key: 'approvalOrganizations' },
  { heading: '充填製品納品の確認状態', note: '納品行ごとの納品証跡確認状態', key: 'fillingDeliveryConfirmationStates' },
  { heading: '手数料計算の準備状態', note: '納品証跡がそろって初めて手数料計算が可能になります', key: 'commissionReadinessStates' }
];

const cardStyle = { border: '1px solid #d8dfeb', borderRadius: 8, padding: 16 } as const;
const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  padding: '8px 0',
  borderBottom: '1px solid #eef1f6'
} as const;

async function loadStatusLabels(): Promise<
  { ok: true; payload: StatusLabelsPayload } | { ok: false; message: string }
> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    return { ok: false, message: 'APIのセッションCookieがありません。ログイン後に表示されます。' };
  }
  try {
    const response = await fetch(`${apiBaseUrl}/api/status-labels`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store'
    });
    if (!response.ok) {
      return { ok: false, message: `APIがステータス ${response.status} を返しました。ログイン確認が必要です。` };
    }
    return { ok: true, payload: (await response.json()) as StatusLabelsPayload };
  } catch {
    return { ok: false, message: `API（${apiBaseUrl}）に接続できません。` };
  }
}

export default async function StatusPage() {
  const labels = await loadStatusLabels();

  return (
    <section>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>ステータス一覧（日本語表記）</h1>
      <p style={{ color: '#526173' }}>
        F1案件で使う状態の日本語ラベル一覧です。ラベルはAPI（/api/status-labels）から取得した共通定義をそのまま表示しています。
      </p>

      {!labels.ok && (
        <p style={{ marginTop: 24, padding: 16, border: '1px solid #e4b9b9', borderRadius: 8, color: '#8a3b3b' }}>
          {labels.message}
        </p>
      )}

      {labels.ok && (
        <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
          {sectionTitles.map((section) => (
            <div key={section.key} style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 20 }}>{section.heading}</h2>
              <p style={{ margin: '4px 0 12px', color: '#526173', fontSize: 14 }}>{section.note}</p>
              <div>
                {labels.payload[section.key].map((entry) => (
                  <div key={entry.key} style={rowStyle}>
                    <code style={{ color: '#526173' }}>{entry.key}</code>
                    <span>{entry.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
