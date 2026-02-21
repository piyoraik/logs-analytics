import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'FFLogs Timeline Viewer',
  description: 'Boss and party ability usage timeline from FFLogs output JSONs.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="appShell">
          <header className="siteHeader">
            <div className="siteHeaderInner">
              <Link href="/" className="brand">
                FFLogs Timeline Viewer
              </Link>
              <nav className="siteNav" aria-label="Primary">
                <Link href="/">トップ</Link>
                <Link href="/search/report">レポート</Link>
                <Link href="/search/rankings">ランキング</Link>
                <Link href="/search/character">キャラクター</Link>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
