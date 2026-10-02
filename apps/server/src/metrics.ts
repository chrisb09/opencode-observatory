export const number = (v: unknown): number | null => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const sumKnown = (...v: (number | null)[]) => v.every(x => x !== null) ? v.reduce<number>((a, b) => a + b!, 0) : null;
export function normalizeUsage(data: Record<string, any>) {
  const input = number(data.inputTokens), read = number(data.cacheReadTokens), write = number(data.cacheWriteTokens);
  const output = number(data.outputTokens), reasoning = number(data.reasoningTokens);
  const reportedTotal = number(data.totalTokens);
  const unverifiedZero = data.usageSource === "opencode" && reportedTotal === null && [input, read, write, output, reasoning].every(v => v === 0);
  const exclusiveInput = data.usageSemantics === "opencode-exclusive-input";
  const exclusiveOutput = data.outputSemantics === "exclusive-reasoning" || (!data.outputSemantics && data.usageSource === "opencode");
  const inclusiveOutput = data.outputSemantics === "inclusive-reasoning" || (!data.outputSemantics && data.usageSource === "provider" && data.usageSemantics === "provider-inclusive-input");
  const prompt = exclusiveInput ? sumKnown(input, read, write) : data.usageSemantics === "provider-inclusive-input" ? input : null;
  const completion = exclusiveOutput ? sumKnown(output, reasoning) : inclusiveOutput ? output : null;
  const visible = exclusiveOutput ? output : inclusiveOutput && output !== null && reasoning !== null ? Math.max(0, output - reasoning) : null;
  const uncached = exclusiveInput ? input : prompt !== null && read !== null && write !== null ? Math.max(0, prompt - read - write) : null;
  if (unverifiedZero) return { input_tokens: null, output_tokens: null, reasoning_tokens: null, cache_read_tokens: null, cache_write_tokens: null, prompt_tokens: null, completion_tokens: null, total_tokens: null, cache_known: false, unverified_zero: true };
  return {
    input_tokens: uncached, output_tokens: visible, reasoning_tokens: reasoning, cache_read_tokens: read, cache_write_tokens: write,
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: reportedTotal ?? sumKnown(prompt, completion),
    cache_known: prompt !== null && read !== null, unverified_zero: false,
  };
}
export type NormalizedUsage = ReturnType<typeof normalizeUsage>;
export type Rates = { input: number; output: number; cache_read: number; cache_write: number };
export function tokenCost(u: NormalizedUsage, rates: Rates): number | null {
  if (u.unverified_zero) return null;
  let inputCost: number | null = null;
  if (u.input_tokens !== null && (u.cache_read_tokens !== null || rates.cache_read === 0) && (u.cache_write_tokens !== null || rates.cache_write === 0)) {
    inputCost = u.input_tokens * rates.input + (u.cache_read_tokens ?? 0) * rates.cache_read + (u.cache_write_tokens ?? 0) * rates.cache_write;
  } else if (u.prompt_tokens !== null && rates.input === rates.cache_read && rates.input === rates.cache_write) inputCost = u.prompt_tokens * rates.input;
  return inputCost !== null && u.completion_tokens !== null ? (inputCost + u.completion_tokens * rates.output) / 1000000 : null;
}
export function modelName(model: string) {
  const normalized = model.toLowerCase().split("/").at(-1)!.replace(/^antigravity-/, "").replace(/:(free|thinking)$/, "").replace(/-(thinking|high|low|medium|agent|free|preview)$/, "");
  // Explicit contributor/free-tier alias: value the same underlying model at the standard reference rate.
  return normalized === "muse-spark-1.3-contributor" ? "muse-spark-1.3" : normalized;
}
export function resolveMarket(model: string | null, catalog: Array<Rates & { model_pattern: string }>) {
  if (!model) return null;
  const normalized = modelName(model);
  // Never fuzzy-match unknown/empty model strings to arbitrary, more expensive model versions.
  return catalog.find(r => r.model_pattern === normalized) ?? null;
}
export type Bucket = { unit: "hour" | "six-hour" | "day" | "week" | "month"; ms: number | null };
export function chooseBucket(from: number, to: number): Bucket {
  const days = (to - from) / 86400000;
  return days <= 2 ? { unit: "hour", ms: 3600000 } : days <= 14 ? { unit: "six-hour", ms: 21600000 } : days <= 90 ? { unit: "day", ms: 86400000 } : days <= 730 ? { unit: "week", ms: 604800000 } : { unit: "month", ms: null };
}
export function bucketTime(time: number, bucket: Bucket) {
  if (bucket.ms !== null) return Math.floor(time / bucket.ms) * bucket.ms;
  const date = new Date(time); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}
export function nextBucket(time: number, bucket: Bucket) {
  if (bucket.ms !== null) return time + bucket.ms;
  const date = new Date(time); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
export type UsageRecord = NormalizedUsage & {
  id: string; installation: string; session: string | null; provider: string; model: string; model_id: string; machine: string; agent: string;
  account_id: string; account_label: string; credential_id: string; credential_label: string; credential_kind?: "api-key" | "oauth" | "unavailable"; attribution: "observed" | "configured" | "assigned" | "unassigned";
  time: number; status: string; duration: number | null; cost: number | null; market_cost: number | null; cache_savings: number | null; historical: boolean;
};
const sums = ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "cost", "market_cost", "cache_savings"] as const;
export class Aggregate {
  calls = 0; failures = 0; imported = 0; knownCache = 0; hitCalls = 0; knownPrompt = 0; cacheReads = 0; unknownCost = 0; unknownMarket = 0; unknownTotal = 0;
  values = Object.fromEntries(sums.map(k => [k, null])) as Record<typeof sums[number], number | null>;
  durations: number[] = []; outputs: number[] = []; accounts = new Set<string>(); keys = new Set<string>(); apiDifference: number | null = null;
  add(r: UsageRecord, distributions = false) {
    this.calls++; if (r.status === "failed") this.failures++; if (r.historical) this.imported++;
    if (r.cost === null) this.unknownCost++; if (r.market_cost === null) this.unknownMarket++; if (r.total_tokens === null) this.unknownTotal++;
    for (const k of sums) if (r[k] !== null) this.values[k] = (this.values[k] ?? 0) + r[k]!;
    if (r.cache_known) { this.knownCache++; this.knownPrompt += r.prompt_tokens!; this.cacheReads += r.cache_read_tokens!; if (r.cache_read_tokens! > 0) this.hitCalls++; }
    if (r.market_cost !== null && r.cost !== null) this.apiDifference = (this.apiDifference ?? 0) + r.market_cost - r.cost;
    if (r.attribution !== "unassigned") this.accounts.add(r.account_id);
    if (r.credential_kind === "api-key" || (!r.credential_kind && !r.credential_id.endsWith("/unassigned"))) this.keys.add(r.credential_id);
    if (distributions) { if (r.duration !== null) this.durations.push(r.duration); if (r.output_tokens !== null) this.outputs.push(r.output_tokens); }
  }
  finish(distributions = false) {
    if (distributions) { this.durations.sort((a, b) => a - b); this.outputs.sort((a, b) => a - b); }
    return { calls: this.calls, ...this.values, savings: this.apiDifference, failures: this.failures, imported_calls: this.imported,
      unknown_cost_calls: this.unknownCost, unknown_market_calls: this.unknownMarket, unknown_usage_calls: this.unknownTotal,
      known_cache_calls: this.knownCache, cache_hit_calls: this.hitCalls,
      cache_reuse_ratio: this.knownPrompt > 0 ? this.cacheReads / this.knownPrompt : null,
      cache_hit_ratio: this.knownCache > 0 ? this.hitCalls / this.knownCache : null, account_count: this.accounts.size, credential_count: this.keys.size,
      ...(distributions ? { p50_ms: percentile(this.durations, .5), p95_ms: percentile(this.durations, .95), p50_output_tokens: percentile(this.outputs, .5), p95_output_tokens: percentile(this.outputs, .95) } : {}) };
  }
}
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null; const index = (sorted.length - 1) * p, low = Math.floor(index);
  return sorted[low]! + (sorted[Math.ceil(index)]! - sorted[low]!) * (index - low);
}
export function outputHistogram(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return [];
  // Reserve the long tail for an explicit overflow bin, rather than letting a
  // handful of long responses collapse the common short outputs into one bin.
  const core = Math.max(1, Math.floor(percentile(sorted, .99)!) + 1), width = Math.max(1, Math.ceil(core / 32));
  const bins = Array.from({length: Math.min(32, Math.ceil(core / width))}, (_,i) => ({ from: i*width, to: (i+1)*width, range: `${i*width}–${(i+1)*width-1}`, calls: 0 }));
  const end = bins.at(-1)!.to;
  const overflow = { from: end, to: null as number | null, range: `${end}+`, calls: 0 };
  for (const value of sorted) { if (value >= end) overflow.calls++; else bins[Math.floor(value/width)]!.calls++; }
  return overflow.calls ? [...bins, overflow] : bins;
}
