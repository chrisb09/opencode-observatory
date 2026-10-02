import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { chartTooltipStyle } from "./format";
export function DistributionChart({ data, valueKey = "calls", name = "Model calls", color = "var(--cache-read)" }: {data:any[]; valueKey?:string; name?:string; color?:string}) {
  return <ResponsiveContainer width="100%" height={220}><BarChart data={data} barCategoryGap="15%">
    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4"/>
    <XAxis dataKey="range" minTickGap={16} tick={{fill:"var(--muted)",fontSize:9}} axisLine={false} tickLine={false}/>
    <YAxis allowDecimals={false} tick={{fill:"var(--muted)",fontSize:10}} axisLine={false} tickLine={false}/>
    <Tooltip cursor={false} contentStyle={chartTooltipStyle} labelStyle={{color:"var(--text)"}}/>
    <Bar dataKey={valueKey} name={name} fill={color} radius={[3,3,0,0]} maxBarSize={32} activeBar={{stroke:"var(--text)",strokeWidth:1}} isAnimationActive={false}/>
  </BarChart></ResponsiveContainer>;
}
