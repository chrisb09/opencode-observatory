import { test, expect } from "bun:test";
import { normalizeUsage, tokenCost, chooseBucket, bucketTime, nextBucket, Aggregate, resolveMarket, outputHistogram, type UsageRecord } from "../apps/server/src/metrics.js";
import { modelColor } from "../apps/web/src/UsageChart.js";
import { usageChartData } from "../apps/web/src/chartData.js";
const lifecycle = { usageSource: "opencode", usageSemantics: "opencode-exclusive-input", inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 16, reasoningTokens: 4 };
test("OpenCode and inclusive provider counters normalize to the same total without overlap", () => {
  const a = normalizeUsage(lifecycle), b = normalizeUsage({ usageSource: "provider", usageSemantics: "provider-inclusive-input", outputSemantics: "inclusive-reasoning", inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 4 });
  expect(a).toEqual(b); expect(a.total_tokens).toBe(120); expect(a.output_tokens).toBe(16); expect(a.prompt_tokens).toBe(100);
  expect(tokenCost(a, { input: 1, output: 2, cache_read: .5, cache_write: 1 })).toBeCloseTo(.00012);
});
test("Gemini visible output and thinking are separate; missing cache splits remain unavailable", () => {
  const u = normalizeUsage({ usageSource: "provider", usageSemantics: "provider-inclusive-input", outputSemantics: "exclusive-reasoning", inputTokens: 100, outputTokens: 16, reasoningTokens: 4, cacheReadTokens: 40, cacheWriteTokens: 0 });
  expect(u.total_tokens).toBe(120); expect(u.completion_tokens).toBe(20);
  const missing = normalizeUsage({ ...lifecycle, cacheReadTokens: null }); expect(missing.total_tokens).toBeNull(); expect(missing.cache_known).toBe(false); expect(tokenCost(missing, { input: 1, output: 2, cache_read: .5, cache_write: 0 })).toBeNull();
  expect(normalizeUsage({ totalTokens: 123 }).total_tokens).toBe(123);
});
test("unverified OpenCode zero defaults are not presented as measured zero usage", () => {
  const zero = { ...lifecycle, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  expect(normalizeUsage(zero).total_tokens).toBeNull(); expect(normalizeUsage(zero).cache_known).toBe(false);
  expect(tokenCost(normalizeUsage(zero), { input: 1, output: 2, cache_read: .5, cache_write: 1 })).toBeNull();
  expect(normalizeUsage({ ...zero, totalTokens: 0 }).total_tokens).toBe(0);
});
test("cache reuse is volume-weighted, never the mean of per-call percentages", () => {
  const base = { id: "1", installation: "i", session: "s", provider: "p", model: "m", model_id: "p/m", machine: "test", agent: "build", account_id: "p/unassigned", account_label: "unassigned", credential_id: "p/unassigned", credential_label: "unassigned", attribution: "unassigned", time: 1, status: "completed", duration: 1, cost: 0, market_cost: null, cache_savings: null, historical: false } as const;
  const aggregate = new Aggregate();
  aggregate.add({ ...base, ...normalizeUsage({ ...lifecycle, inputTokens: 1, cacheReadTokens: 9 }) } as UsageRecord);
  aggregate.add({ ...base, ...normalizeUsage({ ...lifecycle, inputTokens: 900, cacheReadTokens: 100 }) } as UsageRecord);
  aggregate.add({ ...base, ...normalizeUsage({ ...lifecycle, inputTokens: null }) } as UsageRecord);
  const result = aggregate.finish(); expect(result.cache_reuse_ratio).toBeCloseTo(109 / 1010); expect(result.cache_hit_ratio).toBe(1); expect(result.known_cache_calls).toBe(2); expect(result.unknown_usage_calls).toBe(1);
});
test("buckets adapt across hours, days, weeks and real calendar months", () => {
  const from = Date.UTC(2026, 9, 1), to = from + 86400000, bucket = chooseBucket(from, to);
  expect(bucket.unit).toBe("hour"); let count = 0; for (let t = bucketTime(from, bucket); t < to; t = nextBucket(t, bucket)) count++; expect(count).toBe(24);
  expect(chooseBucket(from, from + 7 * 86400000).unit).toBe("six-hour"); expect(chooseBucket(from, from + 30 * 86400000).unit).toBe("day"); expect(chooseBucket(from, from + 365 * 86400000).unit).toBe("week");
  const month = chooseBucket(0, to); expect(month.unit).toBe("month"); expect(nextBucket(Date.UTC(2026, 0, 1), month)).toBe(Date.UTC(2026, 1, 1));
});
test("market matching rejects empty/unknown models and normalizes explicit Antigravity aliases", () => {
  const rate = { model_pattern: "gemini-3.8-flash", input: .75, output: 3.75, cache_read: .075, cache_write: .75 };
  expect(resolveMarket("antigravity-gemini-3.8-flash-high", [rate])).toEqual(rate); expect(resolveMarket("unrelated-model", [rate])).toBeNull(); expect(resolveMarket("", [rate])).toBeNull(); expect(resolveMarket(null, [rate])).toBeNull();
  const muse = { ...rate, model_pattern: "muse-spark-1.3" };expect(resolveMarket("muse-spark-1.3-contributor-free", [muse])).toEqual(muse);
});
test("model colors are stable across reordering and distinct for the displayed models", () => {
  const models = ["openai/gpt-5.5", "google/antigravity-gemini-3.8-flash", "oneprovider/claude-haiku-4-5", "google/antigravity-claude-sonnet-4-6", "opencode-go/glm-5.3", "openai/gpt-6.1-sol", "zai/glm-5.3", "opencode-go/kimi-k3"];
  const colors = models.map(modelColor); expect(new Set(colors).size).toBe(models.length); expect([...models].reverse().map(modelColor).reverse()).toEqual(colors);
  for (const color of colors) expect(color).toMatch(/^hsl\(/);
});
test("adaptive output histogram preserves zeros, empty bins, and the outlier tail",()=>{
  const values=[...Array.from({length:2000},(_,i)=>i%250),25000],bins=outputHistogram(values);
  expect(bins.length).toBeGreaterThanOrEqual(24);expect(bins.length).toBeLessThanOrEqual(33);
  expect(bins.reduce((sum,b)=>sum+b.calls,0)).toBe(values.length);expect(bins.at(-1)!.to).toBeNull();expect(bins.at(-1)!.calls).toBeGreaterThanOrEqual(1);expect(bins.at(-1)!.calls).toBeLessThanOrEqual(Math.ceil(values.length*.02));
  expect(outputHistogram([])).toEqual([]);expect(outputHistogram([0,20,100]).some(b=>b.calls===0)).toBe(true);
});
test("cumulative charts reconcile all models and Other, remain scoped, and carry partial coverage",()=>{
  const point=(time:number,value:number|null,unknown=0)=>({time,total_tokens:value,cost:value==null?null:value/100,market_cost:value==null?null:value/50,unknown_usage_calls:unknown,unknown_cost_calls:unknown,unknown_market_calls:unknown});
  const stats={timeframe:{from:5,to:35},series:[point(0,10),point(10,null,1),point(20,20),point(30,0)],modelSeries:[{id:"A",series:[point(0,6),point(10,null,1),point(20,12),point(30,0)]},{id:"B",series:[point(0,4),point(10,0),point(20,8),point(30,0)]}]};
  const data=usageChartData(stats,"total_tokens",["A"],true);
  expect(data[0].time).toBe(5);expect(data[0].total).toBe(0);expect(data.at(-1)!.time).toBe(35);expect(data.at(-1)!.total).toBe(30);expect(data.at(-1)!.A).toBe(18);expect(data.at(-1)!.other).toBe(12);expect(data.at(-1)!.unknown).toBe(1);
  expect(usageChartData(stats,"cost",["A","B"],true).at(-1)!.total).toBeCloseTo(.3);
  expect(usageChartData(stats,"market_cost",["A"],false)[1].total).toBeNull();
});
