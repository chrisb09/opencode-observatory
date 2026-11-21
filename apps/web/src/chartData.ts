import { seriesKey, unknownMetricCalls, type ChartMetric } from "./chartMetrics";

export function usageChartData(stats: any, metric: ChartMetric, displayed: string[], cumulative: boolean) {
  const selected = new Set(displayed), running: Record<string, number> = {}, measured = new Set<string>();
  let unknown = 0;
  const rows = stats.series.map((point: any, i: number) => {
    const values: Record<string, number | null> = { total: point[metric] == null ? null : Number(point[metric]), other: null };
    for (const model of stats.groupSeries ?? stats.modelSeries) {
      const raw = model.series[i]?.[metric], value = raw == null ? null : Number(raw);
      if (selected.has(model.id)) values[seriesKey(model.id)] = value;
      else if (value !== null) values.other = (values.other ?? 0) + value;
    }
    const unknownCalls = unknownMetricCalls(point, metric);
    unknown += unknownCalls;
    if (cumulative) for (const [key, value] of Object.entries(values)) {
      if (value !== null) { running[key] = (running[key] ?? 0) + value; measured.add(key); }
      values[key] = measured.has(key) ? running[key]! : null;
    }
    return { ...values, time: cumulative ? Math.min(stats.series[i + 1]?.time ?? stats.timeframe.to, stats.timeframe.to) : Math.max(point.time, stats.timeframe.from), unknown: cumulative ? unknown : unknownCalls };
  });
  if (cumulative && rows.length) rows.unshift({ ...Object.fromEntries(Object.keys(running).map(key => [key, 0])), time: stats.timeframe.from, unknown: 0 });
  return rows;
}
