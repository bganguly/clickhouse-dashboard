import type { DailyAggregate } from "@/lib/types";

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899"];
const OTHER_COLOR = "#94a3b8";
const OTHER_KEY = "Others";

export function renderChartSvg(data: DailyAggregate[], topN: number): string {
  if (!data.length) return "";

  const totals = new Map<string, number>();
  for (const row of data) {
    for (const [cat, c] of Object.entries(row.categories)) {
      totals.set(cat, (totals.get(cat) ?? 0) + c.totalOrders);
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const topCats = ranked.slice(0, topN).map(([c]) => c);
  const topSet = new Set(topCats);
  const hasOthers = ranked.length > topN;
  const series = [...topCats, ...(hasOthers ? [OTHER_KEY] : [])];

  const buckets = data.map((row) => {
    const b: Record<string, number> = {};
    for (const cat of topCats) b[cat] = 0;
    if (hasOthers) b[OTHER_KEY] = 0;
    for (const [cat, c] of Object.entries(row.categories)) {
      const key = topSet.has(cat) ? cat : hasOthers ? OTHER_KEY : null;
      if (key) b[key] = (b[key] ?? 0) + c.totalOrders;
    }
    return b;
  });

  const maxVal = Math.max(...buckets.map((b) => series.reduce((s, k) => s + (b[k] ?? 0), 0)));
  if (maxVal === 0) return "";

  const W = 800, H = 260;
  const ml = 8, mr = 8, mt = 8, mb = 8;
  const plotW = W - ml - mr;
  const plotH = H - mt - mb;
  const n = buckets.length;
  const barW = Math.max(1, plotW / n);
  const gap = barW > 2 ? 0.5 : 0;

  let rects = "";
  for (let i = 0; i < n; i++) {
    let y = plotH;
    for (let si = series.length - 1; si >= 0; si--) {
      const val = buckets[i][series[si]] ?? 0;
      if (!val) continue;
      const h = Math.max(1, (val / maxVal) * plotH);
      y -= h;
      const fill = series[si] === OTHER_KEY ? OTHER_COLOR : (COLORS[si % COLORS.length] ?? "#ccc");
      rects += `<rect x="${(ml + i * barW + gap / 2).toFixed(1)}" y="${(mt + y).toFixed(1)}" width="${Math.max(1, barW - gap).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" opacity="0.85"/>`;
    }
  }

  const axisY = mt + plotH;
  const axis = `<line x1="${ml}" y1="${axisY}" x2="${W - mr}" y2="${axisY}" stroke="#6b7280" stroke-width="1" stroke-opacity="0.4"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${axis}${rects}</svg>`;
}
