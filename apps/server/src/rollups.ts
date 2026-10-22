import type { PoolClient } from "pg";
import type { Filters } from "@observatory/contracts";
import { usageSQL, lookups, records } from "./usage.js";
import { usageVector, type UsageBucket, type UsageDimensions } from "./metrics.js";

const hour=3600000;
export async function lockUsage(db:PoolClient,userId:string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('observatory:usage:'||$1,0))",[userId]);
}
// The source triggers track identities and their deduplication dependants. Refresh
// canonical facts in the same ingest transaction; fact triggers maintain buckets.
export async function refreshUsage(db:PoolClient,userId:string,force=false) {
  const status=async()=> (await db.query(`SELECT s.ready,(s.catalog_revision=v.revision AND s.format_version=1) AS current,v.revision AS catalog_version,
    EXISTS(SELECT 1 FROM usage_dirty WHERE user_id=$1) AS dirty
    FROM usage_catalog_version v LEFT JOIN usage_rollup_state s ON s.user_id=$1`,[userId])).rows[0];
  let state=await status();
  if(!force&&state.ready&&state.current&&!state.dirty)return;
  await db.query("SET LOCAL jit=off");
  await lockUsage(db,userId);
  await db.query("INSERT INTO usage_rollup_state(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
  await db.query("SELECT user_id FROM usage_rollup_state WHERE user_id=$1 FOR UPDATE",[userId]);
  state=await status();
  if(!force&&state.ready&&state.current&&!state.dirty)return;
  const full=force||!state.ready||!state.current;
  const keys=(await db.query("DELETE FROM usage_dirty WHERE user_id=$1 RETURNING installation_id,kind,entity_id",[userId])).rows;
  const keySQL=`EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) p(installation_id uuid,kind text,entity_id text)
    WHERE p.installation_id=e.installation_id AND p.kind=e.kind AND p.entity_id=e.entity_id)`;
  const params=full?[userId]:[userId,JSON.stringify(keys)];
  const source=(await db.query(usageSQL({sql:full?"":` AND ${keySQL}`}),params)).rows;
  const normalized=records(source,await lookups(db,userId));
  if(full) {
    // Transition tables are bounded too: one giant DELETE can make histogram
    // maintenance choose a very expensive plan during a historical rebuild.
    for(;;) {
      const removed=await db.query(`WITH targets AS (
        SELECT installation_id,kind,entity_id FROM usage_facts WHERE user_id=$1
        ORDER BY installation_id,kind,entity_id LIMIT 2000
      ) DELETE FROM usage_facts f USING targets t WHERE f.user_id=$1
        AND f.installation_id=t.installation_id AND f.kind=t.kind AND f.entity_id=t.entity_id`,[userId]);
      if(!removed.rowCount)break;
    }
  } else await db.query(`DELETE FROM usage_facts e WHERE e.user_id=$1 AND ${keySQL}`,params);
  // A rebuild also repairs pre-existing aggregate drift, rather than subtracting
  // and re-adding facts on top of an already incorrect hourly row.
  if(full)await db.query("DELETE FROM usage_hourly WHERE user_id=$1",[userId]);
  for(let start=0;start<source.length;start+=2000) {
    const batch=source.slice(start,start+2000).map((row,i)=>{
      const r=normalized[start+i]!,{installation,provider,model,model_id,machine,agent,status,historical,account_id,account_label,credential_id,credential_label,credential_kind,attribution}=r;
      const dimensions:UsageDimensions={installation,provider,model,model_id,machine,agent,status,historical,account_id,account_label,credential_id,credential_label,credential_kind,attribution,project:row.project_id??null};
      return {installation_id:row.installation_id,kind:row.kind,entity_id:row.entity_id,session_id:row.session_id,observed_at:r.time,dimensions,metrics:usageVector(r),duration:r.duration,output:r.output_tokens};
    });
    await db.query(`INSERT INTO usage_facts(user_id,installation_id,kind,entity_id,session_id,observed_at,dimensions,metrics,duration,output)
      SELECT $1,p.* FROM jsonb_to_recordset($2::jsonb) p(installation_id uuid,kind text,entity_id text,session_id text,observed_at bigint,dimensions jsonb,metrics numeric[],duration double precision,output double precision)
      ORDER BY installation_id,kind,entity_id`,[userId,JSON.stringify(batch)]);
  }
  await db.query(`INSERT INTO usage_rollup_state(user_id,ready,catalog_revision,format_version,updated_at)
    VALUES($1,true,$2,1,now())
    ON CONFLICT(user_id) DO UPDATE SET ready=true,catalog_revision=EXCLUDED.catalog_revision,format_version=1,updated_at=now()`,[userId,state.catalog_version]);
}

function dimensionFilter(f:Filters,values:unknown[]) {
  const conditions:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const field=(key:string)=>`dimensions->>'${key}'`;
  if(f.provider==="antigravity")conditions.push(`(${field("provider")}='antigravity' OR (${field("provider")}='google' AND ${field("model")} LIKE 'antigravity-%'))`);
  else if(f.provider){conditions.push(`${field("provider")}=${bind(f.provider)}`);if(f.provider==="google")conditions.push(`${field("model")} NOT LIKE 'antigravity-%'`);}
  for(const key of ["model","machine","status"] as const)if(f[key])conditions.push(`${field(key)}=${bind(f[key])}`);
  if(f.installationId)conditions.push(`${field("installation")}=${bind(f.installationId)}`);
  if(f.projectId)conditions.push(`${field("project")}=${bind(f.projectId)}`);
  for(const key of ["account","credential"] as const)if(f[key]){const p=bind(f[key]);conditions.push(`(${field(`${key}_id`)}=${p} OR ${field(`${key}_id`)}=${field("provider")}||'/'||${p})`);}
  return conditions.length?" AND "+conditions.join(" AND "):"";
}
export async function usageBuckets(db:PoolClient,userId:string,f:Filters):Promise<{buckets:UsageBucket[];earliest:number|null}> {
  // Keep complete buckets and boundary facts on the same canonical generation.
  await lockUsage(db,userId);
  await refreshUsage(db,userId);
  const values:unknown[]=[userId],scope=dimensionFilter(f,values);
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  let exact="";
  if(f.from!==undefined)exact+=` AND observed_at>=${bind(f.from)}`;
  if(f.to!==undefined)exact+=` AND observed_at<${bind(f.to)}`;
  if(f.sessionId)exact+=` AND session_id=${bind(f.sessionId)}`;
  const earliest=f.from===undefined?(await db.query(`SELECT min(observed_at) AS time FROM usage_facts WHERE user_id=$1${scope}${exact}`,values)).rows[0].time:null;
  const rows:any[]=[];
  if(f.sessionId) {
    rows.push(...(await db.query(`SELECT observed_at AS time,dimensions,metrics,duration,output FROM usage_facts WHERE user_id=$1${scope}${exact}`,values)).rows);
  } else {
    // Separate parameter lists keep optional boundary conditions correctly bound.
    const completeValues:unknown[]=[userId],completeScope=dimensionFilter(f,completeValues);
    let complete="";
    if(f.from!==undefined){completeValues.push(Math.ceil(f.from/hour)*hour);complete+=` AND hour>=$${completeValues.length}`;}
    if(f.to!==undefined){completeValues.push(Math.floor(f.to/hour)*hour);complete+=` AND hour<$${completeValues.length}`;}
    rows.push(...(await db.query(`SELECT hour AS time,dimensions,metrics,histogram FROM usage_hourly WHERE user_id=$1${completeScope}${complete} AND metrics[1]>0`,completeValues)).rows);
    const boundaries:string[]=[];
    if(f.from!==undefined&&f.from%hour!==0)boundaries.push(`observed_at<${bind(Math.ceil(f.from/hour)*hour)}`);
    if(f.to!==undefined&&f.to%hour!==0)boundaries.push(`observed_at>=${bind(Math.floor(f.to/hour)*hour)}`);
    if(boundaries.length)rows.push(...(await db.query(`SELECT observed_at AS time,dimensions,metrics,duration,output FROM usage_facts WHERE user_id=$1${scope}${exact} AND (${boundaries.join(" OR ")})`,values)).rows);
  }
  return {earliest:earliest===null?null:Number(earliest),buckets:rows.map(row=>{
    const histogram:Record<string,number>=row.histogram??{};
    if(!row.histogram){if(row.duration!==null)histogram[`d:${row.duration}`]=1;if(row.output!==null)histogram[`o:${row.output}`]=1;}
    return {time:Number(row.time),dimensions:row.dimensions,metrics:row.metrics.map(Number),histogram};
  })};
}
