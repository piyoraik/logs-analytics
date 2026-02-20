import ReportAnalyzer from './components/ReportAnalyzer';

export default function Page() {
  return (
    <main className="page">
      <header className="hero">
        <h1>FFLogs Timeline Grid</h1>
        <p>Webから report fights 一覧を取得し、そのまま解析・可視化します。</p>
      </header>
      <ReportAnalyzer />
    </main>
  );
}
