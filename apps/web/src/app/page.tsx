import Link from 'next/link';

const capabilities = [
  { title: 'F1案件登録', status: 'API契約実装済み' },
  { title: 'セッション認証', status: 'サーバー強制チェック' },
  { title: '権限チェック', status: '業務 × 案件 × 操作' },
  { title: 'direct_film / F2', status: '作成禁止（422）' }
];

export default function HomePage() {
  return (
    <section>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>KANEI CRM MVP</h1>
      <p>隔離環境で動作するF1専用M0基盤です。既存CRMには接続しません。</p>
      <p style={{ marginTop: 16 }}>
        <Link href="/status" style={{ color: '#1d4ed8' }}>ステータス一覧（日本語表記）を見る</Link>
      </p>
      <div style={{ display: 'grid', gap: 16, marginTop: 32 }}>
        {capabilities.map((item) => (
          <div key={item.title} style={{ border: '1px solid #d8dfeb', borderRadius: 8, padding: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{item.title}</h2>
            <p style={{ margin: '8px 0 0', color: '#526173' }}>{item.status}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
