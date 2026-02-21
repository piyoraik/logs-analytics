import ReportAnalyzer from '../../components/ReportAnalyzer';

export default function RankingsSearchPage() {
  return (
    <main className="page">
      <header className="hero">
        <h1>ランキング検索</h1>
        <p>Encounter条件でランキングを取得し、対象行のタイムラインを表示します。</p>
      </header>
      <ReportAnalyzer initialMode="rankings" lockMode />
    </main>
  );
}
