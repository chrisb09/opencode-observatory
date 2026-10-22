import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, tenant } from "../apps/server/src/db.js";
import { analytics, analyticsLegacy } from "../apps/server/src/analytics.js";
import { ingest } from "../apps/server/src/ingest.js";
import { lockUsage, refreshUsage } from "../apps/server/src/rollups.js";
import { invalidateAnalytics } from "../apps/server/src/cache.js";
import { assertAnalyticsEquivalent } from "./analytics-parity.js";
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
try {
  const name=(await pool.query("SELECT current_database() AS name")).rows[0].name;
  assert(name.startsWith("observatory_rollup_benchmark_"),"Requires a disposable rollup benchmark database");
  const userId=(await pool.query("SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1")).rows[0].id;
  const to=Date.now();
  for(const days of [1,7,30,90,0]) {
    const query={...(days?{from:to-days*86400000}:{}),to};
    const results:any[]=[],newMs:number[]=[],oldMs:number[]=[];
    for(let i=0;i<3;i++) {
      // Alternate order so one implementation does not always get warmer buffers.
      for(const implementation of i%2?["legacy","rollup"]:["rollup","legacy"]) {
        invalidateAnalytics(userId);const start=performance.now();
        try {
          const result=await (implementation==="rollup"?analytics:analyticsLegacy)(userId,query);
          (implementation==="rollup"?newMs:oldMs).push(performance.now()-start);
          results[implementation==="rollup"?0:1]=result;
        }catch(error){console.log(JSON.stringify({range:days?`${days}d`:"all",implementation,error:error instanceof Error?error.message:"Unknown error"}));}
      }
      if(results[0]&&results[1])assertAnalyticsEquivalent(results[0],results[1]);
    }
    assert.equal(newMs.length,3,"Rollup analytics must complete every measured sample");
    console.log(JSON.stringify({range:days?`${days}d`:"all",calls:results[0]?.summary.calls,rollupMedianMs:Math.round(median(newMs)),legacyMedianMs:oldMs.length?Math.round(median(oldMs)):null,parity:results[0]&&results[1]?"passed":"legacy unavailable"}));
  }
  const source=await tenant(userId,async db=>(await db.query("SELECT * FROM entities WHERE user_id=$1 AND kind='step' LIMIT 1",[userId])).rows[0]);
  for(const size of [1,25,100]) {
    const elapsed:number[]=[];
    for(let i=0;i<3;i++) {
      const installationId=randomUUID();
      const events=Array.from({length:size},()=>({schemaVersion:1,eventId:randomUUID(),installationId,instanceId:randomUUID(),machine:"rollup-benchmark",projectId:source.project_id,sessionId:`ses_${randomUUID()}`,messageId:`msg_${randomUUID()}`,kind:"step",entityId:`part_${randomUUID()}`,observedAt:to,revision:to,historical:false,runtime:source.runtime,data:source.data}));
      const start=performance.now();await ingest(userId,{events});elapsed.push(performance.now()-start);
      await tenant(userId,async db=>{
        await lockUsage(db,userId);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM usage_facts WHERE user_id=$1 AND installation_id=$2",[userId,installationId])).rows[0].n,size);
        await db.query("DELETE FROM entities WHERE user_id=$1 AND installation_id=$2",[userId,installationId]);
        await db.query("DELETE FROM events WHERE user_id=$1 AND installation_id=$2",[userId,installationId]);
        await refreshUsage(db,userId);
      });
    }
    console.log(JSON.stringify({ingestEvents:size,medianMs:Math.round(median(elapsed)),samples:elapsed.map(Math.round)}));
  }
}finally{await pool.end();}
