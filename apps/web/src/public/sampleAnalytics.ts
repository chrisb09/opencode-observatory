import type { PublicAnalytics, PublicGroup, PublicPoint, PublicSeries, Grouping } from "./types";
import {
  SAMPLE_FROM,
  SAMPLE_TO,
  sampleAccounts,
  sampleMachines,
  sampleModels,
  percentile,
  type SampleAccount,
  type SampleMachine,
  type SampleSession,
  type SampleStep,
} from "./sampleData";

const HOUR = 3600000;
const seriesKeys = [
  "calls",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cost",
  "market_cost",
  "cache_savings",
  "failures",
  "imported_calls",
  "unknown_cost_calls",
  "unknown_market_calls",
  "unknown_usage_calls",
  "known_cache_calls",
  "cache_hit_calls",
  "cache_reuse_ratio",
  "cache_hit_ratio",
] as const;
type SeriesKey = (typeof seriesKeys)[number];
type Values = Record<SeriesKey, number | null>;

class Acc {
  calls = 0;
  failures = 0;
  knownPrompt = 0;
  knownCache = 0;
  hitCalls = 0;
  values: Record<string, number> = {};
  outputs: number[] = [];
  durations: number[] = [];
  firstOutputs: number[] = [];
  add(step: SampleStep) {
    this.calls++;
    if (step.status === "failed") this.failures++;
    const prompt = step.inputTokens + step.cacheReadTokens + step.cacheWriteTokens;
    this.knownPrompt += prompt;
    this.knownCache++;
    if (step.cacheReadTokens > 0) this.hitCalls++;
    const values: Record<string, number> = {
      calls: 1,
      failures: step.status === "failed" ? 1 : 0,
      input_tokens: step.inputTokens,
      output_tokens: step.outputTokens,
      reasoning_tokens: step.reasoningTokens,
      cache_read_tokens: step.cacheReadTokens,
      cache_write_tokens: step.cacheWriteTokens,
      prompt_tokens: prompt,
      completion_tokens: step.outputTokens + step.reasoningTokens,
      total_tokens: step.totalTokens,
      cost: step.cost,
      market_cost: step.marketCost,
      cache_savings: step.cacheSavings,
    };
    for (const [key, value] of Object.entries(values)) this.values[key] = (this.values[key] ?? 0) + value;
    this.outputs.push(step.outputTokens);
    this.durations.push(step.durationMs);
    this.firstOutputs.push(step.firstOutputMs);
  }
  finish(withPercentiles = false): PublicGroup {
    const values: Record<string, number | null> = {};
    for (const key of seriesKeys) values[key] = (this.values[key] ?? 0) as number;
    values.cache_reuse_ratio = this.knownPrompt > 0 ? this.values.cache_read_tokens! / this.knownPrompt : null;
    values.cache_hit_ratio = this.calls > 0 ? this.hitCalls / this.calls : null;
    values.known_cache_calls = this.knownCache;
    if (withPercentiles) {
      values.p50_ms = percentile(this.durations, 0.5);
      values.p95_ms = percentile(this.durations, 0.95);
      values.p50_output_tokens = percentile(this.outputs, 0.5);
      values.p95_output_tokens = percentile(this.outputs, 0.95);
    }
    return { id: "", label: "", ...values };
  }
}

const emptyPoint = (): PublicPoint => {
  const point = { calls: 0, time: 0 } as PublicPoint;
  for (const key of seriesKeys) point[key] = 0;
  point.cache_reuse_ratio = null;
  point.cache_hit_ratio = null;
  return point;
};

const modelById = new Map(sampleModels.map(model => [model.id, model]));

export function buildSampleAnalytics(sessions: SampleSession[], groupBy: Grouping): PublicAnalytics {
  const summary = new Acc();
  const byBucket = new Map<number, Acc>();
  const byModel = new Map<string, Acc>();
  const byProvider = new Map<string, Acc>();
  const modelBuckets = new Map<string, Map<number, Acc>>();
  const providerBuckets = new Map<string, Map<number, Acc>>();
  const modelMeta = new Map<string, { label: string; provider: string }>();
  const attempts = sessions.flatMap(session => session.steps);
  let retries = 0;

  for (const session of sessions) {
    for (const step of session.steps) {
      if (step.status !== "completed") retries++;
      summary.add(step);
      const time = Math.floor(step.startedAt / HOUR) * HOUR;
      if (!byBucket.has(time)) byBucket.set(time, new Acc());
      byBucket.get(time)!.add(step);
      if (!byModel.has(step.modelId)) byModel.set(step.modelId, new Acc());
      byModel.get(step.modelId)!.add(step);
      modelMeta.set(step.modelId, { label: step.model, provider: step.provider });
      if (!byProvider.has(step.provider)) byProvider.set(step.provider, new Acc());
      byProvider.get(step.provider)!.add(step);
      if (!modelBuckets.has(step.modelId)) modelBuckets.set(step.modelId, new Map());
      const mb = modelBuckets.get(step.modelId)!;
      if (!mb.has(time)) mb.set(time, new Acc());
      mb.get(time)!.add(step);
      if (!providerBuckets.has(step.provider)) providerBuckets.set(step.provider, new Map());
      const pb = providerBuckets.get(step.provider)!;
      if (!pb.has(time)) pb.set(time, new Acc());
      pb.get(time)!.add(step);
    }
  }

  const timeline: number[] = [];
  for (let time = SAMPLE_FROM; time < SAMPLE_TO; time += HOUR) timeline.push(time);
  const totalsPoint = (bucket: Map<number, Acc>, time: number) => {
    const point: PublicPoint = { ...emptyPoint(), time };
    const acc = bucket.get(time);
    if (acc) {
      const finished = acc.finish();
      for (const key of seriesKeys) point[key] = (finished[key] as number | null | undefined) ?? null;
    }
    return point;
  };
  const groupSeriesFor = (
    buckets: Map<string, Map<number, Acc>>,
    meta: (id: string) => { label: string; provider?: string },
  ): PublicSeries[] =>
    [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, points]) => ({
        id,
        ...meta(id),
        series: timeline.map(time => totalsPoint(points, time)),
      }));

  const modelGroups = ([...byModel].map(([id, acc]) => ({
    ...acc.finish(),
    id,
    label: modelMeta.get(id)?.label ?? id,
    provider: modelMeta.get(id)?.provider ?? null,
  })) as PublicGroup[]).sort((a, b) => Number(b["calls"]) - Number(a["calls"]) || a.id.localeCompare(b.id));
  const providerGroups = ([...byProvider].map(([id, acc]) => ({
    ...acc.finish(),
    id,
    label: id,
    provider: null,
  })) as PublicGroup[]).sort((a, b) => Number(b["calls"]) - Number(a["calls"]) || a.id.localeCompare(b.id));

  const outputRanges = ["0–100", "100–250", "250–500", "500–1k", "1k–2k", "2k–4k", "4k+"];
  const outputDistribution = outputRanges.map(range => ({ range, calls: 0 }));
  for (const session of sessions)
    for (const step of session.steps) {
      const value = step.outputTokens;
      const index = value < 100 ? 0 : value < 250 ? 1 : value < 500 ? 2 : value < 1000 ? 3 : value < 2000 ? 4 : value < 4000 ? 5 : 6;
      outputDistribution[index]!.calls++;
    }

  const contextRanges = ["0–25%", "25–50%", "50–75%", "75–90%", "90–100%+"];
  const contextDistribution = contextRanges.map(range => ({ range, attempts: 0 }));
  const ratios: number[] = [];
  for (const session of sessions)
    for (const step of session.steps) {
      const limit = modelById.get(step.modelId)?.contextLimit;
      const prompt = step.inputTokens + step.cacheReadTokens + step.cacheWriteTokens;
      if (!limit) continue;
      const ratio = prompt / limit;
      ratios.push(ratio);
      contextDistribution[ratio < 0.25 ? 0 : ratio < 0.5 ? 1 : ratio < 0.75 ? 2 : ratio < 0.9 ? 3 : 4]!.attempts++;
    }

  const summaryValues = summary.finish(true);
  const firstOutputs = attempts.map(step => step.firstOutputMs);
  const filteredFirst = firstOutputs.filter((value): value is number => typeof value === "number");
  const transport = {
    attempts: attempts.length + retries,
    failed: attempts.filter(step => step.status === "failed").length,
    cancelled: attempts.filter(step => step.status === "cancelled").length,
    first_output_ms: percentile(filteredFirst, 0.5),
  };
  const groupSeries = groupBy === "provider" ? groupSeriesFor(providerBuckets, id => ({ label: id })) : groupSeriesFor(modelBuckets, id => modelMeta.get(id) ?? { label: id });
  const modelSeries = groupSeriesFor(modelBuckets, id => modelMeta.get(id) ?? { label: id });
  const providerSeries = groupSeriesFor(providerBuckets, id => ({ label: id }));
  return {
    summary: summaryValues,
    series: timeline.map(time => totalsPoint(byBucket, time)),
    modelGroups,
    providerGroups,
    modelSeries,
    providerSeries,
    groups: groupBy === "provider" ? providerGroups : modelGroups,
    groupSeries,
    groupBy,
    outputDistribution: outputDistribution.filter(range => range.calls > 0),
    contextDistribution: contextDistribution.filter(range => range.attempts > 0),
    contextPercentiles: { p50_ratio: percentile(ratios, 0.5), p95_ratio: percentile(ratios, 0.95) },
    transport,
    timeframe: { from: SAMPLE_FROM, to: SAMPLE_TO, timezone: "UTC", endExclusive: true, bucket: "hour" },
  } as PublicAnalytics;
}

export type SampleAccountRow = SampleAccount & {
  calls: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  marketCost: number;
  lastSeen: number | null;
};
export type SampleMachineRow = SampleMachine & {
  calls: number;
  sessions: number;
  totalTokens: number;
  cost: number;
  marketCost: number;
  lastSeen: number | null;
};

export function accountRows(sessions: SampleSession[]): SampleAccountRow[] {
  return sampleAccounts.map(account => {
    const steps = sessions.flatMap(session => session.steps).filter(step => step.accountId === account.id);
    const scoped = sessions.filter(session => session.steps.some(step => step.accountId === account.id));
    return {
      ...account,
      calls: steps.length,
      sessions: scoped.length,
      inputTokens: steps.reduce((sum, step) => sum + step.inputTokens, 0),
      outputTokens: steps.reduce((sum, step) => sum + step.outputTokens, 0),
      totalTokens: steps.reduce((sum, step) => sum + step.totalTokens, 0),
      cost: steps.reduce((sum, step) => sum + step.cost, 0),
      marketCost: steps.reduce((sum, step) => sum + step.marketCost, 0),
      lastSeen: scoped.length ? Math.max(...scoped.map(session => session.endedAt)) : null,
    };
  }).sort((a, b) => b.calls - a.calls);
}

export function machineRows(sessions: SampleSession[]): SampleMachineRow[] {
  return sampleMachines.map(machine => {
    const scoped = sessions.filter(session => session.machineId === machine.id);
    const steps = scoped.flatMap(session => session.steps);
    return {
      ...machine,
      calls: steps.length,
      sessions: scoped.length,
      totalTokens: steps.reduce((sum, step) => sum + step.totalTokens, 0),
      cost: steps.reduce((sum, step) => sum + step.cost, 0),
      marketCost: steps.reduce((sum, step) => sum + step.marketCost, 0),
      lastSeen: scoped.length ? Math.max(...scoped.map(session => session.endedAt)) : null,
    };
  }).sort((a, b) => b.calls - a.calls);
}

export function sessionInputStep(session: SampleSession, index: number) {
  return session.steps[index];
}
