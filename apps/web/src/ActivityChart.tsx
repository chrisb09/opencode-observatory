import { useState } from "react";
import { BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatMetric, metricLabel, type UsageMetric } from "./chartMetrics";
import type { ChartGroup } from "./colors";

export function ActivityChart({ groups, metric, colors, title }: { groups: ChartGroup[]; metric: UsageMetric; colors: Record<string, string>; title: string }) {
  const [width, setWidth] = useState(400);
  const leaders = [...groups].sort((a: any, b: any) => Number(b[metric] ?? -1) - Number(a[metric] ?? -1) || a.id.localeCompare(b.id)).slice(0, 8);
  const data = leaders.map((g: any) => ({ ...g, value: g[metric] == null ? null : Number(g[metric]) }));
  const format = (v: any) => formatMetric(metric, v);
  const labelWidth = Math.max(5, Math.floor((width - 85) / Math.max(data.length, 1) / 6));
  const lines = (label: string) => {
    const parts = label.split(/[\/·]/), provider = parts.length > 1 ? parts[0]!.trim() : null;
    const name = parts.at(-1)!.trim().replace(/^antigravity-/, "");
    const chunks = name.match(new RegExp(`.{1,${labelWidth}}`, "g")) ?? [name];
    const display = chunks.slice(0, 3);
    if (chunks.length > 3) display[2] = "…" + name.slice(-(labelWidth - 1));
    if (provider) display.push(provider.length > labelWidth ? provider.slice(0, labelWidth - 1) + "…" : provider);
    return display;
  };
  return <section className="panel activity-panel"><div className="panel-title"><div><h2>{title}</h2><p>Top {leaders.length} by {metricLabel(metric).toLowerCase()} · selected timeframe</p></div></div>
    {data.length ? <><div className="chart"><ResponsiveContainer width="100%" height={290} onResize={w => setWidth(w)}><BarChart data={data} margin={{ top: 28, right: 14, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4"/>
      <XAxis dataKey="label" interval={0} height={65} tick={({ x, y, payload }: any) => <g transform={`translate(${x},${y})`}><title>{payload.value}</title><text textAnchor="middle" fill="var(--muted)" fontSize={10}>{lines(payload.value).map((line,index)=><tspan key={index} x={0} dy={13}>{line}</tspan>)}</text></g>} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={format} width={65} allowDecimals={metric !== "calls"} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false}/>
      <Tooltip cursor={false} content={({ active, payload }: any) => active && payload?.length ? <div className="chart-tooltip"><strong>{payload[0].payload.label}</strong><div><i style={{ background: colors[payload[0].payload.id] }}/><span>{metricLabel(metric)}</span><b>{format(payload[0].value)}</b></div></div> : null}/>
      <Bar dataKey="value" name={metricLabel(metric)} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>{data.map(g => <Cell key={g.id} fill={colors[g.id]}/>)}<LabelList dataKey="value" position="top" formatter={format} fill="var(--text)" fontSize={11}/></Bar>
    </BarChart></ResponsiveContainer></div>{data.some(g => g.value == null) && <p className="chart-caption">Unmeasured values are unavailable, not zero.</p>}</> : <div className="empty compact"><p>No activity in this timeframe.</p></div>}
  </section>;
}
