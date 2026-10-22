import { migrate, pool, tenant } from "../apps/server/src/db.js";
import { refreshUsage } from "../apps/server/src/rollups.js";
import { analytics, analyticsLegacy } from "../apps/server/src/analytics.js";
import { invalidateAnalytics } from "../apps/server/src/cache.js";
import { assertAnalyticsEquivalent } from "./analytics-parity.js";

// Explicit maintenance command. Rebuilds are atomic per tenant and share the ingest lock.
// No credentials, tenant identities, model names or raw telemetry are printed.
try {
  await migrate();
  const {rows}=await pool.query("SELECT id FROM users ORDER BY created_at,id");
  for(let i=0;i<rows.length;i++) {
    const userId=rows[i]!.id,start=performance.now();
    await tenant(userId,db=>refreshUsage(db,userId,process.argv.includes("--rebuild")));
    await pool.query("ANALYZE usage_facts; ANALYZE usage_hourly; ANALYZE usage_dirty");
    invalidateAnalytics(userId);
    const counts=await tenant(userId,async db=>(await db.query(`SELECT
      (SELECT count(*)::int FROM usage_facts WHERE user_id=$1) AS facts,
      (SELECT count(*)::int FROM usage_hourly WHERE user_id=$1) AS hourly_rows,
      (SELECT COALESCE(sum(metrics[1]),0)::bigint FROM usage_hourly WHERE user_id=$1) AS hourly_calls,
      (SELECT count(*)::int FROM usage_dirty WHERE user_id=$1) AS pending`,[userId])).rows[0]);
    if(counts.facts!==Number(counts.hourly_calls))throw new Error("Fact/hourly call count mismatch");
    console.log(JSON.stringify({tenant:i+1,reconcileMs:Math.round(performance.now()-start),...counts}));
    if(process.argv.includes("--verify")) {
      const to=Date.now();
      for(const days of [7,0]) {
        const query={...(days?{from:to-days*86400000}:{}),to};
        invalidateAnalytics(userId);
        let start=performance.now();const actual=await analytics(userId,query),rollupMs=performance.now()-start;
        invalidateAnalytics(userId);
        start=performance.now();const expected=await analyticsLegacy(userId,query),legacyMs=performance.now()-start;
        assertAnalyticsEquivalent(actual,expected);
        console.log(JSON.stringify({tenant:i+1,range:days?"7d":"all",parity:"passed",calls:actual.summary.calls,rollupMs:Math.round(rollupMs),legacyMs:Math.round(legacyMs)}));
      }
    }
  }
} finally {await pool.end();}
