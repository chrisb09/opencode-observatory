import { FilterSchema, type Filters } from "@observatory/contracts";
import { tenant } from "./db.js";
import { cached } from "./cache.js";
import { Aggregate, normalizeUsage, number, tokenCost, resolveMarket, chooseBucket, bucketTime, nextBucket, percentile, outputHistogram, type UsageRecord, type Rates } from "./metrics.js";

function where(f: Filters, base = "e", start = 2, identity = true) {
  const values: unknown[] = [], conditions: string[] = [];
  const add = (column: string, value: unknown, op = "=") => { values.push(value); conditions.push(`${column} ${op} $${start + values.length - 1}`); };
  if (f.from !== undefined) add(`${base}.observed_at`, f.from, ">=");
  if (f.to !== undefined) add(`${base}.observed_at`, f.to, "<");
  for (const key of ["provider", "model", "status"] as const) if (f[key]) add(`${base}.data->>'${key}'`, f[key]);
  if (identity) for (const key of ["account", "credential"] as const) if (f[key]) add(`${base}.data->>'${key}'`, f[key]);
  if (f.machine) add(`${base}.machine`, f.machine);
  if (f.sessionId) add(`${base}.session_id`, f.sessionId);
  if (f.projectId) add(`${base}.project_id`, f.projectId);
  if (f.installationId) add(`${base}.installation_id`, f.installationId);
  return { sql: conditions.length ? " AND " + conditions.join(" AND ") : "", values };
}
const columns = "e.kind,e.entity_id,e.installation_id,e.session_id,e.message_id,e.machine,e.observed_at,e.revision,e.historical,e.data";
// UNION ALL keeps the indexed step path independent of the message fallback anti-join.
function usageSQL(w: ReturnType<typeof where>) {
  return `SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='step' ${w.sql}
    UNION ALL SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='message' AND e.data ? 'inputTokens' ${w.sql}
      AND NOT EXISTS (SELECT 1 FROM entities s WHERE s.user_id=$1 AND s.installation_id=e.installation_id AND s.kind='step' AND s.message_id=e.entity_id)
    UNION ALL SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='attempt' AND e.data->>'purpose'='auxiliary' ${w.sql}
      AND NOT EXISTS (SELECT 1 FROM entities s WHERE s.user_id=$1 AND s.installation_id=e.installation_id AND s.kind='message'
        AND s.data->>'parentMessageId'=e.message_id AND s.data->>'provider'=e.data->>'provider' AND s.data->>'model'=e.data->>'model')`;
}
type Assignment = { id: string; provider: string; installation_id: string | null; from_time: string; to_time: string | null; account: string; label: string };
type Price = Rates & { id: string; provider: string; model: string; account: string | null; effective_at: string };
type Lookup = { aliases: Map<string, string>; assignments: Assignment[]; prices: Price[]; catalog: Array<Rates & { model_pattern: string }> };
async function lookups(db: any, userId: string): Promise<Lookup> {
  const aliases = (await db.query("SELECT fingerprint,alias FROM account_aliases WHERE user_id=$1", [userId])).rows;
  const assignments = (await db.query("SELECT * FROM account_assignments WHERE user_id=$1 ORDER BY (installation_id IS NOT NULL) DESC,from_time DESC,id", [userId])).rows;
  const prices = (await db.query("SELECT * FROM prices WHERE user_id=$1 ORDER BY (account IS NOT NULL) DESC,effective_at DESC,id", [userId])).rows;
  const catalog = (await db.query("SELECT * FROM market_rates ORDER BY model_pattern")).rows;
  const rates = (r: any) => ({ ...r, input: Number(r.input), output: Number(r.output), cache_read: Number(r.cache_read), cache_write: Number(r.cache_write) });
  return { aliases: new Map(aliases.map((a: any) => [a.fingerprint, a.alias])), assignments, prices: prices.map(rates), catalog: catalog.map(rates) };
}
function records(rows: any[], lookup: Lookup): UsageRecord[] {
  const markets = new Map<string, Rates | null>();
  return rows.map(row => {
    const data = row.data, provider = data.provider ?? "Unknown", model = data.model ?? "Unknown", time = Number(row.observed_at);
    const u = normalizeUsage(data);
    const assignment = !data.account ? lookup.assignments.find(a => a.provider === provider && (!a.installation_id || a.installation_id === row.installation_id) && time >= Number(a.from_time) && (a.to_time === null || time < Number(a.to_time))) : undefined;
    const account = data.account ?? assignment?.account ?? null, credential = data.credential ?? null;
    const attribution = assignment ? "assigned" : account ? data.accountSource ?? (String(account).startsWith("hmac:") ? "observed" : "configured") : "unassigned";
    const price = lookup.prices.find(p => p.provider === provider && p.model === model && (!p.account || p.account === account || p.account === credential) && Number(p.effective_at) <= time);
    if (!markets.has(model)) markets.set(model, resolveMarket(model, lookup.catalog));
    const rates = price ?? markets.get(model) ?? null;
    const marketCost = rates ? tokenCost(u, rates) : null;
    const cacheSavings = rates && u.cache_known && u.cache_read_tokens !== null ? u.cache_read_tokens * (rates.input - rates.cache_read) / 1000000 : null;
    return { ...u, id: row.entity_id, installation: row.installation_id, session: row.session_id, provider, model, model_id: `${provider}/${model}`,
      machine: row.machine, agent: data.agent ?? "Unknown", time, status: data.status ?? "unknown", duration: number(data.durationMs),
      cost: number(data.cost), market_cost: marketCost, cache_savings: cacheSavings, historical: row.historical === true,
       account_id: `${provider}/${account ?? "unassigned"}`, account_label: account ? lookup.aliases.get(account) ?? assignment?.label ?? (String(account).startsWith("hmac:") ? `Account ${String(account).slice(5, 13)}` : account) : "Account unassigned",
      credential_id: `${provider}/${credential ?? (data.authType === "oauth" ? "oauth" : "unassigned")}`, credential_label: credential ? lookup.aliases.get(credential) ?? `Key ${String(credential).replace("hmac:", "").slice(0, 8)}` : data.authType === "oauth" ? "OAuth (no API key)" : "Key unavailable", credential_kind: credential ? "api-key" : data.authType === "oauth" ? "oauth" : "unavailable", attribution };
  });
}
function identityMatches(r: UsageRecord, f: Filters) {
  return (!f.account || r.account_id === f.account || r.account_id === `${r.provider}/${f.account}`) && (!f.credential || r.credential_id === f.credential || r.credential_id === `${r.provider}/${f.credential}`);
}
function dataKey(f: Filters) { const { groupBy, sortBy, sortDir, limit, offset, ...scope } = f; return JSON.stringify(scope); }
async function facts(userId: string, f: Filters) {
  return cached(userId, `facts:${dataKey(f)}`, () => tenant(userId, async db => {
    await db.query("SET LOCAL jit=off");
    await db.query("SET LOCAL statement_timeout='5s'");
    const w = where(f, "e", 2, false);
    const rows = await db.query(usageSQL(w), [userId, ...w.values]);
    const lookup = await lookups(db, userId);
    return { records: records(rows.rows, lookup).filter(r => identityMatches(r, f)), lookup };
  }));
}
function group(records: UsageRecord[], type: Filters["groupBy"]) {
  const groups = new Map<string, { aggregate: Aggregate; label: string; provider: string | null; attribution: string | null; credential_kind?: string }>();
  for (const r of records) {
    const id = { model: r.model_id, provider: r.provider, account: r.account_id, credential: r.credential_id, machine: r.machine, agent: r.agent }[type];
    const label = type === "account" ? `${r.provider} · ${r.account_label}` : type === "credential" ? `${r.provider} · ${r.credential_label}` : id;
    if (!groups.has(id)) groups.set(id, { aggregate: new Aggregate(), label, provider: ["account", "credential", "provider"].includes(type) ? r.provider : null, attribution: type === "account" ? r.attribution : null, ...(type === "credential" ? {credential_kind:r.credential_kind} : {}) });
    groups.get(id)!.aggregate.add(r, true);
  }
  return [...groups].map(([id, v]) => ({ id, label: v.label, provider: v.provider, attribution: v.attribution, credential_kind:v.credential_kind, ...v.aggregate.finish(true) })).sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
}
function series(records: UsageRecord[], from: number, to: number) {
  const bucket = chooseBucket(from, to);
  const totals = new Map<number, Aggregate>(), models = new Map<string, Map<number, Aggregate>>();
  for (const r of records) {
    const time = bucketTime(r.time, bucket);
    if (!totals.has(time)) totals.set(time, new Aggregate()); totals.get(time)!.add(r);
    if (!models.has(r.model_id)) models.set(r.model_id, new Map());
    const map = models.get(r.model_id)!; if (!map.has(time)) map.set(time, new Aggregate()); map.get(time)!.add(r);
  }
  const timeline: number[] = [];
  for (let t = bucketTime(from, bucket); t < to && timeline.length < 768; t = nextBucket(t, bucket)) timeline.push(t);
  const empty = { calls: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, market_cost: 0, cache_savings: 0, cache_reuse_ratio: null, cache_hit_ratio: null, unknown_usage_calls: 0, unknown_market_calls: 0 };
  return { bucket, series: timeline.map(time => ({ time, ...(totals.get(time)?.finish() ?? empty) })), modelSeries: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([id, points]) => ({ id, label: id, series: timeline.map(time => ({ time, ...(points.get(time)?.finish() ?? empty) })) })) };
}
export async function analytics(userId: string, query: unknown) {
  const f = FilterSchema.parse(query);
  const base = await cached(userId, `analytics:${dataKey(f)}`, async () => {
    const { records: rs, lookup } = await facts(userId, f);
    const summary = new Aggregate(); for (const r of rs) summary.add(r, true);
    const to = f.to ?? Date.now(), from = f.from ?? (rs.length ? rs.reduce((t,r)=>Math.min(t,r.time),to) : to - 7 * 86400000);
    const chart = series(rs, from, to);
    const {rows:attempts,records:ar}=await attemptFacts(userId,f);
    const selectedIds = new Set(ar.map(r => `${r.installation}:${r.id}`));
    const firstOutputs: number[] = [], ratios: number[] = [];
    for (const a of attempts) if (selectedIds.has(`${a.installation_id}:${a.entity_id}`)) { const first = number(a.data.firstOutputMs); if (first !== null) firstOutputs.push(first); const u = normalizeUsage(a.data), limit = number(a.data.contextLimit); if (u.prompt_tokens !== null && limit && limit > 0) ratios.push(u.prompt_tokens / limit); }
    firstOutputs.sort((a, b) => a - b); ratios.sort((a, b) => a - b);
    const ranges = ["0–25%", "25–50%", "50–75%", "75–90%", "90–100%+"];
    const context = ranges.map(range => ({ range, attempts: 0 })); for (const ratio of ratios) context[ratio < .25 ? 0 : ratio < .5 ? 1 : ratio < .75 ? 2 : ratio < .9 ? 3 : 4]!.attempts++;
    return { summary: summary.finish(true), ...chart, modelGroups: group(rs, "model"), providerGroups: group(rs, "provider"), accountGroups: group(rs, "account"), credentialGroups: group(rs, "credential"), machineGroups: group(rs, "machine"), agentGroups: group(rs, "agent"),
      outputDistribution: outputHistogram(rs.flatMap(r=>r.output_tokens === null ? [] : [r.output_tokens])),
      contextDistribution: context.filter(x => x.attempts > 0), contextPercentiles: { p50_ratio: percentile(ratios, .5), p95_ratio: percentile(ratios, .95) },
      transport: { attempts: ar.length, failed: ar.filter(a => a.status === "failed").length, cancelled: ar.filter(a => a.status === "cancelled").length, first_output_ms: percentile(firstOutputs, .5) },
      timeframe: { from, to, timezone: "UTC", endExclusive: true, bucket: chart.bucket.unit },
      notes: ["Recorded costs are provider-reported amounts or OpenCode estimates, not invoices. Market value excludes subscription fees.", "Totals normalize cache and reasoning overlap; partial measurements remain unavailable.", "Reuse is token-weighted provider-reported cache reuse, not a comparison of prompt contents.", "Unassigned historical accounts and keys are not inferred from provider names."] };
  });
  const groups = { model: base.modelGroups, provider: base.providerGroups, account: base.accountGroups, credential: base.credentialGroups, machine: base.machineGroups, agent: base.agentGroups }[f.groupBy];
  return { ...base, groups };
}
export const sortExpressions: Record<string, string> = {
  observed_at: "e.observed_at", entity_id: "e.entity_id", machine: "e.machine",
  ...Object.fromEntries(["model", "provider", "status", "agent", "tool", "mime", "coverage"].map(k => [k, `e.data->>'${k}'`])),
  ...Object.fromEntries(["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cost", "durationMs", "bytes", "argumentBytes", "outputBytes"].map(k => [k, `(e.data->>'${k}')::numeric`])),
  totalTokens: `CASE WHEN e.data->>'totalTokens' IS NULL AND e.data->>'usageSource'='opencode'
    AND (e.data->>'inputTokens')::numeric=0 AND (e.data->>'outputTokens')::numeric=0 AND (e.data->>'reasoningTokens')::numeric=0 AND (e.data->>'cacheReadTokens')::numeric=0 AND (e.data->>'cacheWriteTokens')::numeric=0 THEN NULL
    ELSE COALESCE((e.data->>'totalTokens')::numeric,
    (CASE WHEN e.data->>'usageSemantics'='opencode-exclusive-input' THEN (e.data->>'inputTokens')::numeric+(e.data->>'cacheReadTokens')::numeric+(e.data->>'cacheWriteTokens')::numeric
      WHEN e.data->>'usageSemantics'='provider-inclusive-input' THEN (e.data->>'inputTokens')::numeric END)
    +(CASE WHEN e.data->>'outputSemantics'='exclusive-reasoning' OR (e.data->>'outputSemantics' IS NULL AND e.data->>'usageSource'='opencode') THEN (e.data->>'outputTokens')::numeric+(e.data->>'reasoningTokens')::numeric
      WHEN e.data->>'outputSemantics'='inclusive-reasoning' OR (e.data->>'outputSemantics' IS NULL AND e.data->>'usageSource'='provider' AND e.data->>'usageSemantics'='provider-inclusive-input') THEN (e.data->>'outputTokens')::numeric END)) END`,
};
function sortRows<T>(rows: T[], f: Filters, accessor: (r: T) => any) {
  return rows.sort((a, b) => { const va = accessor(a), vb = accessor(b); if (va == null) return vb == null ? 0 : 1; if (vb == null) return -1; const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb)); return (f.sortDir === "asc" ? cmp : -cmp); });
}
async function entityPage(userId: string, kind: string, query: unknown) {
  const f = FilterSchema.parse(query);
  if (kind === "session") {
    const { records: rs } = await facts(userId, { ...f, status: undefined });
    const aggregates = new Map<string, Aggregate>();
    const sessionModels = new Map<string, Set<string>>();
    const sessionAgents = new Map<string, Set<string>>();
    for (const r of rs) if (r.session) {
      const key = `${r.installation}:${r.session}`;
      if (!aggregates.has(key)) aggregates.set(key, new Aggregate());
      aggregates.get(key)!.add(r);
      if (r.model && r.model !== "Unknown") {
        if (!sessionModels.has(key)) sessionModels.set(key, new Set());
        sessionModels.get(key)!.add(r.model);
      }
      if (r.agent && r.agent !== "Unknown") {
        if (!sessionAgents.has(key)) sessionAgents.set(key, new Set());
        sessionAgents.get(key)!.add(r.agent);
      }
    }
    const w = where({ ...f, provider: undefined, model: undefined, account: undefined, credential: undefined, status: undefined });
    const sessions = await tenant(userId, async db => (await db.query(`SELECT e.* FROM entities e WHERE e.user_id=$1 AND e.kind='session' ${w.sql}`, [userId, ...w.values])).rows);
    const filtered = sessions.filter(row => !(f.provider || f.model || f.account || f.credential) || aggregates.has(`${row.installation_id}:${row.entity_id}`)).map(row => {
      const key = `${row.installation_id}:${row.entity_id}`;
      const aggregate = aggregates.get(key)?.finish();
      const distinctModels = sessionModels.has(key) ? [...sessionModels.get(key)!] : (row.data.model ? [row.data.model] : []);
      const distinctAgents = sessionAgents.has(key) ? [...sessionAgents.get(key)!] : (row.data.agent ? [row.data.agent] : []);
      const metrics = aggregate ? { inputTokens: aggregate.input_tokens, outputTokens: aggregate.output_tokens, reasoningTokens: aggregate.reasoning_tokens, cacheReadTokens: aggregate.cache_read_tokens, cacheWriteTokens: aggregate.cache_write_tokens, totalTokens: aggregate.total_tokens, cost: aggregate.cost, marketCost: aggregate.market_cost, cacheReuseRatio: aggregate.cache_reuse_ratio, calls: aggregate.calls, unknownMarketCalls: aggregate.unknown_market_calls } : { totalTokens: normalizeUsage(row.data).total_tokens };
      return { ...row, data: { ...row.data, ...metrics, models: distinctModels, agents: distinctAgents } };
    }).filter(row => !f.status || row.data.status === f.status);
    const sorted = sortRows(filtered, f, row => f.sortBy === "observed_at" ? Number(row.observed_at) : f.sortBy === "machine" || f.sortBy === "entity_id" ? row[f.sortBy] : row.data[f.sortBy]);
    return { items: sorted.slice(f.offset, f.offset + f.limit), total: sorted.length, limit: f.limit, offset: f.offset };
  }
  if (f.account || f.credential || f.sortBy === "marketCost") {
    const w = where(f, "e", 2, false), n = w.values.length + 2;
    return tenant(userId, async db => {
      await db.query("SET LOCAL jit=off");
      const lean = (await db.query(`SELECT ${columns} FROM entities e WHERE e.user_id=$1 ${w.sql} AND e.kind=$${n}`, [userId, ...w.values, kind])).rows;
      const lookup = await lookups(db, userId), normalized = records(lean, lookup);
      const matching = lean.map((row, i) => ({ ...row, data: { ...row.data, totalTokens: normalized[i]!.total_tokens, marketCost: normalized[i]!.market_cost }, normalized: normalized[i]! })).filter(row => identityMatches(row.normalized, f));
      const sorted = sortRows(matching, f, row => f.sortBy === "observed_at" ? Number(row.observed_at) : f.sortBy === "machine" || f.sortBy === "entity_id" ? row[f.sortBy] : row.data[f.sortBy]);
      const page = sorted.slice(f.offset, f.offset + f.limit);
      if (!page.length) return { items: [], total: sorted.length, limit: f.limit, offset: f.offset };
      const full = (await db.query(`SELECT e.* FROM entities e JOIN jsonb_to_recordset($3::jsonb) AS p(installation_id uuid,entity_id text) ON e.installation_id=p.installation_id AND e.entity_id=p.entity_id WHERE e.user_id=$1 AND e.kind=$2`, [userId, kind, JSON.stringify(page.map(row => ({ installation_id: row.installation_id, entity_id: row.entity_id })))] )).rows;
      const indexed = new Map(full.map(row => [`${row.installation_id}:${row.entity_id}`, row]));
      return { items: page.map(row => ({ ...indexed.get(`${row.installation_id}:${row.entity_id}`), data: row.data })), total: sorted.length, limit: f.limit, offset: f.offset };
    });
  }
  const w = where(f); const n = w.values.length + 2;
  return tenant(userId, async db => {
    await db.query("SET LOCAL jit=off");
    const order = sortExpressions[f.sortBy] ?? sortExpressions.observed_at;
    const rows = await db.query(`SELECT e.* FROM entities e WHERE e.user_id=$1 ${w.sql} AND e.kind=$${n} ORDER BY ${order} ${f.sortDir === "asc" ? "ASC" : "DESC"} NULLS LAST,e.entity_id LIMIT $${n + 1} OFFSET $${n + 2}`, [userId, ...w.values, kind, f.limit, f.offset]);
    const lookup = await lookups(db, userId); const normalized = records(rows.rows, lookup);
    const total = await db.query(`SELECT count(*)::int AS count FROM entities e WHERE e.user_id=$1 ${w.sql} AND e.kind=$${n}`, [userId, ...w.values, kind]);
    return { items: rows.rows.map((row, i) => ({ ...row, data: { ...row.data, totalTokens: normalized[i]!.total_tokens, marketCost: normalized[i]!.market_cost, cacheReuseRatio: normalized[i]!.cache_known && normalized[i]!.prompt_tokens! > 0 ? normalized[i]!.cache_read_tokens! / normalized[i]!.prompt_tokens! : null } })), total: total.rows[0].count, limit: f.limit, offset: f.offset };
  });
}
async function attemptFacts(userId:string,f:Filters) {
  return cached(userId,`attempts:${dataKey(f)}`,()=>tenant(userId,async db=>{
    await db.query("SET LOCAL jit=off");
    const w=where(f,"e",2,false),lookup=await lookups(db,userId);
    const rows=(await db.query(`SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='attempt' ${w.sql}`,[userId,...w.values])).rows;
    const completed=rows.filter(row=>row.data.status==="completed"&&number(row.data.endedAt)!==null).map(row=>({installation_id:row.installation_id,session_id:row.session_id,message_id:row.message_id,entity_id:row.entity_id,provider:row.data.provider,model:row.data.model,account:row.data.account??null,end_time:Number(row.data.endedAt)}));
    if(completed.length){
      const candidates=(await db.query(`SELECT s.data,s.entity_id,s.installation_id,p.entity_id AS attempt_id FROM entities s
        JOIN entities m ON m.user_id=s.user_id AND m.installation_id=s.installation_id AND m.kind='message' AND m.entity_id=s.message_id
        JOIN jsonb_to_recordset($2::jsonb) AS p(installation_id uuid,session_id text,message_id text,entity_id text,provider text,model text,account text,end_time bigint)
        ON p.installation_id=s.installation_id AND p.session_id=s.session_id AND (p.message_id=s.message_id OR p.message_id=m.data->>'parentMessageId')
        AND p.provider=s.data->>'provider' AND p.model=s.data->>'model'
        AND (p.account IS NULL OR s.data->>'account' IS NULL OR p.account=s.data->>'account')
        AND s.revision BETWEEN p.end_time-1000 AND p.end_time+1000
        WHERE s.user_id=$1 AND s.kind='step' AND NOT s.historical AND s.data->>'status'='completed'`,[userId,JSON.stringify(completed)])).rows;
      const byAttempt=new Map<string,any[]>(),byStep=new Map<string,number>();
      for(const candidate of candidates){const a=`${candidate.installation_id}:${candidate.attempt_id}`,s=`${candidate.installation_id}:${candidate.entity_id}`;if(!byAttempt.has(a))byAttempt.set(a,[]);byAttempt.get(a)!.push(candidate);byStep.set(s,(byStep.get(s)??0)+1);}
      for(const row of rows){
        if(normalizeUsage(row.data).total_tokens!==null)continue;
        const matches=byAttempt.get(`${row.installation_id}:${row.entity_id}`);if(matches?.length!==1)continue;
        const step=matches[0];if(byStep.get(`${step.installation_id}:${step.entity_id}`)!==1||normalizeUsage(step.data).total_tokens===null)continue;
        const usage=Object.fromEntries(["inputTokens","outputTokens","reasoningTokens","cacheReadTokens","cacheWriteTokens","totalTokens","usageSource","usageSemantics","outputSemantics","cost","costSource"].filter(key=>step.data[key]!==undefined&&(!["cost","costSource"].includes(key)||number(row.data.cost)===null)).map(key=>[key,step.data[key]]));
        row.data={...row.data,...usage,usageProvenance:"lifecycle-correlated"};
      }
    }
    return {rows,records:records(rows,lookup).filter(r=>identityMatches(r,f)),lookup};
  }));
}
export async function listEntities(userId:string,kind:string,query:unknown) {
  const page=await entityPage(userId,kind,query);
  if(kind!=="attempt")return page;
  const f=FilterSchema.parse(query),{records:rs,rows,lookup}=await attemptFacts(userId,f);
  // Enrichment is read-only and does not replace stored transport measurements.
  const enriched=new Map(rows.map(row=>[`${row.installation_id}:${row.entity_id}`,row.data]));
  const items=page.items.map((row:any)=>({...row,data:{...row.data,...enriched.get(`${row.installation_id}:${row.entity_id}`)}}));
  const normalized=records(items,lookup);items.forEach((row:any,i:number)=>{row.data.totalTokens=normalized[i]!.total_tokens;row.data.marketCost=normalized[i]!.market_cost;});
  if(["inputTokens","outputTokens","totalTokens","cost","marketCost"].includes(f.sortBy)&&rows.some(row=>row.data.usageProvenance)){
    const selectedRows=rows.filter(row=>identityMatches(records([row],lookup)[0]!,f));
    const values=records(selectedRows,lookup);const byId=new Map(values.map(r=>[`${r.installation}:${r.id}`,r]));
    const sorted=sortRows(selectedRows,f,row=>{const r=byId.get(`${row.installation_id}:${row.entity_id}`)!;return f.sortBy==="totalTokens"?r.total_tokens:f.sortBy==="marketCost"?r.market_cost:row.data[f.sortBy];});
    const ids=sorted.slice(f.offset,f.offset+f.limit);
    const full=await tenant(userId,async db=>(await db.query(`SELECT e.* FROM entities e JOIN jsonb_to_recordset($3::jsonb) AS p(installation_id uuid,entity_id text) ON e.installation_id=p.installation_id AND e.entity_id=p.entity_id WHERE e.user_id=$1 AND e.kind=$2`,[userId,kind,JSON.stringify(ids.map(row=>({installation_id:row.installation_id,entity_id:row.entity_id})))] )).rows);
    const indexed=new Map(full.map(row=>[`${row.installation_id}:${row.entity_id}`,row]));
    items.splice(0,items.length,...ids.map(row=>{const r=byId.get(`${row.installation_id}:${row.entity_id}`)!;return {...indexed.get(`${row.installation_id}:${row.entity_id}`),data:{...row.data,totalTokens:r.total_tokens,marketCost:r.market_cost}};}));
  }
  const selected=new Set(rs.map(r=>`${r.installation}:${r.id}`)),aggregate=new Aggregate(),first:number[]=[];
  for(const r of rs)aggregate.add(r,true);
  for(const row of rows)if(selected.has(`${row.installation_id}:${row.entity_id}`)){const value=number(row.data.firstOutputMs);if(value!==null)first.push(value);}
  first.sort((a,b)=>a-b);
  return {...page,items,summary:{...aggregate.finish(true),attempts:rs.length,completed:rs.filter(r=>r.status==="completed").length,failed:rs.filter(r=>r.status==="failed").length,cancelled:rs.filter(r=>r.status==="cancelled").length,running:rs.filter(r=>r.status==="running").length,known_usage:rs.filter(r=>r.total_tokens!==null).length,first_output_ms:percentile(first,.5)}};
}
export async function dimensions(userId: string) {
  return cached(userId, "dimensions", () => tenant(userId, async db => {
    await db.query("SET LOCAL jit=off");
    const rows = (await db.query(`SELECT ${columns},e.project_id FROM entities e WHERE e.user_id=$1 AND e.kind IN ('step','message','attempt') AND e.data->>'provider' IS NOT NULL`, [userId])).rows;
    const lookup = await lookups(db, userId);
    const normalized=records(rows,lookup),unique=new Map<string,any>();
    rows.forEach((row,i)=>{const r=normalized[i]!;const value={provider:r.provider,model:r.model,account:r.attribution==="unassigned"?null:r.account_id.slice(r.provider.length+1),credential:row.data.credential??null,account_label:r.account_label,credential_label:r.credential_label,accountSource:r.attribution,authType:row.data.authType??null,machine:row.machine,installation_id:row.installation_id,project_id:row.project_id};unique.set(JSON.stringify(value),value);});
    return [...unique.values()];
  }));
}
export async function machines(userId: string) {
  return cached(userId, "machines", () => tenant(userId, async db => (await db.query(`SELECT installation_id,machine,max(revision)::bigint AS last_seen,count(DISTINCT instance_id)::int AS instances,count(DISTINCT session_id)::int AS sessions,count(*) FILTER(WHERE kind='attempt')::int AS attempts,
    (array_agg(runtime ORDER BY revision DESC))[1] AS runtime FROM entities WHERE user_id=$1 GROUP BY installation_id,machine ORDER BY last_seen DESC`, [userId])).rows));
}
export async function errorBreakdown(userId: string, query: unknown) {
  const f = FilterSchema.parse(query), w = where(f,"e",2,false);
  return cached(userId,`errors:${JSON.stringify(f)}`,()=>tenant(userId, async db => {
    await db.query("SET LOCAL jit=off");
    const rows=(await db.query(`SELECT ${columns} FROM entities e WHERE e.user_id=$1 ${w.sql} AND
      (e.kind='error' OR (e.kind='attempt' AND e.data->>'status' IN ('failed','cancelled')) OR
       (e.kind='message' AND e.data->>'errorType' IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM entities er WHERE er.user_id=$1 AND er.installation_id=e.installation_id AND er.kind='error' AND er.entity_id='message:'||e.entity_id)))`,[userId,...w.values])).rows;
    const lookup=await lookups(db,userId),normalized=records(rows,lookup);
    const matching=rows.filter((row,i)=>identityMatches(normalized[i]!,f));
    const attempts=matching.filter(row=>row.kind==="attempt");
    const selected=matching.filter(row=>{
      if(row.kind==="attempt"||!row.entity_id.startsWith("message:"))return true;
      const d=row.data,parent=d.parentMessageId??row.message_id,start=Number(d.startedAt??row.observed_at),end=number(d.endedAt);
      if(end===null)return true;
      const candidates=attempts.filter(a=>a.installation_id===row.installation_id&&a.session_id===row.session_id&&a.message_id===parent&&a.data.provider===d.provider&&a.data.model===d.model&&a.data.errorType===d.errorType&&a.data.httpStatus===d.httpStatus&&Number(a.observed_at)>=start&&Number(a.observed_at)<=end);
      return candidates.length!==1;
    });
    const groups=new Map<string,any>(),sessions=new Set<string>();let failed=0,cancelled=0,retryable=0,transport=0;
    for(const row of selected){
      const d=row.data,source=row.kind==="attempt"?"transport":row.historical?"historical":"lifecycle";
      const value={error_type:d.errorType??"unknown",error_code:d.errorCode??"unknown",provider:d.provider??"Unknown",model:d.model??"Unknown",http_status:d.httpStatus??null,source};
      const key=JSON.stringify(value);if(!groups.has(key))groups.set(key,{...value,occurrences:0,retryable:0,first_seen:Number(row.observed_at),last_seen:Number(row.observed_at),sessionIds:new Set<string>()});
      const g=groups.get(key);g.occurrences++;if(d.retryable===true){g.retryable++;retryable++;}g.first_seen=Math.min(g.first_seen,Number(row.observed_at));g.last_seen=Math.max(g.last_seen,Number(row.observed_at));
      if(row.session_id){const id=`${row.installation_id}:${row.session_id}`;sessions.add(id);g.sessionIds.add(id);}
      if(d.errorType==="cancelled"||d.status==="cancelled")cancelled++;else failed++;
      if(source==="transport")transport++;
    }
    const values=[...groups.values()].map(({sessionIds,...g})=>({...g,sessions:sessionIds.size}));
    const valid=["error_type","error_code","provider","model","http_status","occurrences","sessions","retryable","last_seen"];
    const key=valid.includes(f.sortBy)?f.sortBy:"occurrences";
    sortRows(values,f,row=>row[key]);
    return {items:values.slice(f.offset,f.offset+f.limit),total:values.length,summary:{occurrences:selected.length,failed,cancelled,retryable,sessions:sessions.size,transport,historical:selected.filter(r=>r.historical).length},timeframe:{from:f.from??null,to:f.to??null,timezone:"UTC",endExclusive:true}};
  }));
}
