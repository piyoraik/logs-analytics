import ReportAnalyzer from '../../components/ReportAnalyzer';

export default function ReportSearchPage() {
  return (
    <main className="page">
      <header className="hero">
        <h1>レポート検索</h1>
        <p>Report Code からFight一覧を取得し、対象Fightのタイムラインを表示します。</p>
      </header>
      <ReportAnalyzer initialMode="report" lockMode />
    </main>
  );
}
