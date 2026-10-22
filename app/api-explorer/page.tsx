"use client";

import { useEffect, useRef, useState } from "react";
import { AggregatesCard, BrushCard, CustomersCard, OrdersCard, SearchCard } from "./_components/EndpointList";

const PORTFOLIO_URL = "https://bganguly.github.io/#clickhouse";

export default function ApiExplorer() {
  const [wakeStatus, setWakeStatus] = useState<"waking"|"ready"|null>(null);
  const [wakeMs, setWakeMs] = useState(0);
  const wakeStart    = useRef(0);
  const wakeInterval = useRef<ReturnType<typeof setInterval>|null>(null);
  const slowTimer    = useRef<ReturnType<typeof setTimeout>|null>(null);
  const readyTimer   = useRef<ReturnType<typeof setTimeout>|null>(null);

  useEffect(() => {
    wakeStart.current = performance.now();
    slowTimer.current = setTimeout(() => {
      setWakeStatus("waking");
      setWakeMs(0);
      wakeInterval.current = setInterval(() => setWakeMs(Math.round(performance.now() - wakeStart.current)), 100);
    }, 800);

    const markReady = () => {
      if (slowTimer.current)    { clearTimeout(slowTimer.current);   slowTimer.current = null; }
      if (wakeInterval.current) { clearInterval(wakeInterval.current); wakeInterval.current = null; }
      setWakeStatus(s => (s === "waking" ? "ready" : null));
      readyTimer.current = setTimeout(() => setWakeStatus(s => (s === "ready" ? null : s)), 1200);
    };

    fetch("/api/health").then(markReady).catch(markReady);

    return () => {
      if (slowTimer.current)    clearTimeout(slowTimer.current);
      if (wakeInterval.current) clearInterval(wakeInterval.current);
      if (readyTimer.current)   clearTimeout(readyTimer.current);
    };
  }, []);

  return (
    <div style={{ background:"#0f0f13", minHeight:"100vh" }} className="text-zinc-100 font-sans antialiased">
      <style>{`
        @keyframes api-explorer-spin { to { transform: rotate(360deg); } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
      `}</style>

      <nav className="fixed top-0 inset-x-0 z-40 border-b"
        style={{ borderColor:"rgba(255,255,255,0.06)", background:"rgba(15,15,19,0.9)", backdropFilter:"blur(16px)" }}>
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <a href={PORTFOLIO_URL}
            onClick={e => {
              e.preventDefault();
              const url = PORTFOLIO_URL;
              try { if (window.opener && !window.opener.closed) { window.opener.location.href = url; window.close(); return; } } catch (_) {}
              window.location.href = url;
            }}
            className="flex items-center gap-2 text-sm transition-colors"
            style={{ color:"#71717a" }}
            onMouseEnter={e => (e.currentTarget.style.color="#f4f4f5")}
            onMouseLeave={e => (e.currentTarget.style.color="#71717a")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M5 12l7-7M5 12l7 7"/>
            </svg>
            Portfolio
          </a>
          <div className="flex items-center gap-3">
            {wakeStatus === "waking" && (
              <div style={{ display:"flex", alignItems:"center", gap:"0.5rem",
                background:"rgba(251,191,36,0.12)", border:"1px solid rgba(251,191,36,0.30)",
                color:"#fbbf24", borderRadius:"0.5rem", padding:"0.375rem 0.75rem", fontSize:"0.75rem" }}>
                <span style={{ width:10, height:10, borderRadius:"50%", border:"2px solid #fbbf24",
                  borderTopColor:"transparent", display:"inline-block",
                  animation:"api-explorer-spin 0.7s linear infinite" }} />
                Backend waking up —
                <span style={{ fontFamily:"monospace", marginLeft:"4px" }}>{(wakeMs/1000).toFixed(1)}s</span>
              </div>
            )}
            {wakeStatus === "ready" && (
              <div style={{ display:"flex", alignItems:"center", gap:"0.5rem",
                background:"rgba(34,197,94,0.12)", border:"1px solid rgba(34,197,94,0.30)",
                color:"#4ade80", borderRadius:"0.5rem", padding:"0.375rem 0.75rem", fontSize:"0.75rem" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Backend ready
              </div>
            )}
            <span className="text-xs" style={{ color:"#3f3f46" }}>ClickHouse Dashboard</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background:"rgba(99,102,241,0.12)", border:"1px solid rgba(99,102,241,0.3)", color:"#a5b4fc" }}>
              Next.js 16 · ClickHouse Cloud · AWS
            </span>
          </div>
        </div>
      </nav>

      <section className="pt-28 pb-10 px-6 max-w-5xl mx-auto">
        <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color:"#818cf8" }}>API Explorer</p>
        <h1 className="text-2xl font-bold mb-2" style={{ color:"#f4f4f5" }}>Live API — ClickHouse Dashboard</h1>
        <p className="text-sm max-w-xl" style={{ color:"#71717a" }}>
          Run real requests against the Next.js 16 API routes backed by ClickHouse Cloud on AWS.
        </p>
        <div className="flex items-center gap-2 mt-4">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono"
            style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", color:"#52525b" }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background:"#818cf8" }} />
            {typeof window !== "undefined" ? window.location.origin : ""}/api
          </div>
          {process.env.NEXT_PUBLIC_DEMO_SCALE && (
            <span className="text-[11px] px-2 py-1 rounded-lg font-medium"
              style={{ background:"rgba(99,102,241,0.10)", border:"1px solid rgba(99,102,241,0.25)", color:"#818cf8" }}>
              demo · {process.env.NEXT_PUBLIC_DEMO_SCALE}
            </span>
          )}
        </div>
      </section>

      <section className="px-6 pb-24 max-w-5xl mx-auto space-y-5">
        <OrdersCard />
        <SearchCard />
        <AggregatesCard />
        <BrushCard />
        <CustomersCard />
      </section>
    </div>
  );
}
