import { useId, useMemo, useState } from "react";
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { usageChartData } from "./chartData";
import { formatMetric, seriesKey, type UsageMetric } from "./chartMetrics";
import type { ChartGroup } from "./colors";
export { modelColor } from "./colors";

export function UsageChart({ stats, metric, groups, colors, grouped = true, groupLabel }: { stats: any; metric: UsageMetric; groups: ChartGroup[]; colors: Record<string, string>; grouped?: boolean; groupLabel: string }) {
  const [showTotal, setShowTotal] = useState(false), [hidden, setHidden] = useState<Set<string>>(new Set()), [extra, setExtra] = useState<Set<string>>(new Set());
  const [cumulative, setCumulative] = useState(false), [smooth, setSmooth] = useState(true);
  const gradient = useId();
  const leaders = useMemo(() => [...groups].sort((a: any, b: any) => Number(b[metric] ?? -1) - Number(a[metric] ?? -1) || a.id.localeCompare(b.id)).slice(0, 8).map(x => x.id), [groups, metric]);
  const displayed = useMemo(() => [...leaders, ...[...extra].filter(id => !leaders.includes(id) && groups.some(g => g.id === id))], [leaders, extra, groups]);
  const data = useMemo(() => usageChartData(stats, metric, displayed, cumulative), [stats, metric, displayed, cumulative]);
  const hourly = ["hour", "six-hour"].includes(stats.timeframe.bucket);
  const tick = (v: number) => hourly ? new Date(v).toLocaleString(undefined, { ...(stats.timeframe.bucket === "six-hour" ? { month: "short", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit" }) : new Date(v).toLocaleDateString(undefined, { month: "short", ...(stats.timeframe.bucket === "month" ? { year: "numeric" } : { day: "numeric" }) });
  const toggle = (id: string) => setHidden(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const format = (v: any) => formatMetric(metric, v), curve = smooth ? "monotone" : "linear";
  const label = (id: string) => groups.find(g => g.id === id)?.label ?? id;
  const other = groups.length > displayed.length;
  return <section className="panel usage-panel">
    <div className="panel-title"><div><h2>Usage over time</h2><p>{stats.timeframe.bucket.replace("six-hour", "6-hour")} intervals · local timezone{metric === "total_tokens" ? " · includes cache and reasoning" : metric === "calls" ? " · model calls" : " · USD"}</p></div></div>
    <div className="chart-controls"><label><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)}/>Smooth curves</label><label><input type="checkbox" checked={cumulative} onChange={e => setCumulative(e.target.checked)}/>Cumulative</label>{cumulative && <small>Running measured total within this timeframe</small>}</div>
    <div className="chart"><ResponsiveContainer width="100%" height={260}><ComposedChart data={data} margin={{ right: 16 }}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--purple)" stopOpacity={.22}/><stop offset="100%" stopColor="var(--purple)" stopOpacity={0}/></linearGradient></defs>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4"/>
      <XAxis dataKey="time" type="number" scale="time" domain={[stats.timeframe.from, stats.timeframe.to]} allowDataOverflow tickFormatter={tick} minTickGap={36} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={format} width={75} allowDecimals={metric !== "calls"} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false}/>
      <Tooltip content={({ active, payload, label: time }: any) => active && payload?.length ? <div className="chart-tooltip"><strong>{new Date(Number(time)).toLocaleString()}</strong>{payload.map((p: any) => <div key={p.dataKey}><i style={{ background: p.color }}/><span>{p.name}</span><b>{format(p.value)}</b></div>)}{payload[0]?.payload.unknown > 0 && <small>Partial measurement: {payload[0].payload.unknown} calls unavailable {cumulative ? "so far in this timeframe" : "in this interval"}</small>}</div> : null}/>
      {(!grouped || showTotal) && <Area dataKey="total" name="Overall total" stroke={grouped ? "var(--text)" : "var(--purple)"} strokeDasharray={grouped ? "5 4" : undefined} fill={grouped ? "transparent" : `url(#${gradient})`} strokeWidth={2} type={curve} isAnimationActive={false} connectNulls={false}/>}
      {grouped && displayed.filter(id => !hidden.has(id)).map(id => <Line key={id} dataKey={seriesKey(id)} name={label(id)} stroke={colors[id]} dot={false} strokeWidth={2.5} type={curve} isAnimationActive={false} connectNulls={false}/>)}
      {grouped && other && !hidden.has("__other") && <Line dataKey="other" name={`Other ${groupLabel}`} stroke="var(--muted)" dot={false} strokeWidth={2} type={curve} isAnimationActive={false} connectNulls={false}/>}
    </ComposedChart></ResponsiveContainer></div>
    {grouped && <div className="model-legend"><label><input type="checkbox" checked={showTotal} onChange={e => setShowTotal(e.target.checked)}/>Overall total</label>{displayed.map(id => <button key={id} title={label(id)} aria-pressed={!hidden.has(id)} className={hidden.has(id) ? "muted" : ""} onClick={() => toggle(id)}><i style={{ background: colors[id] }}/>{label(id)}</button>)}{other && <button onClick={() => toggle("__other")} aria-pressed={!hidden.has("__other")} className={hidden.has("__other") ? "muted" : ""}>Other {groupLabel} ({groups.length - displayed.length})</button>}</div>}
    {grouped && groups.length > leaders.length && <details className="all-models"><summary>All {groupLabel} · add or hide individual series</summary>{groups.map(g => <button key={g.id} className={displayed.includes(g.id) && !hidden.has(g.id) ? "selected" : ""} onClick={() => { if (displayed.includes(g.id)) toggle(g.id); else { setExtra(old => new Set([...old, g.id])); setHidden(old => { const next = new Set(old); next.delete(g.id); return next; }); } }}><i style={{ background: colors[g.id] }}/>{g.label}</button>)}</details>}
  </section>;
}
