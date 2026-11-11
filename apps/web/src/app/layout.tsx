import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'KANEI CRM MVP',
  description: 'F1專用 CRM MVP（M0基盤）'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, color: '#172033' }}>
        <main style={{ maxWidth: 960, margin: '48px auto', padding: '0 24px' }}>{children}</main>
      </body>
    </html>
  );
}
