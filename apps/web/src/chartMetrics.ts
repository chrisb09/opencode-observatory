import { money } from "./format";

export type UsageMetric = "total_tokens" | "calls" | "cost" | "market_cost";
export const usageMetrics: [UsageMetric, string][] = [["total_tokens", "Tokens"], ["calls", "Calls"], ["cost", "Recorded cost"], ["market_cost", "Market Value"]];
export const metricLabel = (metric: UsageMetric) => usageMetrics.find(([key]) => key === metric)![1];
export const formatMetric = (metric: UsageMetric, value: any) => value == null ? "Unavailable" : metric === "cost" || metric === "market_cost" ? money(value) : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
// Recharts treats dots and brackets in string data keys as paths. Encode arbitrary identities.
export const seriesKey = (id: string) => "series_" + [...id].map(c => c.codePointAt(0)!.toString(16)).join("_");
