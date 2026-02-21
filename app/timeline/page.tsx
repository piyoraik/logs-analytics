import TimelineOnly from '../components/TimelineOnly';

export default function TimelinePage() {
  return (
    <main className="page">
      <header className="hero">
        <h1>タイムライン表示</h1>
        <p>上部の条件を変更して、別Fightのタイムラインにそのまま切り替えできます。</p>
      </header>
      <TimelineOnly />
    </main>
  );
}
