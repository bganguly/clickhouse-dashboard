"use client";

import Link from "next/link";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";

type ParamDef = {
  name: string;
  type: "string" | "number";
  placeholder?: string;
};

type EndpointDef = {
  method: "GET" | "POST";
  path: string;
  description: string;
  params?: ParamDef[];
  bodyExample?: string;
};

const ENDPOINTS: EndpointDef[] = [
  {
    method: "GET",
    path: "/api/regions",
    description: "Full list of regions for the filter dropdown.",
  },
  {
    method: "GET",
    path: "/api/seed-stats",
    description: "Customer + product counts used by Quick Order for seed bounds.",
  },
  {
    method: "GET",
    path: "/api/stream/status",
    description: "Whether any dashboard tab has the Live checkbox on.",
  },
  {
    method: "GET",
    path: "/api/customers",
    description: "Paginated customer list with optional search and cursor.",
    params: [
      { name: "q", type: "string", placeholder: "search query" },
      { name: "limit", type: "number", placeholder: "10" },
      { name: "cursor", type: "number", placeholder: "last seen id" },
      { name: "regionId", type: "number", placeholder: "region id" },
    ],
  },
  {
    method: "GET",
    path: "/api/orders",
    description:
      "Paginated orders with filters, sorting, and optional keyset cursor for Prev/Next.",
    params: [
      { name: "q", type: "string", placeholder: "search" },
      { name: "page", type: "number", placeholder: "1" },
      { name: "pageSize", type: "number", placeholder: "20" },
      { name: "sort", type: "string", placeholder: "placedAt" },
      { name: "dir", type: "string", placeholder: "desc" },
      { name: "status", type: "string", placeholder: "PENDING,COMPLETED" },
      { name: "regionCode", type: "string", placeholder: "e.g. US-EAST" },
      { name: "from", type: "string", placeholder: "YYYY-MM-DD" },
      { name: "to", type: "string", placeholder: "YYYY-MM-DD" },
      { name: "minTotal", type: "number", placeholder: "0" },
      { name: "maxTotal", type: "number", placeholder: "1000" },
      { name: "facets", type: "string", placeholder: "1" },
    ],
  },
  {
    method: "POST",
    path: "/api/orders",
    description: "Create a new order.",
    bodyExample: JSON.stringify(
      { customerId: 1, items: [{ productId: 1, quantity: 2 }] },
      null,
      2,
    ),
  },
  {
    method: "GET",
    path: "/api/aggregates",
    description:
      "Daily order aggregates by category for the chart, plus exact total order count.",
    params: [
      { name: "from", type: "string", placeholder: "YYYY-MM-DD" },
      { name: "to", type: "string", placeholder: "YYYY-MM-DD" },
      { name: "q", type: "string", placeholder: "search" },
      { name: "status", type: "string", placeholder: "PENDING" },
      { name: "regionCode", type: "string", placeholder: "e.g. US-EAST" },
      { name: "minTotal", type: "number", placeholder: "0" },
      { name: "maxTotal", type: "number", placeholder: "1000" },
      { name: "topCategories", type: "number", placeholder: "5" },
    ],
  },
  {
    method: "GET",
    path: "/api/dashboard-search",
    description:
      "Combined orders + aggregates in one request (dashboard initial load).",
    params: [
      { name: "q", type: "string", placeholder: "search" },
      { name: "from", type: "string", placeholder: "YYYY-MM-DD (aggregates range)" },
      { name: "to", type: "string", placeholder: "YYYY-MM-DD (aggregates range)" },
      { name: "orderFrom", type: "string", placeholder: "YYYY-MM-DD (orders range)" },
      { name: "orderTo", type: "string", placeholder: "YYYY-MM-DD (orders range)" },
      { name: "status", type: "string", placeholder: "PENDING" },
      { name: "regionCode", type: "string", placeholder: "e.g. US-EAST" },
      { name: "page", type: "number", placeholder: "1" },
      { name: "pageSize", type: "number", placeholder: "20" },
      { name: "topCategories", type: "number", placeholder: "5" },
    ],
  },
];

function statusColor(status: number) {
  if (status === 0) return "text-red-500 dark:text-red-400";
  if (status >= 200 && status < 300)
    return "text-emerald-600 dark:text-emerald-400";
  if (status >= 400) return "text-red-600 dark:text-red-400";
  return "text-zinc-500";
}

function EndpointCard({ ep }: { ep: EndpointDef }) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [body, setBody] = useState(ep.bodyExample ?? "");
  const [response, setResponse] = useState<{
    status: number;
    text: string;
    ms: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function send() {
    setLoading(true);
    setResponse(null);
    const t0 = performance.now();
    try {
      let url = ep.path;
      if (ep.method === "GET" && ep.params) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          if (v !== "") qs.set(k, v);
        }
        const s = qs.toString();
        if (s) url += "?" + s;
      }
      const opts: RequestInit = { method: ep.method };
      if (ep.method === "POST" && body) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = body;
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON, show raw */
      }
      setResponse({ status: res.status, text: pretty, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setResponse({ status: 0, text: String(e), ms: Math.round(performance.now() - t0) });
    } finally {
      setLoading(false);
    }
  }

  const methodBadge =
    ep.method === "GET"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        <span
          className={`shrink-0 font-mono text-xs font-semibold px-2 py-0.5 rounded ${methodBadge}`}
        >
          {ep.method}
        </span>
        <code className="font-mono text-sm text-zinc-700 dark:text-zinc-300 shrink-0">
          {ep.path}
        </code>
        <span className="ml-2 text-sm text-zinc-400 truncate hidden sm:block">
          {ep.description}
        </span>
        <span className="ml-auto shrink-0 text-zinc-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-4 space-y-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 sm:hidden">
            {ep.description}
          </p>

          {ep.params && ep.params.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ep.params.map((p) => (
                <label key={p.name} className="flex flex-col gap-1">
                  <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                    {p.name}
                  </span>
                  <input
                    type={p.type === "number" ? "number" : "text"}
                    placeholder={p.placeholder}
                    value={params[p.name] ?? ""}
                    onChange={(e) =>
                      setParams((prev) => ({ ...prev, [p.name]: e.target.value }))
                    }
                    className="rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </label>
              ))}
            </div>
          )}

          {ep.method === "POST" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                request body (JSON)
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                spellCheck={false}
                className="rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
          )}

          <button
            onClick={send}
            disabled={loading}
            className="rounded bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-sm font-medium px-4 py-1.5 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {loading ? "Sending…" : "Send"}
          </button>

          {response && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-mono">
                <span className={`font-semibold ${statusColor(response.status)}`}>
                  {response.status === 0 ? "Network error" : `HTTP ${response.status}`}
                </span>
                <span className="text-zinc-400">{response.ms}ms</span>
              </div>
              <pre className="overflow-x-auto rounded bg-zinc-950 dark:bg-zinc-800 text-zinc-100 text-xs p-3 max-h-80">
                {response.text}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ApiExplorer() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="w-full px-5 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <Link
              href="/"
              className="text-sm text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 mb-1 inline-block"
            >
              ← Dashboard
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">API Explorer</h1>
            <p className="text-sm text-gray-500">Browse and exercise the backend API endpoints.</p>
          </div>
          <ThemeToggle />
        </header>
        <div className="space-y-3 max-w-5xl">
          {ENDPOINTS.map((ep) => (
            <EndpointCard key={`${ep.method}-${ep.path}`} ep={ep} />
          ))}
        </div>
      </main>
    </div>
  );
}
