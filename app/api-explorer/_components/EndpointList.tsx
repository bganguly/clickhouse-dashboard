"use client";

import { useRef, useState } from "react";
import {
  AggSummary, Card, CustomerTable, DarkInput, ErrMsg, Loading, MetaBar,
  OrderRow, OrderTable, RawJson, ReadyBanner, RunBtn, S, Spinner,
  WakingBanner, fetchTimed, mono, useWakeBanner,
} from "./api-shared";

const DATASET_START = "2024-07-17";
const DATASET_END   = "2026-07-17";
const FROM_90D = (() => {
  const d = new Date(`${DATASET_END}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 90);
  return d.toISOString().slice(0, 10);
})();

export function OrdersCard() {
  const [loading, setLoading] = useState(false);
  const [res, setRes]         = useState<{ json: unknown; ms: number; src: string|null; cdn: string|null } | null>(null);
  const [err, setErr]         = useState<unknown>(null);
  const [countTotal, setCountTotal]   = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [from, setFrom]       = useState(FROM_90D);
  const [to,   setTo]         = useState(DATASET_END);
  const [allTime, setAllTime] = useState(false);
  const { phase: wakePhase, wakeMs, onStart, onDone, onError } = useWakeBanner();

  function toggleAllTime(next: boolean) {
    setAllTime(next);
    setFrom(next ? DATASET_START : FROM_90D);
    setTo(DATASET_END);
  }

  async function run() {
    setLoading(true); setErr(null); setRes(null); setCountTotal(null);
    onStart();
    try {
      const result = await fetchTimed(`/api/orders?q=&page=1&pageSize=20&sort=placedAt&dir=desc&from=${from}&to=${to}`);
      setRes(result);
      onDone(result.ms);
      fetch(`/api/aggregates?q=&from=${from}&to=${to}&topCategories=4`).catch(() => {});
      const j = result.json as Record<string, unknown>;
      if (j.countPending) {
        setCountLoading(true);
        try {
          const { json: cj } = await fetchTimed("/api/orders/count");
          setCountTotal((cj as { total: number }).total ?? 0);
        } catch {} finally { setCountLoading(false); }
      } else {
        setCountTotal((j.total as number) ?? 0);
      }
    } catch (e) { setErr(e); onError(); } finally { setLoading(false); }
  }

  const rows = (res?.json as Record<string,unknown>)?.data as OrderRow[] ?? [];
  const countLabel = countLoading
    ? `showing first ${rows.length} · counting…`
    : countTotal != null
      ? `${Number(countTotal).toLocaleString()} total orders · showing first ${rows.length}`
      : `showing first ${rows.length}`;

  return (
    <Card path="/api/orders" subtitle="Latest orders — paginated, sorted by date descending">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">{mono("pageSize","20")} {mono("sort","placedAt")} {mono("dir","desc")}</div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>from</span>
            <DarkInput type="date" value={from} onChange={setFrom} style={{ width:150 }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>to</span>
            <DarkInput type="date" value={to} onChange={setTo} style={{ width:150 }} />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] select-none" style={{ color:"#71717a", cursor:"pointer" }}>
            <input type="checkbox" checked={allTime} onChange={e => toggleAllTime(e.target.checked)}
              className="h-3 w-3 rounded accent-indigo-500" />
            All time
          </label>
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && wakePhase === "idle" && <Loading />}
      {wakePhase === "waking" && <WakingBanner wakeMs={wakeMs} />}
      {wakePhase === "ready" && <ReadyBanner />}
      {!!err  && <ErrMsg err={err} />}
      {res    && <>
        <MetaBar ms={res.ms} label={countLabel} src={res.src} cdn={res.cdn} />
        {rows.length > 0 && <OrderTable rows={rows} />}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

export function SearchCard() {
  const [q, setQ]         = useState("");
  const [from, setFrom]   = useState(FROM_90D);
  const [to,   setTo]     = useState(DATASET_END);
  const [allTime, setAllTime] = useState(false);
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number; src: string|null; cdn: string|null } | null>(null);
  const [err, setErr]     = useState<unknown>(null);
  const [countTotal, setCountTotal]     = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const { phase: wakePhase, wakeMs, onStart, onDone, onError } = useWakeBanner();

  function toggleAllTime(next: boolean) {
    setAllTime(next);
    setFrom(next ? DATASET_START : FROM_90D);
    setTo(DATASET_END);
  }

  async function run() {
    if (!q.trim()) return;
    setL(true); setErr(null); setRes(null); setCountTotal(null);
    onStart();
    try {
      const term = q.trim();
      const result = await fetchTimed(`/api/orders?q=${encodeURIComponent(term)}&page=1&pageSize=20&sort=placedAt&dir=desc&from=${from}&to=${to}`);
      setRes(result);
      onDone(result.ms);
      fetch(`/api/aggregates?q=${encodeURIComponent(term)}&from=${from}&to=${to}&topCategories=4`).catch(() => {});
      const j = result.json as Record<string, unknown>;
      if (j.countPending) {
        setCountLoading(true);
        try {
          const { json: cj } = await fetchTimed(`/api/orders/count?q=${encodeURIComponent(term)}`);
          setCountTotal((cj as { total: number }).total ?? 0);
        } catch {} finally { setCountLoading(false); }
      } else {
        setCountTotal((j.total as number) ?? 0);
      }
    } catch (e) { setErr(e); onError(); } finally { setL(false); }
  }

  const rows = (res?.json as Record<string,unknown>)?.data as OrderRow[] ?? [];
  const countLabel = countLoading
    ? `counting matches for "${q}"…`
    : countTotal != null
      ? `${Number(countTotal).toLocaleString()} match${Number(countTotal) !== 1 ? "es" : ""} for "${q}"`
      : `showing ${rows.length} result${rows.length !== 1 ? "s" : ""} for "${q}"`;

  return (
    <Card path="/api/orders?q=…" subtitle="Full-text search — Typesense prefix expansion + ClickHouse hasToken">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <DarkInput value={q} onChange={setQ} placeholder="e.g. murphy, saturday, fragile…"
            onEnter={run} style={{ width:220 }} />
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>from</span>
            <DarkInput type="date" value={from} onChange={setFrom} style={{ width:150 }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>to</span>
            <DarkInput type="date" value={to} onChange={setTo} style={{ width:150 }} />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] select-none" style={{ color:"#71717a", cursor:"pointer" }}>
            <input type="checkbox" checked={allTime} onChange={e => toggleAllTime(e.target.checked)}
              className="h-3 w-3 rounded accent-indigo-500" />
            All time
          </label>
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {!q.trim() && !loading && !res && !err && (
        <p className="text-xs" style={{ color:"#52525b" }}>Enter a search term above.</p>
      )}
      {loading && wakePhase === "idle" && <Loading />}
      {wakePhase === "waking" && <WakingBanner wakeMs={wakeMs} />}
      {wakePhase === "ready" && <ReadyBanner />}
      {!!err   && <ErrMsg err={err} />}
      {res     && <>
        <MetaBar ms={res.ms} label={countLabel} src={res.src} cdn={res.cdn} />
        {rows.length > 0 ? <OrderTable rows={rows} /> : <p className="text-xs" style={{ color:"#71717a" }}>No results.</p>}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}

export function AggregatesCard() {
  const [q, setQ]         = useState("");
  const [name, setName]   = useState("");
  const [allTime, setAllTime] = useState(false);
  const [from, setFrom]   = useState(FROM_90D);
  const [to,   setTo]     = useState(DATASET_END);
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number; src: string|null; cdn: string|null } | null>(null);
  const [err, setErr]     = useState<unknown>(null);
  const { phase: wakePhase, wakeMs, onStart, onDone, onError } = useWakeBanner();

  function toggleAllTime(next: boolean) {
    setAllTime(next);
    setFrom(next ? DATASET_START : FROM_90D);
    setTo(DATASET_END);
  }

  async function run() {
    if (!from||!to) return;
    setL(true); setErr(null); setRes(null);
    onStart();
    try {
      const params = new URLSearchParams({ q: q.trim(), from, to, topCategories: "4" });
      if (name.trim()) params.set("name", name.trim());
      const result = await fetchTimed(`/api/aggregates?${params}`);
      setRes(result);
      onDone(result.ms);
      const oParams = new URLSearchParams({ q: q.trim(), page: "1", pageSize: "20", sort: "placedAt", dir: "desc", from, to });
      if (name.trim()) oParams.set("name", name.trim());
      fetch(`/api/orders?${oParams}`).catch(() => {});
    } catch (e) { setErr(e); onError(); } finally { setL(false); }
  }

  const rawData = (res?.json as Record<string,unknown>)?.data ?? res?.json;
  const rows    = Array.isArray(rawData) ? rawData as Array<Record<string,unknown>> : [];
  const filterLabel = [q.trim() && `q="${q.trim()}"`, name.trim() && `name="${name.trim()}"`].filter(Boolean).join(" · ");

  return (
    <Card path="/api/aggregates?q=…" subtitle="Pre-aggregated daily totals — millisecond response">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <DarkInput value={q} onChange={setQ} placeholder="e.g. cassin, berg"
            onEnter={run} style={{ width:180 }} />
          <DarkInput value={name} onChange={setName} placeholder="e.g. Cassin"
            onEnter={run} style={{ width:140 }} />
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>from</span>
            <DarkInput type="date" value={from} onChange={setFrom} style={{ width:150 }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color:"#52525b" }}>to</span>
            <DarkInput type="date" value={to}   onChange={setTo}   style={{ width:150 }} />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] select-none" style={{ color:"#71717a", cursor:"pointer" }}>
            <input type="checkbox" checked={allTime} onChange={e => toggleAllTime(e.target.checked)}
              className="h-3 w-3 rounded accent-indigo-500" />
            All data
          </label>
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && wakePhase === "idle" && <Loading />}
      {wakePhase === "waking" && <WakingBanner wakeMs={wakeMs} />}
      {wakePhase === "ready" && <ReadyBanner />}
      {!!err   && <ErrMsg err={err} />}
      {res && rows.length > 0 && <>
        <MetaBar ms={res.ms}
          label={[`${rows.length} day${rows.length!==1?"s":""}`, `${from} → ${to}`, filterLabel].filter(Boolean).join(" · ")}
          src={res.src} cdn={res.cdn} />
        <AggSummary rows={rows} />
        <RawJson data={res.json} />
      </>}
      {res && rows.length === 0 && <p className="text-xs" style={{ color:"#71717a" }}>No data for this range.</p>}
    </Card>
  );
}

type BrushDay = { date: string; categories?: Record<string,{ totalOrders?:number; totalRevenue?:number }> };

export function BrushCard() {
  const [brushPhase, setBrushPhase] = useState<"init"|"loading"|"chart"|"error">("init");
  const phase = brushPhase;
  const setPhase = setBrushPhase;
  const { phase: wakePhase, wakeMs, onStart, onDone, onError } = useWakeBanner();
  const [allTime, setAllTime] = useState(false);
  const [brushData, setBD]  = useState<BrushDay[]>([]);
  const [brushL, setBL]     = useState(0);
  const [brushR, setBR]     = useState(1);
  const [brushRes, setBRes] = useState<{ json:unknown; ms:number; src:string|null; cdn:string|null; from:string; to:string }|null>(null);
  const [fetching, setF]    = useState(false);

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

  async function initBrush(useAllTime = allTime) {
    setPhase("loading");
    onStart();
    const rangeFrom = useAllTime ? DATASET_START : FROM_90D;
    try {
      const { json, ms, src, cdn } = await fetchTimed(`/api/aggregates?from=${rangeFrom}&to=${DATASET_END}&topCategories=1`);
      const raw  = (json as Record<string,unknown>).data ?? json;
      const data = Array.isArray(raw) ? raw as BrushDay[] : [];
      if (!data.length) throw new Error("no data");
      setBD(data); setBL(0); setBR(1); setPhase("chart");
      setBRes({ json, ms, src, cdn, from: data[0].date, to: data[data.length-1].date });
      onDone(ms);
    } catch { setPhase("error"); onError(); }
  }

  function toggleAllTime(next: boolean) {
    setAllTime(next);
    if (phase === "chart" || phase === "error") initBrush(next);
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
    <Card path="/api/aggregates" subtitle="Drag brush handles · sub-second">
      <div className="pt-4">
        {phase==="init" && (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <p className="text-xs" style={{ color:"#52525b" }}>
                Loads aggregate data, then drag the handles to re-query any sub-range live.
              </p>
              <label className="flex items-center gap-1.5 text-[11px] select-none whitespace-nowrap" style={{ color:"#71717a", cursor:"pointer" }}>
                <input type="checkbox" checked={allTime} onChange={e => setAllTime(e.target.checked)}
                  className="h-3 w-3 rounded accent-indigo-500" />
                All data
              </label>
            </div>
            <RunBtn onClick={() => initBrush(allTime)} loading={false} />
          </div>
        )}

        {phase==="loading" && wakePhase === "idle" && (
          <div className="flex items-center gap-2 text-xs py-2" style={{ color:"#52525b" }}>
            <Spinner /> Loading aggregates…
          </div>
        )}
        {wakePhase === "waking" && <WakingBanner wakeMs={wakeMs} />}
        {wakePhase === "ready" && <ReadyBanner />}
        {phase==="error" && <ErrMsg err={new Error("No aggregate data for this range")} />}

        {phase==="chart" && (
          <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px]" style={{ color:"#52525b" }}>Drag handles to re-query any sub-range</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] select-none" style={{ color:"#71717a", cursor:"pointer" }}>
                <input type="checkbox" checked={allTime} onChange={e => toggleAllTime(e.target.checked)}
                  className="h-3 w-3 rounded accent-indigo-500" />
                All data
              </label>
              <RunBtn onClick={() => initBrush(allTime)} loading={false} />
            </div>
          </div>
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
                <MetaBar ms={brushRes.ms} label={`${bRows.length} day${bRows.length!==1?"s":""} · ${brushRes.from} → ${brushRes.to}`} src={brushRes.src} cdn={brushRes.cdn} />
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

export function CustomersCard() {
  const [q, setQ]         = useState("");
  const [loading, setL]   = useState(false);
  const [res, setRes]     = useState<{ json: unknown; ms: number; src: string|null; cdn: string|null } | null>(null);
  const [err, setErr]     = useState<unknown>(null);
  const { phase: wakePhase, wakeMs, onStart, onDone, onError } = useWakeBanner();

  async function run() {
    setL(true); setErr(null); setRes(null);
    onStart();
    try {
      const result = await fetchTimed(`/api/customers?limit=20${q.trim()?`&q=${encodeURIComponent(q.trim())}`:""}`);
      setRes(result);
      onDone(result.ms);
    }
    catch (e) { setErr(e); onError(); } finally { setL(false); }
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
          {mono("limit","20")}
        </div>
        <RunBtn onClick={run} loading={loading} />
      </div>
      {loading && wakePhase === "idle" && <Loading />}
      {wakePhase === "waking" && <WakingBanner wakeMs={wakeMs} />}
      {wakePhase === "ready" && <ReadyBanner />}
      {!!err   && <ErrMsg err={err} />}
      {res     && <>
        <MetaBar ms={res.ms} label={`${rows.length} customer${rows.length!==1?"s":""} returned`} src={res.src} cdn={res.cdn} />
        {rows.length > 0 ? <CustomerTable rows={rows} /> : <p className="text-xs" style={{ color:"#71717a" }}>No results.</p>}
        <RawJson data={res.json} />
      </>}
    </Card>
  );
}
