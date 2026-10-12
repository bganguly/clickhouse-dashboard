"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { diag } from "@/lib/diag";

export const SLOW_WAKING_MS = 800;
export const WAKE_WINDOW_MS = 30_000;

export const S = {
  glass:    { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" },
  border:   "rgba(255,255,255,0.06)",
  rowBdr:   "rgba(255,255,255,0.04)",
  runBtn:   { background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.4)", color: "#c4b5fd" },
  methodGet:{ background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", color: "#34d399" },
  statCard: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "12px 16px" },
  tableWrap:{ border: "1px solid rgba(255,255,255,0.06)" },
  rawJson:  { background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" },
  errBox:   { background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" },
  input:    { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7" },
};

export function timingStyle(ms: number) {
  if (ms < 300)  return { background:"rgba(16,185,129,0.12)", color:"#34d399", border:"1px solid rgba(16,185,129,0.25)" };
  if (ms < 1000) return { background:"rgba(245,158,11,0.12)", color:"#fbbf24", border:"1px solid rgba(245,158,11,0.25)" };
  return           { background:"rgba(239,68,68,0.12)",  color:"#f87171", border:"1px solid rgba(239,68,68,0.25)" };
}

export async function fetchTimed(path: string) {
  const t0 = performance.now();
  if (diag) console.log(`[api-explorer] → ${path}`);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const ms  = Math.round(performance.now() - t0);
  const src = res.headers.get("X-Cache-Source");
  const cdn = res.headers.get("X-Cache");
  if (diag) {
    const cdnTag = cdn?.startsWith("Hit")  ? "cdn=Hit"
                 : cdn?.startsWith("Miss") ? `cdn=Miss src=${src ?? "?"}`
                 : src                     ? `src=${src}`
                 : "";
    console.log(`[api-explorer] ← ${path} fetch=${ms}ms ${cdnTag}`);
  }
  return { json, ms, src, cdn };
}

export type OrderRow = Record<string, unknown>;

export function Spinner() {
  return (
    <span style={{
      display:"inline-block", width:14, height:14,
      border:"2px solid rgba(139,92,246,0.3)", borderTopColor:"#a78bfa",
      borderRadius:"50%", animation:"api-explorer-spin 0.6s linear infinite",
    }} />
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color:"#52525b" }}>
      <Spinner /> Sending request…
    </div>
  );
}

export function WakingBanner({ wakeMs }: { wakeMs: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs mb-3"
      style={{ background:"rgba(251,191,36,0.08)", border:"1px solid rgba(251,191,36,0.25)", color:"#fbbf24" }}>
      <Spinner />
      <span>DB being brought up from idle to live —</span>
      <span className="ml-1 font-mono tabular-nums opacity-70">{(wakeMs / 1000).toFixed(1)}s</span>
    </div>
  );
}

export function ReadyBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs mb-3"
      style={{ background:"rgba(34,197,94,0.08)", border:"1px solid rgba(34,197,94,0.25)", color:"#4ade80" }}>
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      DB warmed up and fully live — future requests sub-second
    </div>
  );
}

export function useWakeBanner() {
  const [phase, setPhase] = useState<"idle" | "waking" | "ready">("idle");
  const [wakeMs, setWakeMs] = useState(0);
  const phaseRef   = useRef<"idle" | "waking" | "ready">("idle");
  const wakeStart  = useRef(0);
  const wakeIv     = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissTm  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTm     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warm       = useRef(false);

  const setP = (p: "idle" | "waking" | "ready") => { phaseRef.current = p; setPhase(p); };

  useEffect(() => {
    if (phase !== "waking") {
      if (wakeIv.current) { clearInterval(wakeIv.current); wakeIv.current = null; }
      setWakeMs(0);
      return;
    }
    wakeStart.current = Date.now();
    setWakeMs(WAKE_WINDOW_MS);
    wakeIv.current = setInterval(() => setWakeMs(Math.max(0, WAKE_WINDOW_MS - (Date.now() - wakeStart.current))), 100);
    return () => { if (wakeIv.current) { clearInterval(wakeIv.current); wakeIv.current = null; } };
  }, [phase]);

  const onStart = useCallback(() => {
    if (warm.current) return;
    if (slowTm.current) clearTimeout(slowTm.current);
    slowTm.current = setTimeout(() => { slowTm.current = null; setP("waking"); }, SLOW_WAKING_MS);
  }, []);

  const onDone = useCallback((ms: number) => {
    if (slowTm.current) { clearTimeout(slowTm.current); slowTm.current = null; }
    const wasWaking = phaseRef.current === "waking";
    if (wasWaking || (!warm.current && ms >= SLOW_WAKING_MS)) {
      setP("ready");
      if (dismissTm.current) clearTimeout(dismissTm.current);
      dismissTm.current = setTimeout(() => { setP("idle"); warm.current = true; }, 2500);
    } else {
      if (ms < SLOW_WAKING_MS) warm.current = true;
    }
  }, []);

  const onError = useCallback(() => {
    if (slowTm.current) { clearTimeout(slowTm.current); slowTm.current = null; }
    setP("idle");
  }, []);

  return { phase, wakeMs, onStart, onDone, onError };
}

export function MetaBar({ ms, label, src, cdn }: { ms: number; label: string; src?: string|null; cdn?: string|null }) {
  const cdnHit  = cdn?.startsWith("Hit");
  const cdnMiss = cdn?.startsWith("Miss");
  const cacheLabel = cdnHit
    ? "cdn=Hit"
    : cdnMiss
      ? src === "mem"   ? "cdn=Miss · mem=Hit"
      : src === "redis" ? "cdn=Miss · mem=Miss · redis=Hit"
      : src === "ch"    ? "cdn=Miss · mem=Miss · redis=Miss · ch=Hit"
      : src             ? `cdn=Miss · ${src}=Hit`
      :                   "cdn=Miss"
    : src ? `${src}=Hit` : null;
  return (
    <div className="flex items-center gap-3 mb-4 flex-wrap">
      <span className="text-[11px] px-2 py-1 rounded-full font-mono inline-flex items-center gap-1" style={timingStyle(ms)}>
        ⚡ {ms}ms
      </span>
      <span className="text-xs" style={{ color:"#71717a" }}>{label}</span>
      {cacheLabel && (
        <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
          style={{ background:"rgba(129,140,248,0.08)", border:"1px solid rgba(129,140,248,0.2)", color:"#818cf8" }}>
          {cacheLabel}
        </span>
      )}
    </div>
  );
}

export function ErrMsg({ err }: { err: unknown }) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <div className="rounded-lg p-3 text-xs" style={{ color:"#f87171", ...S.errBox }}>
      {msg.includes("fetch") || msg.includes("Failed")
        ? "⚠️ Network error — the service may be sleeping (Cloud Run scales to zero). Try again."
        : `Error: ${msg}`}
    </div>
  );
}

export function RawJson({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[11px] select-none"
        style={{ color: open ? "#a1a1aa" : "#52525b" }}>
        <span style={{ fontSize:"0.55rem", display:"inline-block", transition:"transform 0.15s",
          transform: open ? "rotate(90deg)" : undefined }}>▶</span>
        View raw JSON
      </button>
      {open && (
        <pre className="mt-2 rounded-lg p-3 text-[11px] overflow-auto max-h-48"
          style={{ ...S.rawJson, color:"#71717a", fontFamily:"monospace", whiteSpace:"pre" }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function StatusPill({ s }: { s: string }) {
  const k = s.toLowerCase();
  const style = k.includes("complet") ? { background:"rgba(16,185,129,0.15)", color:"#6ee7b7" }
              : k.includes("pend")    ? { background:"rgba(245,158,11,0.15)", color:"#fcd34d" }
              : k.includes("cancel")  ? { background:"rgba(239,68,68,0.15)",  color:"#fca5a5" }
              : k.includes("process") ? { background:"rgba(99,102,241,0.15)", color:"#a5b4fc" }
              :                         { background:"rgba(100,116,139,0.15)",color:"#94a3b8" };
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={style}>{s}</span>;
}

export function TH({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 font-medium whitespace-nowrap"
      style={{ color:"#71717a", borderBottom:`1px solid ${S.border}` }}>
      {children}
    </th>
  );
}

export function TD({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`px-3 py-2${mono ? " font-mono" : ""}`}
      style={{ color:"#d4d4d8", borderBottom:`1px solid ${S.rowBdr}` }}>
      {children}
    </td>
  );
}

export function OrderTable({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl" style={S.tableWrap}>
      <table className="w-full text-xs border-collapse">
        <thead><tr><TH>#</TH><TH>ID</TH><TH>Status</TH><TH>Total</TH><TH>Customer</TH><TH>Region</TH><TH>Placed</TH></tr></thead>
        <tbody>
          {rows.map((o, i) => {
            const cust = o.customer as Record<string,string>|null;
            const reg  = o.region  as Record<string,string>|null;
            return (
              <tr key={i}>
                <TD><span style={{ color:"#71717a" }}>{i+1}</span></TD>
                <TD mono>{String(o.id ?? "—")}</TD>
                <TD>{o.status ? <StatusPill s={String(o.status)} /> : "—"}</TD>
                <TD mono><span style={{ color:"#34d399" }}>{String(o.currency||"$")}{Number(o.total??0).toFixed(2)}</span></TD>
                <TD>{cust?.name || cust?.firstName || "—"}</TD>
                <TD><span style={{ color:"#71717a" }}>{reg?.name || reg?.code || "—"}</span></TD>
                <TD mono><span style={{ color:"#71717a" }}>{String(o.placedAt??"—").slice(0,10)}</span></TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CustomerTable({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl" style={S.tableWrap}>
      <table className="w-full text-xs border-collapse">
        <thead><tr><TH>#</TH><TH>Name</TH><TH>Email</TH><TH>Region</TH></tr></thead>
        <tbody>
          {rows.map((c, i) => {
            const reg = c.region as Record<string,string>|null;
            const name = String(c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "—");
            return (
              <tr key={i}>
                <TD><span style={{ color:"#71717a" }}>{i+1}</span></TD>
                <TD>{name}</TD>
                <TD mono><span style={{ color:"#a1a1aa", fontSize:"0.7rem" }}>{String(c.email||"—")}</span></TD>
                <TD><span style={{ color:"#71717a" }}>{reg?.name || reg?.code || String(c.regionCode||"—")}</span></TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AggSummary({ rows }: { rows: Array<Record<string,unknown>> }) {
  let totalOrders = 0, totalRevenue = 0;
  rows.forEach(day => {
    Object.values((day.categories as Record<string,{ totalOrders?:number; totalRevenue?:number }>)||{})
      .forEach(c => { totalOrders += c.totalOrders||0; totalRevenue += c.totalRevenue||0; });
  });
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { l:"Total Orders",   v: totalOrders.toLocaleString(),   c:"#f4f4f5" },
          { l:"Est. Revenue",   v:`$${totalRevenue.toLocaleString(undefined,{maximumFractionDigits:0})}`, c:"#34d399" },
          { l:"Days Returned",  v: String(rows.length), c:"#f4f4f5" },
        ].map(({ l, v, c }) => (
          <div key={l} style={S.statCard}>
            <p className="text-[10px] font-medium tracking-wider uppercase mb-1" style={{ color:"#52525b" }}>{l}</p>
            <p className="text-lg font-bold" style={{ color:c }}>{v}</p>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl" style={S.tableWrap}>
        <table className="w-full text-xs border-collapse">
          <thead><tr><TH>Date</TH><TH>Orders</TH><TH>Revenue</TH><TH>Categories</TH></tr></thead>
          <tbody>
            {rows.slice(0,10).map((day, i) => {
              const cats = Object.values((day.categories as Record<string,{totalOrders?:number;totalRevenue?:number}>)||{});
              const dOrders  = cats.reduce((s,c) => s+(c.totalOrders||0), 0);
              const dRevenue = cats.reduce((s,c) => s+(c.totalRevenue||0), 0);
              const catNames = Object.keys((day.categories as object)||{}).slice(0,3).join(", ");
              return (
                <tr key={i}>
                  <TD mono><span style={{ color:"#a1a1aa" }}>{String(day.date)}</span></TD>
                  <TD>{dOrders.toLocaleString()}</TD>
                  <TD mono><span style={{ color:"#34d399" }}>${dRevenue.toLocaleString(undefined,{maximumFractionDigits:0})}</span></TD>
                  <TD><span style={{ color:"#52525b", fontSize:"0.7rem" }}>{catNames}</span></TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Card({ path, subtitle, children }: { path: string; subtitle: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl overflow-hidden" style={S.glass}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-4 px-6 py-4 text-left"
        style={{ transition:"background 0.15s" }}
        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
        onMouseLeave={e => (e.currentTarget.style.background = "")}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full font-semibold" style={S.methodGet}>GET</span>
          <span className="font-mono text-[13px] shrink-0" style={{ color:"#a1a1aa" }}>{path}</span>
          <span className="text-xs hidden sm:block truncate" style={{ color:"#52525b" }}>{subtitle}</span>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="shrink-0 transition-transform duration-200"
          style={{ color:"#52525b", transform: open ? "rotate(180deg)" : undefined }}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      {open && (
        <div className="px-6 pb-6 border-t" style={{ borderColor: S.border }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function RunBtn({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button onClick={onClick} disabled={loading}
      className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-4 py-1.5 disabled:opacity-40 transition-all"
      style={S.runBtn}
      onMouseEnter={e => { if (!loading) (e.currentTarget.style.background = "rgba(139,92,246,0.25)"); }}
      onMouseLeave={e => { (e.currentTarget.style.background = S.runBtn.background); }}>
      {loading
        ? <><Spinner /> Running…</>
        : <><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>Run</>}
    </button>
  );
}

export function DarkInput({ value, onChange, placeholder, onEnter, type = "text", style }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  onEnter?: () => void; type?: string; style?: React.CSSProperties;
}) {
  return (
    <input type={type} value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => e.key === "Enter" && onEnter?.()}
      style={{
        ...S.input, borderRadius:8, padding:"6px 12px", fontSize:"0.8rem",
        fontFamily:"monospace", outline:"none", transition:"border-color 0.15s", ...style,
      }}
      onFocus={e => (e.currentTarget.style.borderColor = "rgba(139,92,246,0.5)")}
      onBlur={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)")}
    />
  );
}

export function mono(label: string, val: string) {
  return (
    <span className="font-mono text-[11px]" style={{ color:"#52525b" }}>
      {label}=<span style={{ color:"#a78bfa" }}>{val}</span>
    </span>
  );
}
