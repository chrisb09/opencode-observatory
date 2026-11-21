import { money } from "./format";

export type UsageMetric = "total_tokens" | "calls" | "cost" | "market_cost";
// Public analytics exposes cache-read tokens as an extra chart measure. Keep it
// in the shared chart types so labels and "unknown" semantics cannot drift.
export type ChartMetric = UsageMetric | "cache_read_tokens";
export const usageMetrics: [UsageMetric, string][] = [["total_tokens", "Tokens"], ["calls", "Calls"], ["cost", "Recorded cost"], ["market_cost", "Market Value"]];
const metricLabels: Record<ChartMetric, string> = {
  total_tokens: "Tokens",
  calls: "Calls",
  cost: "Recorded cost",
  market_cost: "Market Value",
  cache_read_tokens: "Cache reads",
};
export const metricLabel = (metric: ChartMetric | string) => metricLabels[metric as ChartMetric] ?? metric;
export const formatMetric = (metric: ChartMetric | string, value: any) => value == null ? "Unavailable" : metric === "cost" || metric === "market_cost" ? money(value) : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
// The calls without a usable measurement differ per metric. Cache reads are a
// usage measurement, so use cache coverage rather than cost coverage.
export const unknownMetricCalls = (point: Record<string, any>, metric: ChartMetric) => {
  const value = (key: string) => {
    const raw = Number(point[key]);
    return Number.isFinite(raw) ? raw : 0;
  };
  if (metric === "calls") return 0;
  if (metric === "total_tokens") return value("unknown_usage_calls");
  if (metric === "cache_read_tokens") return Math.max(0, value("calls") - value("known_cache_calls"));
  if (metric === "market_cost") return value("unknown_market_calls");
  return value("unknown_cost_calls");
};
// Recharts treats dots and brackets in string data keys as paths. Encode arbitrary identities.
export const seriesKey = (id: string) => "series_" + [...id].map(c => c.codePointAt(0)!.toString(16)).join("_");
