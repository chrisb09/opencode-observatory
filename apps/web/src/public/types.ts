import type { ChartMetric } from "../chartMetrics";

export type Grouping = "model" | "provider";
export type PublicMetric = ChartMetric;

export type AnalyticsNumbers = Record<string, number | null | undefined>;

export type PublicGroup = {
  id: string;
  label: string;
  provider?: string | null;
  [key: string]: number | string | null | undefined;
};

export type PublicPoint = { time: number } & AnalyticsNumbers;

export type PublicSeries = {
  id: string;
  label: string;
  provider?: string | null;
  series: PublicPoint[];
};

export type PublicAnalytics = {
  summary: AnalyticsNumbers;
  series: PublicPoint[];
  modelGroups: PublicGroup[];
  providerGroups: PublicGroup[];
  modelSeries?: PublicSeries[];
  providerSeries?: PublicSeries[];
  groupSeries: PublicSeries[];
  groupBy?: Grouping;
  timeframe: {
    from: number;
    to: number;
    bucket: string;
    timezone?: string;
    endExclusive?: boolean;
  };
  outputDistribution?: any[];
  contextDistribution?: any[];
  contextPercentiles?: AnalyticsNumbers;
  transport?: AnalyticsNumbers;
};

export type PublicFilters = {
  provider: string;
  model: string;
};
