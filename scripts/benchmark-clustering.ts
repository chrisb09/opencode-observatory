import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { pool, tenant } from "../apps/server/src/db.js";
import { analyticsLegacy as analytics } from "../apps/server/src/analytics.js";
import { invalidateAnalytics } from "../apps/server/src/cache.js";

// Mutates ONLY a deliberately named disposable database copy. Never use on production.
const rounds = Number(process.argv.find(arg => arg.startsWith("--rounds="))?.split("=")[1] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Invalid --rounds");
type Capture = { sql?: string; values?: unknown[] };
const capture = new AsyncLocalStorage<Capture>();
pool.on("connect", client => {
  const query = client.query.bind(client) as any;
  (client as any).query = (...args: any[]) => {
    const target = capture.getStore();
    if (target && typeof args[0] === "string" && args[0].includes("UNION ALL SELECT")) {
      target.sql = args[0]; target.values = args[1];
    }
    return query(...args);
  };
});
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length/2);
  return +(sorted.length%2 ? sorted[mid]! : (sorted[mid-1]!+sorted[mid]!)/2).toFixed(2);
};
function equivalent(actual: any, expected: any, path = "result") {
  if (typeof actual === "number" && typeof expected === "number") {
    assert(Math.abs(actual-expected) <= Math.max(1e-8, Math.abs(expected)*1e-12), `Numeric mismatch: ${path}`);
  } else if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `Keys differ: ${path}`);
    for (const key of Object.keys(expected)) equivalent(actual[key],expected[key],`${path}.${key}`);
  } else assert.equal(actual,expected,`Value differs: ${path}`);
}
function scans(node: any): any[] {
  return [
    ...(/Scan/.test(node["Node Type"]) ? [{type:node["Node Type"],relation:node["Relation Name"],index:node["Index Name"],rows:node["Actual Rows"],loops:node["Actual Loops"]}] : []),
    ...(node.Plans ?? []).flatMap(scans),
  ];
}
async function layout() {
  // pg_stats hides column statistics from this role while forced RLS is active.
  const clustered = await pool.query("SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid='public.entities'::regclass AND x.indisclustered");
  const size = await pool.query("SELECT pg_table_size('entities')::bigint AS table_bytes,pg_indexes_size('entities')::bigint AS index_bytes");
  return {clusteredIndex:clustered.rows[0]?.relname ?? null,size:size.rows[0]};
}
try {
  const {rows:database} = await pool.query("SELECT current_database() AS name");
  if (!/^observatory_cluster_benchmark_/.test(database[0].name)) throw new Error("Requires a disposable observatory_cluster_benchmark_* database");
  assert.equal((await layout()).clusteredIndex,null,"Requires a fresh, unclustered copy for the baseline");
  const {rows:users} = await pool.query("SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1");
  if (!users[0]) throw new Error("No benchmark tenant");
  const userId = users[0].id, to = Date.now(), week = {from:to-7*86400000,to};
  await pool.query("ANALYZE");
  const discovery = await analytics(userId,week), modelId = discovery.modelGroups[0]?.id;
  const slash = modelId?.indexOf("/") ?? -1, model = slash >= 0 ? modelId!.slice(slash+1) : undefined;
  const machine = discovery.machineGroups[0]?.id;
  const workloads = [
    ...[1,7,30,90,0].map(days=>({name:`analytics ${days ? `${days}d` : "all"}`,filters:{...(days?{from:to-days*86400000}:{}),to}})),
    ...(model?[{name:"analytics 7d model filter",filters:{...week,model}}]:[]),
    ...(machine?[{name:"analytics 7d machine filter",filters:{...week,machine}}]:[]),
  ];
  const baseline = new Map<string,any>(), baselineRows = new Map<string,number>();
  console.log(JSON.stringify({type:"method",rounds,to,applicationCache:"cleared before each full call",postgresBuffers:"not flushed; per-workload warmup; EXPLAIN probes run separately",database:"isolated copy; raw event payloads omitted; entities and lookup data retained"}));
  for (const phase of ["before","clustered"] as const) {
    if (phase === "clustered") {
      const start = performance.now();
      await pool.query("CLUSTER public.entities USING entities_time");
      const clusterMs = performance.now()-start;
      await pool.query("ANALYZE public.entities");
      console.log(JSON.stringify({type:"cluster",ms:+clusterMs.toFixed(1)}));
    }
    console.log(JSON.stringify({type:"layout",phase,...await layout()}));
    for (const workload of workloads) {
      const captured: Capture = {}, elapsed: number[] = [], repeat: number[] = [], errors: string[] = [];
      let value: any;
      const run = () => capture.run(captured,()=>analytics(userId,workload.filters));
      invalidateAnalytics(userId);
      try { await run(); } catch { /* Timed samples below record failures. */ }
      for(let i=0;i<rounds;i++) {
        invalidateAnalytics(userId);
        const start = performance.now();
        try {
          value = await run(); elapsed.push(performance.now()-start);
          const warm = performance.now(); await run(); repeat.push(performance.now()-warm);
        } catch(error) { errors.push(error instanceof Error ? error.message : "Unknown error"); }
      }
      if (value) {
        if (phase === "before") baseline.set(workload.name,value);
        else if (baseline.has(workload.name)) equivalent(value,baseline.get(workload.name));
      }
      assert(captured.sql,"Canonical query not captured");
      const plans: any[] = [];
      for(let i=0;i<rounds;i++) {
        const plan = await tenant(userId,async db=>{
          await db.query("SET LOCAL jit=off");
          // Diagnostic probes can finish even when the normal application's 5s cap is hit.
          await db.query("SET LOCAL statement_timeout='60s'");
          const result = await db.query(`EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) ${captured.sql}`,captured.values);
          return result.rows[0]["QUERY PLAN"][0];
        });
        plans.push(plan);
      }
      const last = plans[plans.length-1]!, rows = last.Plan["Actual Rows"];
      assert(plans.every(plan=>plan.Plan["Actual Rows"]===rows),"Unstable result count");
      if(phase === "before") baselineRows.set(workload.name,rows);
      else assert.equal(rows,baselineRows.get(workload.name),"Canonical SQL result count changed");
      console.log(JSON.stringify({phase,operation:workload.name,successfulSamples:elapsed.length,errors,fullMedianMs:median(elapsed),fullMinMs:elapsed.length?Math.min(...elapsed):null,fullMaxMs:elapsed.length?Math.max(...elapsed):null,repeatMedianMs:median(repeat),calls:value?.summary.calls,correctness:phase==="clustered"?(baseline.has(workload.name)?"full response equivalent; float tolerance":"SQL row count matched; baseline full call failed"):"baseline",sqlMedianMs:median(plans.map(plan=>plan["Execution Time"])),sharedHitBlocksMedian:median(plans.map(plan=>plan.Plan["Shared Hit Blocks"]??0)),sharedReadBlocksMedian:median(plans.map(plan=>plan.Plan["Shared Read Blocks"]??0)),tempReadBlocksMedian:median(plans.map(plan=>plan.Plan["Temp Read Blocks"]??0)),tempWrittenBlocksMedian:median(plans.map(plan=>plan.Plan["Temp Written Blocks"]??0)),canonicalRows:rows,plan:last.Plan["Node Type"],scans:scans(last.Plan)}));
    }
  }
} finally { await pool.end(); }
