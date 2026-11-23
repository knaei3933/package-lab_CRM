import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { callApi, SESSION_COOKIE } from '../../lib/api';
import { modernizeLegacyWords, standardTerm } from '../../lib/terms';

/**
 * M5 Japanese status surface (design section 8). Server-rendered: the labels
 * are fetched from the API endpoint that serves the shared @kanei/core mapping
 * (GET /api/status-labels) with the caller's session cookie, so the web
 * skeleton never re-spells a label of its own. Without a session the page says
 * so instead of inventing labels.
 */
export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: '状態表示' };


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
  { heading: 'フィルム発注の状態', note: '発注から納品の確認までのF1フィルム商材の流れ', key: 'filmSupplyOrderStates' },
  { heading: 'メーカー発注書の状態', note: 'メーカー発注書の承認・送信・受領の状態', key: 'makerPurchaseOrderStatuses' },
  { heading: '校了の組織', note: 'デザインごとの校了（承認）組織', key: 'approvalOrganizations' },
  { heading: '充填製品納品の確認状態', note: '納品行ごとの納品証跡確認状態', key: 'fillingDeliveryConfirmationStates' },
  { heading: '手数料計算の準備状態', note: '納品証跡がそろって初めて手数料計算が可能になります', key: 'commissionReadinessStates' }
];

const cardStyle = { border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 16 } as const;
const rowStyle = {
  display: 'flex',
  // UI batch C (2-⑥): the code and its label stack at 390px instead of overflowing.
  flexWrap: 'wrap' as const,
  justifyContent: 'space-between',
  gap: 16,
  padding: '8px 0',
  borderBottom: '1px solid var(--line)'
} as const;

async function loadStatusLabels(): Promise<
  { ok: true; payload: StatusLabelsPayload } | { ok: false; message: string }
> {
  const cookieStore = await cookies();
  if (!cookieStore.get(SESSION_COOKIE)?.value) {
    return { ok: false, message: 'ログインすると表示されます。' };
  }
  // P0 R04/R09: the shared client — 10 s timeout, operator text, no internal address (H9).
  const result = await callApi<StatusLabelsPayload>('/api/status-labels');
  if (!result.ok || !result.data) return { ok: false, message: result.error ?? 'ステータス一覧を取得できませんでした。' };
  return { ok: true, payload: result.data };
}

export default async function StatusPage() {
  const labels = await loadStatusLabels();

  return (
    <section>
      <h1 className="sx-2b405ed">ステータス一覧（日本語表記）</h1>
      <p className="sx-3ff301c">
        F1案件で使う状態の日本語ラベル一覧です。ラベルはシステムの共通定義をそのまま表示しています。
      </p>

      {!labels.ok && (
        <p className="sx-e5142ac">
          {labels.message}
        </p>
      )}

      {labels.ok && (
        <div className="sx-776e8ca">
          {sectionTitles.map((section) => (
            <div className="ui-card" key={section.key}>
              <h2 className="sx-291e42c">{section.heading}</h2>
              <p className="sx-1578276">{section.note}</p>
              <div>
                {labels.payload[section.key].map((entry) => (
                  <div key={entry.key} style={rowStyle}>
                    <code className="sx-5ca78ee">{entry.key}</code>
                    {/* p5 M16: the standard word first (film states), else the API label with its legacy words replaced. */}
                    <span>{(section.key === 'filmSupplyOrderStates' ? standardTerm('filmSupplyOrderStates', entry.key)?.ja : null) ?? modernizeLegacyWords(entry.label)}</span>
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
