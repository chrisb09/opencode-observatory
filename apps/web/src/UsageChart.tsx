import { useMemo, useState } from "react";
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { money } from "./format";
import { usageChartData } from "./chartData";

// Bright, moderately saturated colors remain legible on Observatory's dark surfaces.
export function modelColor(id: string) {
  let hash = 2166136261; for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `hsl(${(hash % 36000) / 100} ${58 + (hash >>> 16) % 17}% var(--model-lightness))`;
}
const formatNumber = (v: any) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v));
export function UsageChart({ stats, perModel }: { stats: any; perModel: boolean }) {
  const [metric, setMetric] = useState("total_tokens"), [showTotal, setShowTotal] = useState(true), [hidden, setHidden] = useState<Set<string>>(new Set()), [extra, setExtra] = useState<Set<string>>(new Set());
  const [cumulative, setCumulative] = useState(false), [smooth, setSmooth] = useState(true);
  const leaders = useMemo(() => stats.modelGroups.slice(0, 8).map((x: any) => x.id) as string[], [stats]);
  const displayed = useMemo(() => [...leaders, ...[...extra].filter(id => !leaders.includes(id) && stats.modelSeries.some((m: any) => m.id === id))], [leaders, extra, stats]);
  const data = useMemo(() => usageChartData(stats, metric, displayed, cumulative), [stats, metric, displayed, cumulative]);
  const hourly = ["hour", "six-hour"].includes(stats.timeframe.bucket);
  const tick = (v: number) => hourly ? new Date(v).toLocaleString(undefined, { ...(stats.timeframe.bucket === "six-hour" ? { month: "short", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit" }) : new Date(v).toLocaleDateString(undefined, { month: "short", ...(stats.timeframe.bucket === "month" ? { year: "numeric" } : { day: "numeric" }) });
  const toggle = (id: string) => setHidden(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const format = metric !== "total_tokens" ? money : formatNumber, curve = smooth ? "monotone" : "linear";
  return <section className="panel usage-panel">
    <div className="panel-title"><div><h2>Usage over time</h2><p>{stats.timeframe.bucket.replace("six-hour", "6-hour")} intervals · displayed in your local timezone{metric === "total_tokens" ? " · includes cached input and reasoning" : " · USD"}</p></div>
      <div className="segmented">{[["total_tokens", "Tokens"], ["cost", "Recorded cost"], ["market_cost", "Market Value"]].map(([key, label]) => <button key={key} className={metric === key ? "chosen" : ""} onClick={() => setMetric(key!)}>{label}</button>)}</div>
    </div>
    <div className="chart-controls"><label><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)}/>Smooth curves</label><label><input type="checkbox" checked={cumulative} onChange={e => setCumulative(e.target.checked)}/>Cumulative</label>{cumulative && <small>Running measured total within this timeframe</small>}</div>
    <div className="chart"><ResponsiveContainer width="100%" height={300}><ComposedChart data={data} margin={{ right: 16 }}>
      <defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a78bfa" stopOpacity={.22}/><stop offset="100%" stopColor="#a78bfa" stopOpacity={0}/></linearGradient></defs>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4"/>
      <XAxis dataKey="time" type="number" scale="time" domain={[stats.timeframe.from, stats.timeframe.to]} allowDataOverflow tickFormatter={tick} minTickGap={36} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={format} width={85} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false}/>
      <Tooltip content={({ active, payload, label }: any) => active && payload?.length ? <div className="chart-tooltip"><strong>{new Date(Number(label)).toLocaleString()}</strong>{payload.map((p: any) => <div key={p.dataKey}><i style={{ background: p.color }}/><span>{p.name}</span><b>{p.value == null ? "Unavailable" : format(p.value)}</b></div>)}{payload[0]?.payload.unknown > 0 && <small>Partial measurement: {payload[0].payload.unknown} calls unavailable {cumulative ? "so far in this timeframe" : "in this interval"}</small>}</div> : null}/>
      {(!perModel || showTotal) && <Area dataKey="total" name="All models" stroke={perModel ? "var(--text)" : "var(--purple)"} strokeDasharray={perModel ? "5 4" : undefined} fill={perModel ? "transparent" : "url(#usage-fill)"} strokeWidth={2} type={curve} isAnimationActive={false} connectNulls={false}/>}
      {perModel && displayed.filter(id => !hidden.has(id)).map(id => <Line key={id} dataKey={id} name={id} stroke={modelColor(id)} dot={false} strokeWidth={2} type={curve} isAnimationActive={false} connectNulls={false}/>)}
      {perModel && stats.modelSeries.length > displayed.length && !hidden.has("other") && <Line dataKey="other" name="Other models" stroke="var(--muted)" dot={false} strokeWidth={2} type={curve} isAnimationActive={false} connectNulls={false}/>}
    </ComposedChart></ResponsiveContainer></div>
    {perModel && <div className="model-legend"><label><input type="checkbox" checked={showTotal} onChange={e => setShowTotal(e.target.checked)}/>All-models total</label>{displayed.map(id => <button key={id} title={id} className={hidden.has(id) ? "muted" : ""} onClick={() => toggle(id)}><i style={{ background: modelColor(id) }}/>{id}</button>)}{stats.modelSeries.length > displayed.length && <button onClick={() => toggle("other")} className={hidden.has("other") ? "muted" : ""}>Other models ({stats.modelSeries.length - displayed.length})</button>}</div>}
    {perModel && stats.modelSeries.length > leaders.length && <details className="all-models"><summary>All models · click to add or hide individual series</summary>{stats.modelSeries.map((m: any) => <button key={m.id} className={displayed.includes(m.id) && !hidden.has(m.id) ? "selected" : ""} onClick={() => { if (displayed.includes(m.id)) toggle(m.id); else { setExtra(old => new Set([...old, m.id])); setHidden(old => { const next = new Set(old); next.delete(m.id); return next; }); } }}><i style={{ background: modelColor(m.id) }}/>{m.id}</button>)}</details>}
  </section>;
}
