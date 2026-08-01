"use client";

import { useEffect, useRef, useState } from "react";

type WarmupState = "idle" | "warming" | "caching" | "ready" | "done";

export default function WarmupBadge() {
  const [state, setState] = useState<WarmupState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    async function ping() {
      try {
        const res = await fetch("/api/ch-warmup");
        const json = await res.json() as { status: string; cacheReady?: boolean };
        if (cancelled) return;
        if (json.status === "noop") return;
        if (json.status === "ready") {
          if (json.cacheReady) {
            if (timerRef.current) clearInterval(timerRef.current);
            setState("ready");
            readyTimeout = setTimeout(() => { if (!cancelled) setState("done"); }, 2000);
          } else {
            if (state === "warming") {
              if (timerRef.current) clearInterval(timerRef.current);
            }
            if (state !== "caching") setState("caching");
            setTimeout(ping, 2000);
          }
          return;
        }
        if (json.status === "warming" || res.status === 503) {
          if (state === "idle") {
            startRef.current = Date.now();
            setState("warming");
            timerRef.current = setInterval(() => {
              if (!cancelled) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
            }, 500);
          }
          setTimeout(ping, 2000);
        }
      } catch {
        if (!cancelled) setTimeout(ping, 3000);
      }
    }

    ping();
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (readyTimeout) clearTimeout(readyTimeout);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "idle" || state === "done") return null;

  if (state === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full font-medium"
        style={{ background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)", color: "#4ade80" }}>
        Cache ready
      </span>
    );
  }

  const label = state === "caching" ? "Search cache warming" : `Analytics warming up · ${elapsed}s`;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full font-medium"
      style={{ background: "rgba(251,191,36,0.10)", border: "1px solid rgba(251,191,36,0.25)", color: "#fbbf24" }}>
      <span className="animate-spin inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full" />
      {label}
    </span>
  );
}
