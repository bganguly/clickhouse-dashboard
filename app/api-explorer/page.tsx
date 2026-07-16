"use client";

import { useRef, useState } from "react";

const PORTFOLIO_URL = "https://bganguly.github.io/?open=nextjs";

// ── Palette constants (match GCP api-explorer.html) ──────────────────────────
const S = {
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

function timingStyle(ms: number) {
  if (ms < 300)  return { background:"rgba(16,185,129,0.12)", color:"#34d399", border:"1px solid rgba(16,185,129,0.25)" };
  if (ms < 1000) return { background:"rgba(245,158,11,0.12)", color:"#fbbf24", border:"1px solid rgba(245,158,11,0.25)" };
  return           { background:"rgba(239,68,68,0.12)",  color:"#f87171", border:"1px solid rgba(239,68,68,0.25)" };
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span style={{
      display:"inline-block", width:14, height:14,
      border:"2px solid rgba(139,92,246,0.3)", borderTopColor:"#a78bfa",
      borderRadius:"50%", animation:"api-explorer-spin 0.6s linear infinite",
    }} />
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color:"#52525b" }}>
      <Spinner /> Sending request…
    </div>
  );
}

function MetaBar({ ms, label }: { ms: number; label: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="text-[11px] px-2 py-1 rounded-full font-mono inline-flex items-center gap-1" style={timingStyle(ms)}>
        ⚡ {ms}ms
      </span>
      <span className="text-xs" style={{ color:"#71717a" }}>{label}</span>
    </div>
  );
}

function ErrMsg({ err }: { err: unknown }) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <div className="rounded-lg p-3 text-xs" style={{ color:"#f87171", ...S.errBox }}>
      {msg.includes("fetch") || msg.includes("Failed")
        ? "⚠️ Network error — the service may be sleeping (Cloud Run scales to zero). Try again."
        : `Error: ${msg}`}
    </div>
  );
}

function RawJson({ data }: { data: unknown }) {
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

function StatusPill({ s }: { s: string }) {
  const k = s.toLowerCase();
  const style = k.includes("complet") ? { background:"rgba(16,185,129,0.15)", color:"#6ee7b7" }
              : k.includes("pend")    ? { background:"rgba(245,158,11,0.15)", color:"#fcd34d" }
              : k.includes("cancel")  ? { background:"rgba(239,68,68,0.15)",  color:"#fca5a5" }
              : k.includes("process") ? { background:"rgba(99,102,241,0.15)", color:"#a5b4fc" }
              :                         { background:"rgba(100,116,139,0.15)",color:"#94a3b8" };
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={style}>{s}</span>;
}

// ── Tables ────────────────────────────────────────────────────────────────────

type OrderRow = Record<string, unknown>;

function TH({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 font-medium whitespace-nowrap"
      style={{ color:"#71717a", borderBottom:`1px solid ${S.border}` }}>
      {children}
    </th>
  );
}
function TD({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`px-3 py-2${mono ? " font-mono" : ""}`}
      style={{ color:"#d4d4d8", borderBottom:`1px solid ${S.rowBdr}` }}>
      {children}
    </td>
  );
}

function OrderTable({ rows }: { rows: OrderRow[] }) {
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

function CustomerTable({ rows }: { rows: OrderRow[] }) {
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

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchTimed(path: string) {
  const t0 = performance.now();
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return { json, ms: Math.round(performance.now() - t0) };
}

// ── Card shell ────────────────────────────────────────────────────────────────

function Card({ path, subtitle, children }: { path: string; subtitle: string; children: React.ReactNode }) {
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

function RunBtn({ onClick, loading }: { onClick: () => void; loading: boolean }) {
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

function DarkInput({ value, onChange, placeholder, onEnter, type = "text", style }: {
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

function mono(label: string, val: string) {
  return (
    <span className="font-mono text-[11px]" style={{ color:"#52525b" }}>
      {label}=<span style={{ color:"#a78bfa" }}>{val}</span>
    </span>
  );
}

// ── Individual endpoint cards ─────────────────────────────────────────────────

function OrdersCard() {
  const [loading, setLoading] = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number } | null>(null);
  const [err, setErr]     = useState<unknown>(null);

  async function run() {
    setLoading(true); setErr(null); setRes(null);
    try { setRes(await fetchTimed("/api/orders?pageSize=10&sort=placedAt&dir=desc")); }
    catch (e) { setErr(e); } finally { setLoading(false); }
  }

  const rows = (res?.json as Record<string,unknown>)?.data as OrderRow[] ?? [];
  const total = (res?.json as Record<string,unknown>)?.total ?? rows.length;

  return (
    <Card path="/api/orders" subtitle="Latest orders — paginated, sorted by date descending">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex flex-wrap gap-2">{mono("pageSize","10")} {mono("sort","placedAt")} {mono("dir","desc")}</div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && <Loading />}
      {!!err  && <ErrMsg err={err} />}
      {res    && <>
        <MetaBar ms={res.ms} label={`${Number(total).toLocaleString()} total orders · showing first 10`} />
        {rows.length > 0 && <OrderTable rows={rows} />}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

function SearchCard() {
  const [q, setQ]         = useState("");
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number } | null>(null);
  const [err, setErr]     = useState<unknown>(null);

  async function run() {
    if (!q.trim()) return;
    setL(true); setErr(null); setRes(null);
    try { setRes(await fetchTimed(`/api/orders?q=${encodeURIComponent(q.trim())}&pageSize=10`)); }
    catch (e) { setErr(e); } finally { setL(false); }
  }

  const rows  = (res?.json as Record<string,unknown>)?.data as OrderRow[] ?? [];
  const total = (res?.json as Record<string,unknown>)?.total ?? rows.length;

  return (
    <Card path="/api/orders?q=…" subtitle="Full-text search via GIN trigram index">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex items-center gap-3">
          <DarkInput value={q} onChange={setQ} placeholder="e.g. gupta, sara frank, east…"
            onEnter={run} style={{ width:220 }} />
          {mono("pageSize","10")}
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {!q.trim() && !loading && !res && !err && (
        <p className="text-xs" style={{ color:"#52525b" }}>Enter a search term above.</p>
      )}
      {loading && <Loading />}
      {!!err   && <ErrMsg err={err} />}
      {res     && <>
        <MetaBar ms={res.ms} label={`${Number(total).toLocaleString()} match${Number(total)!==1?"es":""} for "${q}"`} />
        {rows.length > 0 ? <OrderTable rows={rows} /> : <p className="text-xs" style={{ color:"#71717a" }}>No results.</p>}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

function AggSummary({ rows, from, to }: { rows: Array<Record<string,unknown>>; from: string; to: string }) {
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

function AggregatesCard() {
  const today = new Date().toISOString().slice(0,10);
  const ago60 = new Date(Date.now()-60*864e5).toISOString().slice(0,10);
  const [from, setFrom]   = useState(ago60);
  const [to,   setTo]     = useState(today);
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number } | null>(null);
  const [err, setErr]     = useState<unknown>(null);

  async function run() {
    if (!from||!to) return;
    setL(true); setErr(null); setRes(null);
    try { setRes(await fetchTimed(`/api/aggregates?from=${from}&to=${to}&topCategories=3`)); }
    catch (e) { setErr(e); } finally { setL(false); }
  }

  const rawData = (res?.json as Record<string,unknown>)?.data ?? res?.json;
  const rows    = Array.isArray(rawData) ? rawData as Array<Record<string,unknown>> : [];

  return (
    <Card path="/api/aggregates" subtitle="Pre-aggregated daily totals — millisecond response">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>from</span>
            <DarkInput type="date" value={from} onChange={setFrom} style={{ width:150 }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>to</span>
            <DarkInput type="date" value={to}   onChange={setTo}   style={{ width:150 }} />
          </div>
          {mono("topCategories","3")}
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && <Loading />}
      {!!err   && <ErrMsg err={err} />}
      {res && rows.length > 0 && <>
        <MetaBar ms={res.ms} label={`${rows.length} day${rows.length!==1?"s":""} · ${from} → ${to}`} />
        <AggSummary rows={rows} from={from} to={to} />
        <RawJson data={res.json} />
      </>}
      {res && rows.length === 0 && <p className="text-xs" style={{ color:"#71717a" }}>No data for this range.</p>}
    </Card>
  );
}

function CustomersCard() {
  const [q, setQ]         = useState("");
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number } | null>(null);
  const [err, setErr]     = useState<unknown>(null);

  async function run() {
    setL(true); setErr(null); setRes(null);
    try { setRes(await fetchTimed(`/api/customers?limit=10${q.trim()?`&q=${encodeURIComponent(q.trim())}`:""}`)); }
    catch (e) { setErr(e); } finally { setL(false); }
  }

  const raw  = res?.json;
  const rows = Array.isArray(raw) ? raw as OrderRow[]
    : Array.isArray((raw as Record<string,unknown>)?.data)
    ? (raw as Record<string,unknown>).data as OrderRow[] : [];

  return (
    <Card path="/api/customers" subtitle="Customer list — cursor-paginated">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex items-center gap-3">
          <DarkInput value={q} onChange={setQ} placeholder="e.g. gupta, sara frank…"
            onEnter={run} style={{ width:200 }} />
          {mono("limit","10")}
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && <Loading />}
      {!!err   && <ErrMsg err={err} />}
      {res     && <>
        <MetaBar ms={res.ms} label={`${rows.length} customer${rows.length!==1?"s":""} returned`} />
        {rows.length > 0 ? <CustomerTable rows={rows} /> : <p className="text-xs" style={{ color:"#71717a" }}>No results.</p>}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

function StreamStatusCard() {
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number } | null>(null);
  const [err, setErr]     = useState<unknown>(null);

  async function run() {
    setL(true); setErr(null); setRes(null);
    try { setRes(await fetchTimed("/api/stream/status")); }
    catch (e) { setErr(e); } finally { setL(false); }
  }

  const data = res?.json as { connected?: boolean; count?: number } | null;

  return (
    <Card path="/api/stream/status" subtitle="Whether any dashboard tab has the Live checkbox active">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <p className="text-[11px]" style={{ color:"#52525b" }}>
          Returns the live SSE listener count — used by Quick Order to show its liveness banner.
        </p>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && <Loading />}
      {!!err   && <ErrMsg err={err} />}
      {res && data && <>
        <MetaBar ms={res.ms} label={data.connected ? `${data.count} active listener${(data.count??0)!==1?"s":""}` : "no active listeners"} />
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold px-3 py-1 rounded-full" style={
            data.connected
              ? { background:"rgba(16,185,129,0.15)", color:"#6ee7b7" }
              : { background:"rgba(100,116,139,0.15)", color:"#94a3b8" }
          }>
            {data.connected ? "● live" : "○ not live"}
          </span>
          <span className="font-mono text-xs" style={{ color:"#71717a" }}>count: {data.count}</span>
        </div>
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

// ── Brush card ────────────────────────────────────────────────────────────────

type BrushDay = { date: string; categories?: Record<string,{ totalOrders?:number; totalRevenue?:number }> };

function BrushCard() {
  const [phase, setPhase] = useState<"init"|"loading"|"chart"|"error">("init");
  const [brushData, setBD]  = useState<BrushDay[]>([]);
  const [brushL, setBL]     = useState(0);
  const [brushR, setBR]     = useState(1);
  const [brushRes, setBRes] = useState<{ json:unknown; ms:number; from:string; to:string }|null>(null);
  const [fetching, setF]    = useState(false);

  // Refs to avoid stale closures inside pointer handlers
  const trackRef   = useRef<HTMLDivElement>(null);
  const brushLRef  = useRef(0);
  const brushRRef  = useRef(1);
  const brushDRef  = useRef<BrushDay[]>([]);
  const timerRef   = useRef<ReturnType<typeof setTimeout>|null>(null);
  brushLRef.current = brushL;
  brushRRef.current = brushR;
  brushDRef.current = brushData;

  async function doFetch(l: number, r: number) {
    const data = brushDRef.current;
    if (!data.length) return;
    const [li, ri] = [Math.round(l*(data.length-1)), Math.round(r*(data.length-1))];
    const from = data[li]?.date, to = data[ri]?.date;
    if (!from||!to) return;
    setF(true);
    try {
      const r2 = await fetchTimed(`/api/aggregates?from=${from}&to=${to}&topCategories=1`);
      setBRes({ ...r2, from, to });
    } catch {} finally { setF(false); }
  }

  async function initBrush() {
    setPhase("loading");
    const today = new Date().toISOString().slice(0,10);
    const ago   = new Date(Date.now()-365*864e5).toISOString().slice(0,10);
    try {
      const { json, ms } = await fetchTimed(`/api/aggregates?from=${ago}&to=${today}&topCategories=1`);
      const raw  = (json as Record<string,unknown>).data ?? json;
      const data = Array.isArray(raw) ? raw as BrushDay[] : [];
      if (!data.length) throw new Error("no data");
      setBD(data); setBL(0); setBR(1); setPhase("chart");
      setBRes({ json, ms, from: data[0].date, to: data[data.length-1].date });
    } catch { setPhase("error"); }
  }

  function makeDrag(side: "l"|"r") {
    return {
      onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
        if (!brushDRef.current.length || !trackRef.current) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)||!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const pos  = Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width));
        const min  = 1/Math.max(brushDRef.current.length,1);
        if (side==="l") { const v=Math.min(pos, brushRRef.current-min); brushLRef.current=v; setBL(v); }
        else            { const v=Math.max(pos, brushLRef.current+min); brushRRef.current=v; setBR(v); }
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => doFetch(brushLRef.current, brushRRef.current), 180);
      },
      onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      },
    };
  }

  const totals = brushData.map(d => Object.values(d.categories||{}).reduce((s,c)=>s+(c.totalOrders||0),0));
  const mx     = Math.max(...totals, 1);
  const n      = brushData.length;
  const [li, ri] = n ? [Math.round(brushL*(n-1)), Math.round(brushR*(n-1))] : [0,0];

  const bRaw    = brushRes ? ((brushRes.json as Record<string,unknown>).data ?? brushRes.json) : null;
  const bRows   = Array.isArray(bRaw) ? bRaw as BrushDay[] : [];
  let bOrders=0, bRevenue=0;
  bRows.forEach(d => Object.values(d.categories||{}).forEach(c=>{bOrders+=c.totalOrders||0;bRevenue+=c.totalRevenue||0;}));

  return (
    <Card path="/api/aggregates?from=…&to=…" subtitle="Drag brush handles · sub-second re-fetch">
      <div className="pt-4">
        {phase==="init" && (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="text-xs" style={{ color:"#52525b" }}>
              Loads a year of aggregate data, then drag the handles to re-query any sub-range live.
            </p>
            <RunBtn onClick={initBrush} loading={false} />
          </div>
        )}
        {phase==="loading" && (
          <div className="flex items-center gap-2 text-xs py-2" style={{ color:"#52525b" }}>
            <Spinner /> Loading aggregates…
          </div>
        )}
        {phase==="error" && <ErrMsg err={new Error("No aggregate data for this range")} />}

        {phase==="chart" && (
          <div className="mb-4">
            <svg viewBox="0 0 600 80" width="100%" height="80" preserveAspectRatio="none"
              style={{ display:"block", borderRadius:6 }}>
              {totals.map((v, i) => {
                const x = (i/n)*600, bw = 600/n;
                const h = Math.max(2,(v/mx)*76);
                return <rect key={i} x={x.toFixed(2)} y={(80-h).toFixed(2)}
                  width={(bw-0.4).toFixed(2)} height={h.toFixed(2)}
                  fill={i>=li&&i<=ri?"#818cf8":"#1e293b"} rx="1"/>;
              })}
            </svg>
            <div ref={trackRef} style={{
              position:"relative", height:20, marginTop:8,
              background:"rgba(255,255,255,0.04)", borderRadius:10,
              cursor:"crosshair", userSelect:"none",
            }}>
              <div style={{
                position:"absolute", top:0, height:"100%",
                left:`${brushL*100}%`, width:`${(brushR-brushL)*100}%`,
                background:"rgba(129,140,248,0.18)", border:"1px solid rgba(129,140,248,0.45)",
                borderRadius:10, pointerEvents:"none",
              }}/>
              {(["l","r"] as const).map(side => (
                <div key={side} {...makeDrag(side)} style={{
                  position:"absolute", top:"50%",
                  left:`${(side==="l"?brushL:brushR)*100}%`,
                  transform:"translate(-50%,-50%)", width:10, height:22,
                  background:"#818cf8", borderRadius:3, cursor:"ew-resize",
                  touchAction:"none", zIndex:2, transition:"background 0.1s",
                }}/>
              ))}
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[10px] font-mono" style={{ color:"#52525b" }}>{brushData[li]?.date}</span>
              <span className="text-[10px] font-mono" style={{ color:"#52525b" }}>{brushData[ri]?.date}</span>
            </div>
          </div>
        )}

        {brushRes && (
          <div className="mt-2">
            {fetching ? (
              <div className="flex items-center gap-2 text-xs" style={{ color:"#52525b" }}>
                <Spinner /> Fetching {brushData[li]?.date} → {brushData[ri]?.date}…
              </div>
            ) : (
              <>
                <MetaBar ms={brushRes.ms} label={`${bRows.length} day${bRows.length!==1?"s":""} · ${brushRes.from} → ${brushRes.to}`} />
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { l:"Orders",       v:bOrders.toLocaleString(),  c:"#f4f4f5" },
                    { l:"Est. Revenue", v:`$${bRevenue.toLocaleString(undefined,{maximumFractionDigits:0})}`, c:"#34d399" },
                    { l:"Days in range",v:String(bRows.length), c:"#f4f4f5" },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={S.statCard}>
                      <p className="text-[10px] font-medium tracking-wider uppercase mb-1" style={{ color:"#52525b" }}>{l}</p>
                      <p className="text-xl font-bold" style={{ color:c }}>{v}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ApiExplorer() {
  return (
    <div style={{ background:"#0f0f13", minHeight:"100vh" }} className="text-zinc-100 font-sans antialiased">
      <style>{`
        @keyframes api-explorer-spin { to { transform: rotate(360deg); } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
      `}</style>

      {/* Fixed nav */}
      <nav className="fixed top-0 inset-x-0 z-40 border-b"
        style={{ borderColor:"rgba(255,255,255,0.06)", background:"rgba(15,15,19,0.9)", backdropFilter:"blur(16px)" }}>
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <a href={PORTFOLIO_URL}
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
            <span className="text-xs" style={{ color:"#3f3f46" }}>Next.js Dashboard</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background:"rgba(99,102,241,0.12)", border:"1px solid rgba(99,102,241,0.3)", color:"#a5b4fc" }}>
              Next.js 16 · Prisma · AWS
            </span>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-10 px-6 max-w-5xl mx-auto">
        <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color:"#818cf8" }}>API Explorer</p>
        <h1 className="text-2xl font-bold mb-2" style={{ color:"#f4f4f5" }}>Live API — Next.js Dashboard</h1>
        <p className="text-sm max-w-xl" style={{ color:"#71717a" }}>
          Run real requests against the Next.js 16 API routes backed by Prisma and PostgreSQL 16 on AWS RDS.
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

      {/* Cards */}
      <section className="px-6 pb-24 max-w-5xl mx-auto space-y-5">
        <OrdersCard />
        <SearchCard />
        <AggregatesCard />
        <CustomersCard />
        <StreamStatusCard />
        <BrushCard />
      </section>
    </div>
  );
}
