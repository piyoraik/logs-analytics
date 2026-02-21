import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="page">
      <header className="hero">
        <h1>FFLogs Timeline</h1>
        <p>利用シーンに合わせて検索方法を選択してください。</p>
      </header>

      <section className="entryGrid" aria-label="Search modes">
        <Link href="/search/report" className="entryCard">
          <span className="entryIcon" aria-hidden="true">🧾</span>
          <h2>レポート検索</h2>
          <p>Report Code からFightを選んでタイムライン表示。</p>
        </Link>

        <Link href="/search/rankings" className="entryCard">
          <span className="entryIcon" aria-hidden="true">🏆</span>
          <h2>ランキング検索</h2>
          <p>Encounter条件でランキング取得後、対象行を表示。</p>
        </Link>

        <Link href="/search/character" className="entryCard">
          <span className="entryIcon" aria-hidden="true">👤</span>
          <h2>キャラクター検索</h2>
          <p>キャラクター候補と履歴から対象条件を絞り込み。</p>
        </Link>
      </section>
    </main>
  );
}
