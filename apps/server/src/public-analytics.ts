import { z } from "zod";
import { FilterSchema } from "@observatory/contracts";
import { tenantRead } from "./db.js";
import { usageBucketsReadOnly } from "./rollups.js";
import { Aggregate, bucketTime, nextBucket, outputHistogram, type Bucket, type UsageBucket, type UsageDimensions } from "./metrics.js";
import { HttpError } from "./security.js";

const OTHER = "Other";
const WEEK_MS = 7 * 86400000;
const HOUR_MS = 3600000;
const MAX_LABELS = 64;
const MAX_IN_FLIGHT = 2;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class PublicAnalyticsUnavailable extends Error {
  constructor(readonly retryAfterSeconds = 30, message = "Public analytics are temporarily unavailable") { super(message); }
}

type PublicConfig = {
  tenantId: string;
  providerLabels: Map<string, string>;
  modelLabels: Map<string, string>;
};

function labelMap(name: string): Map<string, string> | null {
  const raw = process.env[name]?.trim();
  if (!raw) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_LABELS) return null;
  const map = new Map<string, string>();
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== "string") return null;
    const key = rawKey.trim(), label = rawValue.trim();
    if (!key || key.length > 1024 || CONTROL.test(key)) return null;
    if (!label || label.length > 80 || CONTROL.test(label)) return null;
    map.set(key, label);
  }
  return map;
}

// Environment opt-in. A missing or invalid tenant disables the endpoint. A
// malformed label map also disables it rather than falling back to raw names.
export function publicConfig(): PublicConfig | null {
  const tenant = process.env.PUBLIC_ANALYTICS_TENANT_ID?.trim();
  if (!tenant || !z.string().uuid().safeParse(tenant).success) return null;
  const providerLabels = labelMap("PUBLIC_ANALYTICS_PROVIDER_LABELS");
  const modelLabels = labelMap("PUBLIC_ANALYTICS_MODEL_LABELS");
  if (!providerLabels || !modelLabels) return null;
  for (const key of modelLabels.keys()) {
    if (!key.includes("/") || key.startsWith("/") || key.endsWith("/")) return null;
  }
  return { tenantId: tenant, providerLabels, modelLabels };
}

const timestamp = z.union([
  z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/, "Expected an integer timestamp").transform(Number).refine(Number.isSafeInteger, "Expected a safe integer timestamp"),
  z.number().int().nonnegative().safe(),
]);
const label = z.string().trim().min(1).max(80).refine(value => !CONTROL.test(value), "Invalid label");
const PublicQuerySchema = z.object({
  from: timestamp.optional(),
  to: timestamp.optional(),
  groupBy: z.enum(["model", "provider"]).default("model"),
  model: label.optional(),
  provider: label.optional(),
}).strict();
type PublicQuery = z.infer<typeof PublicQuerySchema>;

const identityKey = (dimensions: Pick<UsageDimensions, "provider" | "model">, config: PublicConfig) => {
  const provider = config.providerLabels.get(dimensions.provider) ?? OTHER;
  const model = config.modelLabels.get(`${dimensions.provider}/${dimensions.model}`) ?? OTHER;
  return { provider, model, id: `${provider}/${model}` };
};

const matches = (identity: { provider: string; model: string }, query: PublicQuery) =>
  (!query.provider || identity.provider === query.provider) && (!query.model || identity.model === query.model);

const PUBLIC_METRICS = [
  "calls", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
  "prompt_tokens", "completion_tokens", "total_tokens", "cost", "market_cost", "cache_savings", "savings",
  "failures", "imported_calls", "unknown_cost_calls", "unknown_market_calls", "unknown_usage_calls",
  "known_cache_calls", "cache_hit_calls", "cache_reuse_ratio", "cache_hit_ratio",
  "p50_ms", "p95_ms", "p50_output_tokens", "p95_output_tokens",
] as const;
const SERIES_METRICS = PUBLIC_METRICS.filter((key): key is typeof PUBLIC_METRICS[number] => !key.startsWith("p50_") && !key.startsWith("p95_"));

const EMPTY_SERIES: Record<string, number | null> = {
  calls: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, market_cost: 0, cache_savings: 0, savings: 0,
  failures: 0, imported_calls: 0, unknown_cost_calls: 0, unknown_market_calls: 0, unknown_usage_calls: 0,
  known_cache_calls: 0, cache_hit_calls: 0, cache_reuse_ratio: null, cache_hit_ratio: null,
};

function pick(finish: Record<string, unknown>, keys: readonly string[]): Record<string, number | null> {
  const value: Record<string, number | null> = {};
  for (const key of keys) if (key in finish) value[key] = finish[key] as number | null;
  return value;
}

function publicAnalysis(buckets: UsageBucket[], from: number, to: number, query: PublicQuery, config: PublicConfig) {
  const bucket: Bucket = { unit: "hour", ms: HOUR_MS }, summary = new Aggregate();
  const totals = new Map<number, Aggregate>();
  const providerTotals = new Map<string, Aggregate>(), modelTotals = new Map<string, Aggregate>();
  const providerPoints = new Map<string, Map<number, Aggregate>>(), modelPoints = new Map<string, Map<number, Aggregate>>();
  const providerMeta = new Map<string, { label: string }>(), modelMeta = new Map<string, { label: string; provider: string }>();
  for (const row of buckets) {
    const identity = identityKey(row.dimensions, config);
    // Filters are applied after explicit publication so raw identifiers are
    // never accepted as query values and can never be reflected in a result.
    if (!matches(identity, query)) continue;
    const time = bucketTime(row.time, bucket);
    summary.addBucket(row, true);
    if (!totals.has(time)) totals.set(time, new Aggregate()); totals.get(time)!.addBucket(row);
    if (!providerTotals.has(identity.provider)) { providerTotals.set(identity.provider, new Aggregate()); providerMeta.set(identity.provider, { label: identity.provider }); }
    providerTotals.get(identity.provider)!.addBucket(row, true);
    if (!modelTotals.has(identity.id)) { modelTotals.set(identity.id, new Aggregate()); modelMeta.set(identity.id, { label: identity.model, provider: identity.provider }); }
    modelTotals.get(identity.id)!.addBucket(row, true);
    if (!providerPoints.has(identity.provider)) providerPoints.set(identity.provider, new Map());
    const pp = providerPoints.get(identity.provider)!; if (!pp.has(time)) pp.set(time, new Aggregate()); pp.get(time)!.addBucket(row);
    if (!modelPoints.has(identity.id)) modelPoints.set(identity.id, new Map());
    const mp = modelPoints.get(identity.id)!; if (!mp.has(time)) mp.set(time, new Aggregate()); mp.get(time)!.addBucket(row);
  }
  const timeline: number[] = [];
  for (let time = bucketTime(from, bucket); time < to && timeline.length < 768; time = nextBucket(time, bucket)) timeline.push(time);
  const groupSeries = (totalsByGroup: Map<string, Map<number, Aggregate>>, meta: Map<string, { label: string; provider?: string }>) =>
    [...totalsByGroup].sort(([a], [b]) => a.localeCompare(b)).map(([id, points]) => ({
      id, ...meta.get(id)!, series: timeline.map(time => ({ time, ...(points.has(time) ? pick(points.get(time)!.finish(), SERIES_METRICS) : EMPTY_SERIES) })),
    }));
  const providerGroups = ([...providerTotals].map(([id, aggregate]) => ({ id, label: id, ...pick(aggregate.finish(true), PUBLIC_METRICS) })) as Array<Record<string, any>>).sort((a, b) => Number(b.calls ?? 0) - Number(a.calls ?? 0) || a.id.localeCompare(b.id));
  const modelGroups = ([...modelTotals].map(([id, aggregate]) => ({ id, ...modelMeta.get(id)!, ...pick(aggregate.finish(true), PUBLIC_METRICS) })) as Array<Record<string, any>>).sort((a, b) => Number(b.calls ?? 0) - Number(a.calls ?? 0) || a.id.localeCompare(b.id));
  return {
    summary: pick(summary.finish(true), PUBLIC_METRICS),
    series: timeline.map(time => ({ time, ...(totals.has(time) ? pick(totals.get(time)!.finish(), SERIES_METRICS) : EMPTY_SERIES) })),
    providerGroups, modelGroups,
    groups: query.groupBy === "provider" ? providerGroups : modelGroups,
    groupSeries: query.groupBy === "provider" ? groupSeries(providerPoints, providerMeta) : groupSeries(modelPoints, modelMeta),
    outputDistribution: outputHistogram(summary.outputs),
    timeframe: { from, to, timezone: "UTC", endExclusive: true, bucket: bucket.unit },
    groupBy: query.groupBy,
  };
}

let inFlight = 0;

export async function publicAnalytics(input: unknown, options: { now?: number } = {}) {
  const config = publicConfig();
  if (!config) throw new HttpError(404, "Not found");
  const query = PublicQuerySchema.parse(input);
  const allowedProviders = new Set([...config.providerLabels.values(), OTHER]);
  const allowedModels = new Set([...config.modelLabels.values(), OTHER]);
  if (query.provider && !allowedProviders.has(query.provider)) throw new HttpError(400, "Unknown public provider filter");
  if (query.model && !allowedModels.has(query.model)) throw new HttpError(400, "Unknown public model filter");
  const now = options.now ?? Date.now();
  const requestedTo = query.to ?? now, requestedFrom = query.from ?? Math.max(requestedTo - WEEK_MS, now - WEEK_MS);
  if (requestedTo > now) throw new HttpError(400, "to must not be in the future");
  if (requestedFrom < now - WEEK_MS) throw new HttpError(400, "from must be within the last seven days");
  // Inward rounding makes every exposed interval a whole completed hour.
  // Otherwise repeated sub-hour queries could reveal individual call times.
  const from = Math.ceil(requestedFrom / HOUR_MS) * HOUR_MS;
  const to = Math.floor(requestedTo / HOUR_MS) * HOUR_MS;
  if (to <= from) throw new HttpError(400, "to must be later than from");
  if (inFlight >= MAX_IN_FLIGHT) throw new PublicAnalyticsUnavailable(5, "Public analytics are busy");
  inFlight++;
  try {
    const loaded = await tenantRead(config.tenantId, async db => {
      await db.query("SET LOCAL jit=off");
      await db.query("SET LOCAL statement_timeout='5s'");
      return usageBucketsReadOnly(db, config.tenantId, FilterSchema.parse({ from, to }));
    });
    if (!loaded) throw new PublicAnalyticsUnavailable();
    // Transport correlation scans raw requests and shares the private cache.
    // Do not let unauthenticated reads trigger that expensive path.
    return { ...publicAnalysis(loaded.buckets, from, to, query, config),
      transport:{attempts:null,failed:null,cancelled:null,first_output_ms:null},
      contextDistribution:[],contextPercentiles:{p50_ratio:null,p95_ratio:null} };
  } finally { inFlight--; }
}
