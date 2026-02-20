import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'FFLogs Timeline Viewer',
  description: 'Boss and party ability usage timeline from FFLogs output JSONs.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
