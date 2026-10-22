import { pool } from "../apps/server/src/db.js";
import { analytics, listEntities, dimensions, machines, errorBreakdown, type AnalyticsProfile } from "../apps/server/src/analytics.js";
import { invalidateAnalytics } from "../apps/server/src/cache.js";
import { AsyncLocalStorage } from "node:async_hooks";

// Read-only diagnostic. Cache invalidation affects only this diagnostic process.
// No credentials, user identities, filter values or telemetry payloads are printed.
const rounds = Number(process.argv.find(arg => arg.startsWith("--rounds="))?.split("=")[1] ?? 3);
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice("--only=".length);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("--rounds must be between 1 and 10");
type Trace = { name: string; ms: number; rows: number };
const traces = new AsyncLocalStorage<Trace[]>();
const profiles = new AsyncLocalStorage<AnalyticsProfile[]>();
const observe = (measurement: AnalyticsProfile) => { profiles.getStore()?.push(measurement); };
function queryName(sql: string) {
  if (sql.startsWith("SELECT s.data,s.entity_id")) return "attempt-step correlation";
  if (sql.includes("UNION ALL SELECT")) return "canonical usage facts";
  if (sql.includes("e.kind IN ('step','message','attempt')")) return "dimension facts";
  if (sql.includes("array_agg(runtime")) return "machine inventory";
  if (sql.includes("e.kind='error'")) return "error facts";
  if (sql.includes("e.kind='attempt'")) return "attempt facts";
  if (sql.includes("FROM entities")) return "entity listing/count";
  return "transaction/lookups";
}
pool.on("connect", client => {
  const query = client.query.bind(client) as any;
  (client as any).query = async (...args: any[]) => {
    const trace = traces.getStore(), start = performance.now();
    try {
      const result = await query(...args);
      trace?.push({ name: queryName(String(args[0])), ms: performance.now() - start, rows: result.rows?.length ?? 0 });
      return result;
    } catch (error) {
      trace?.push({ name: queryName(String(args[0])), ms: performance.now() - start, rows: 0 });
      throw error;
    }
  };
});
async function measure(run: () => Promise<any>) {
  const queries: Trace[] = [], components: AnalyticsProfile[] = [], start = performance.now();
  const value = await traces.run(queries, () => profiles.run(components, run)), elapsed = performance.now() - start;
  const serialize = performance.now(), bytes = Buffer.byteLength(JSON.stringify(value));
  return { value, elapsed, jsonMs: performance.now() - serialize, bytes, queries, components };
}
function resultCounts(value: any) {
  if (Array.isArray(value)) return { returnedItems: value.length };
  if (value.modelGroups) return {
    totals: 1, matchingCalls: value.summary.calls,
    breakdownRows: Object.fromEntries(["model", "provider", "account", "credential", "machine", "agent"].map(type => [type, value[`${type}Groups`].length])),
    totalTimePoints: value.series.length, modelSeries: value.modelSeries.length,
    modelTimePoints: value.modelSeries.reduce((sum: number, item: any) => sum + item.series.length, 0),
    selectedBreakdownRows: value.groups.length,
    selectedTimePoints: value.groupSeries.reduce((sum: number, item: any) => sum + item.series.length, 0),
    outputBuckets: value.outputDistribution.length, contextBuckets: value.contextDistribution.length,
  };
  return { returnedItems: value.items?.length ?? 0, totalMatching: value.total, summaryObjects: value.summary ? 1 : 0 };
}
const median = (values: number[]) => { const sorted = [...values].sort((a,b)=>a-b); const mid = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[mid]! : (sorted[mid-1]!+sorted[mid]!)/2; };
const rounded = (n: number) => +n.toFixed(1);
try {
  const { rows } = await pool.query("SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1");
  if (!rows[0]) throw new Error("No user available to benchmark");
  const userId = rows[0].id, to = Date.now();
  const week = { from: to - 7 * 86400000, to };
  // Choose existing filters without exposing their values in diagnostic output.
  const discovery = await analytics(userId, week);
  const modelId = discovery.modelGroups[0]?.id, slash = modelId?.indexOf("/") ?? -1;
  const model = slash >= 0 ? modelId!.slice(slash + 1) : undefined;
  const machine = discovery.machineGroups[0]?.id;
  const account = discovery.accountGroups.find(group => group.attribution !== "unassigned")?.id;
  const workloads: Array<{ name: string; run: () => Promise<any>; shifted?: () => Promise<any> }> = [
    ...[1,7,30,90,0].map(days => {
      const f = { ...(days ? { from: to - days * 86400000 } : {}), to };
      return { name: `analytics ${days ? `${days}d` : "all"}`, run: () => analytics(userId,f,observe), ...(days === 7 ? { shifted: () => analytics(userId,{from:week.from+1,to:to+1},observe) } : {}) };
    }),
    ...(model ? [{name:"analytics 7d model filter",run:()=>analytics(userId,{...week,model},observe)}] : []),
    ...(machine ? [{name:"analytics 7d machine filter",run:()=>analytics(userId,{...week,machine},observe)}] : []),
    ...(account ? [{name:"analytics 7d account filter",run:()=>analytics(userId,{...week,account},observe)}] : []),
    {name:"analytics 7d provider grouping",run:()=>analytics(userId,{...week,groupBy:"provider"},observe)},
    {name:"dimensions",run:()=>dimensions(userId)},
    {name:"machine inventory",run:()=>machines(userId)},
    ...["session","attempt","tool","attachment"].map(kind=>({name:`${kind} listing 7d`,run:()=>listEntities(userId,kind,{...week,limit:50,sortBy:"observed_at",sortDir:"desc"})})),
    {name:"errors 7d",run:()=>errorBreakdown(userId,week)},
  ];
  console.log(JSON.stringify({type:"method",rounds,cache:"process-local cache explicitly cleared before each cold sample; PostgreSQL buffers are not flushed",timing:"server functions; excludes HTTP/browser; query time includes driver decoding and row transfer"}));
  if (only && !workloads.some(workload => workload.name === only)) throw new Error("Unknown --only operation");
  for (const workload of workloads.filter(workload => !only || workload.name === only)) {
    try {
      const cold: Awaited<ReturnType<typeof measure>>[] = [], warm: Awaited<ReturnType<typeof measure>>[] = [];
      for (let i=0;i<rounds;i++) {
        invalidateAnalytics(userId);
        cold.push(await measure(workload.run));
        warm.push(await measure(workload.run));
      }
      const sample = cold[cold.length-1]!, dbMs = cold.map(s=>s.queries.reduce((sum,q)=>sum+q.ms,0));
      const queryGroups = new Map<string,{ms:number;rows:number;queries:number}>();
      for(const q of sample.queries){const group=queryGroups.get(q.name)??{ms:0,rows:0,queries:0};group.ms+=q.ms;group.rows+=q.rows;group.queries++;queryGroups.set(q.name,group);}
      const components = sample.components.map(component => ({component:component.component,medianMs:rounded(median(cold.map(s=>s.components.filter(c=>c.component===component.component).reduce((sum,c)=>sum+c.ms,0)))),inputRecords:component.inputRecords,outputRecords:component.outputRecords}));
      console.log(JSON.stringify({operation:workload.name,coldMedianMs:rounded(median(cold.map(s=>s.elapsed))),coldMinMs:rounded(Math.min(...cold.map(s=>s.elapsed))),coldMaxMs:rounded(Math.max(...cold.map(s=>s.elapsed))),queryMedianMs:rounded(median(dbMs)),warmMedianMs:rounded(median(warm.map(s=>s.elapsed))),warmQueries:warm.map(s=>s.queries.length),jsonMedianMs:rounded(median(cold.map(s=>s.jsonMs))),responseBytes:sample.bytes,results:resultCounts(sample.value),components,queries:[...queryGroups].map(([name,q])=>({name,ms:rounded(q.ms),rows:q.rows,queries:q.queries}))}));
      if(workload.shifted){const shifted=await measure(workload.shifted);console.log(JSON.stringify({operation:"analytics 7d shifted by 1ms",ms:rounded(shifted.elapsed),queries:shifted.queries.length}));}
    } catch(error) {
      console.log(JSON.stringify({operation:workload.name,error:error instanceof Error ? error.message : "Unknown error"}));
      process.exitCode=1;
    }
  }
} finally { await pool.end(); }
