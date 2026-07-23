'use client';

export default function BackToPortfolio() {
  function handleBack(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    const url = 'https://bganguly.github.io/#clickhouse';
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.location.href = url;
        window.close();
        return;
      }
    } catch (_) {}
    window.location.href = url;
  }
  return (
    <a
      href="https://bganguly.github.io/#clickhouse"
      onClick={handleBack}
      className="fixed top-3 left-3 z-50 inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium no-underline transition-colors"
      style={{
        background: 'rgba(0,0,0,0.65)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: '#d4d4d8',
      }}
      onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
      onMouseLeave={e => (e.currentTarget.style.color = '#d4d4d8')}
    >
      ← Portfolio
    </a>
  );
}
