import ReportAnalyzer from '../../components/ReportAnalyzer';

export default function CharacterSearchPage() {
  return (
    <main className="page">
      <header className="hero">
        <h1>キャラクター検索</h1>
        <p>キャラクター候補とコンテンツ履歴を取得し、分析対象の条件に繋げます。</p>
      </header>
      <ReportAnalyzer initialMode="character" lockMode />
    </main>
  );
}
