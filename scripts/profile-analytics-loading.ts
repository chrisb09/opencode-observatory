import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session } from "node:inspector";
import { basename } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import pg from "pg";
import { pool } from "../apps/server/src/db.js";
import { analyticsLegacy as analytics, type AnalyticsProfile } from "../apps/server/src/analytics.js";
import { invalidateAnalytics } from "../apps/server/src/cache.js";

// Read-only diagnostic of the retained raw/legacy implementation. SQL parameters and telemetry payloads stay
// in memory and are never printed or saved. No production cache is invalidated.
const rounds = Number(process.argv.find(arg=>arg.startsWith("--rounds="))?.split("=")[1] ?? 3);
if (!Number.isInteger(rounds) || rounds<1 || rounds>10) throw new Error("Invalid --rounds");
const only = process.argv.find(arg=>arg.startsWith("--only="))?.slice(7);
type QueryTrace = { name:string; sql:string; values:any[]; ms:number; cpuMs:number; wireBytes:number; rows:number; jsonParseMs:number; jsonFields:number };
type Context = { queries:QueryTrace[]; components:AnalyticsProfile[] };
const contexts = new AsyncLocalStorage<Context>();
const garbage: Array<{start:number;ms:number;kind:number}> = [];
const gcObserver = new PerformanceObserver(list=>{
  for(const entry of list.getEntries()) garbage.push({start:entry.startTime,ms:entry.duration,kind:(entry as any).detail.kind});
});
gcObserver.observe({entryTypes:["gc"]});
const cpuMs = (cpu:NodeJS.CpuUsage) => (cpu.user+cpu.system)/1000;
const rounded = (value:number) => +value.toFixed(2);
const median = (values:number[]) => {const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return rounded(sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2);};
function queryName(sql:string) {
  if(sql.includes("UNION ALL SELECT"))return "canonical usage";
  if(sql.startsWith("SELECT s.data,s.entity_id"))return "attempt-step correlation";
  if(sql.includes("SELECT e.kind,e.entity_id")&&sql.includes("e.kind='attempt'"))return "attempt facts";
  return "transaction/lookups";
}
function parserTypes(mode:"parsed"|"text",timings:{ms:number;fields:number}) {
  return {getTypeParser(oid:number,format?:string) {
    if((oid===114||oid===3802)&&format!=="binary") {
      if(mode==="text")return (text:string)=>text;
      return function parseJSON(text:string) {
        const start=performance.now(),value=JSON.parse(text);
        timings.ms+=performance.now()-start;timings.fields++;return value;
      };
    }
    return (pg.types.getTypeParser as any)(oid,format);
  }};
}
function socketBytes(client:any) { return client.connection.stream.bytesRead as number; }
pool.on("connect",client=>{
  const query=client.query.bind(client) as any;
  (client as any).query=async(...args:any[])=>{
    const context=contexts.getStore();
    if(!context||typeof args[0]!=="string")return query(...args);
    const sql=args[0],name=queryName(sql),json={ms:0,fields:0};
    const cpu=process.cpuUsage(),bytes=socketBytes(client),start=performance.now();
    const result=await query({text:sql,values:args[1],types:parserTypes("parsed",json)});
    context.queries.push({name,sql,values:args[1]??[],ms:performance.now()-start,cpuMs:cpuMs(process.cpuUsage(cpu)),wireBytes:socketBytes(client)-bytes,rows:result.rows?.length??0,jsonParseMs:json.ms,jsonFields:json.fields});
    return result;
  };
});
const observe=(measurement:AnalyticsProfile)=>{contexts.getStore()?.components.push(measurement);};
function gcWithin(start:number,end:number) {
  const events=garbage.filter(event=>event.start<end&&event.start+event.ms>start);
  return {events:events.length,ms:rounded(events.reduce((sum,event)=>sum+Math.max(0,Math.min(end,event.start+event.ms)-Math.max(start,event.start)),0))};
}
async function fullCall(userId:string,filters:any) {
  invalidateAnalytics(userId);
  const context:Context={queries:[],components:[]},heap=process.memoryUsage().heapUsed,cpu=process.cpuUsage(),start=performance.now();
  const result=await contexts.run(context,()=>analytics(userId,filters,observe));
  const end=performance.now(),used=cpuMs(process.cpuUsage(cpu)),heapDelta=process.memoryUsage().heapUsed-heap;
  // GC entries are delivered after synchronous work yields to the event loop.
  await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));
  return {context,ms:end-start,cpuMs:used,heapDelta,gc:gcWithin(start,end),calls:result.summary.calls,components:context.components.map(component=>({...component,gc:gcWithin(component.startedAt,component.startedAt+component.ms)}))};
}
async function probes(userId:string,captured:QueryTrace) {
  const client=await pool.connect();
  const runs:Array<{mode:string;ms:number;cpuMs?:number;wireBytes?:number;jsonParseMs?:number;offlineParseMs?:number;offlineParseCpuMs?:number;rows:number;serializationMs?:number;outputKiB?:number;serverBeforeOutputMs?:number}> = [];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('observatory.user_id',$1,true)",[userId]);
    await client.query("SET LOCAL jit=off");
    await client.query("SET LOCAL statement_timeout='60s'");
    for(let i=0;i<rounds;i++) {
      // Rotate execution order to reduce consistently favoring the last mode's buffers.
      const modes=["server","serialize","parsed","text"];
      for(const mode of [...modes.slice(i%4),...modes.slice(0,i%4)]) {
        if(mode==="server"||mode==="serialize") {
          // TIMING OFF also suppresses Serialization.Time on PostgreSQL 17.
          const result=await client.query(`EXPLAIN (ANALYZE,BUFFERS,TIMING ${mode==="serialize"?"ON":"OFF"},SERIALIZE ${mode==="server"?"NONE":"TEXT"},FORMAT JSON) ${captured.sql}`,captured.values);
          const plan=result.rows[0]["QUERY PLAN"][0];
          runs.push({mode,ms:plan["Execution Time"],rows:plan.Plan["Actual Rows"],serializationMs:plan.Serialization?.Time,outputKiB:plan.Serialization?.["Output Volume"],serverBeforeOutputMs:plan.Serialization?.Time===undefined?undefined:plan["Execution Time"]-plan.Serialization.Time});
        } else {
          const json={ms:0,fields:0},bytes=socketBytes(client),cpu=process.cpuUsage(),start=performance.now();
          const result=await client.query({text:captured.sql,values:captured.values,types:parserTypes(mode as "parsed"|"text",json)} as any);
          const elapsed=performance.now()-start,used=cpuMs(process.cpuUsage(cpu)),wireBytes=socketBytes(client)-bytes;
          let offlineParseMs:number|undefined,offlineParseCpuMs:number|undefined;
          if(mode==="text") {
            const fields=result.fields.filter(field=>field.dataTypeID===114||field.dataTypeID===3802),parseCpu=process.cpuUsage(),parseStart=performance.now();
            for(const row of result.rows)for(const field of fields)if(row[field.name]!==null)row[field.name]=JSON.parse(row[field.name]);
            offlineParseMs=performance.now()-parseStart;offlineParseCpuMs=cpuMs(process.cpuUsage(parseCpu));
          }
          runs.push({mode,ms:elapsed,cpuMs:used,wireBytes,jsonParseMs:json.ms,offlineParseMs,offlineParseCpuMs,rows:result.rows.length});
        }
      }
    }
    assert(runs.every(run=>run.rows===runs[0]!.rows),"Result counts changed within read-only snapshot");
    return [...new Set(runs.map(run=>run.mode))].map(mode=>{
      const selected=runs.filter(run=>run.mode===mode);
      const field=(key:keyof typeof selected[number])=>{const values=selected.map(run=>run[key]).filter((value):value is number=>typeof value==="number");return values.length?median(values):undefined;};
      return {mode,rows:selected[0]!.rows,medianMs:field("ms"),cpuMedianMs:field("cpuMs"),wireBytes:field("wireBytes"),jsonParseMedianMs:field("jsonParseMs"),offlineParseMedianMs:field("offlineParseMs"),offlineParseCpuMedianMs:field("offlineParseCpuMs"),serializationMedianMs:field("serializationMs"),serverBeforeOutputMedianMs:field("serverBeforeOutputMs"),outputKiB:field("outputKiB")};
    });
  } finally {await client.query("ROLLBACK");client.release();}
}
async function sampledCPU(userId:string,filters:any) {
  const session=new Session();session.connect();
  const post=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>session.post(method as any,params,(error,result)=>error?reject(error):resolve(result)));
  try {
    await post("Profiler.enable");await post("Profiler.setSamplingInterval",{interval:1000});await post("Profiler.start");
    const call=await fullCall(userId,filters),{profile}=await post("Profiler.stop");
    const nodes=new Map<number,any>(profile.nodes.map((node:any)=>[node.id,node])),totals=new Map<string,number>();
    for(let i=0;i<profile.samples.length;i++) {
      const frame=nodes.get(profile.samples[i]).callFrame;
      const key=`${frame.functionName||"(anonymous)"} @ ${frame.url?basename(frame.url):"V8"}:${frame.lineNumber+1}`;
      totals.set(key,(totals.get(key)??0)+profile.timeDeltas[i]/1000);
    }
    return {wallMs:rounded(call.ms),processCpuMs:rounded(call.cpuMs),gc:call.gc,topSampledFrames:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([frame,ms])=>({frame,sampledMs:rounded(ms)}))};
  } finally {session.disconnect();}
}
try {
  const {rows}=await pool.query("SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1");
  if(!rows[0])throw new Error("No benchmark tenant");
  const userId=rows[0].id,to=Date.now(),workloads=[7,30,0].map(days=>({name:days?`${days}d`:"all",filters:{...(days?{from:to-days*86400000}:{}),to}}));
  if(only&&!workloads.some(workload=>workload.name===only))throw new Error("--only must be 7d, 30d, or all");
  console.log(JSON.stringify({type:"method",rounds,to,timing:"app-cache misses; warm database buffers; process CPU excludes PostgreSQL; GC and nested spans overlap, not additive",probes:"separate read-only snapshots; EXPLAIN with/without text serialization, parsed driver, JSON-as-text driver + offline JSON.parse"}));
  for(const workload of workloads.filter(workload=>!only||workload.name===only)) {
    await analytics(userId,workload.filters);
    const samples:Awaited<ReturnType<typeof fullCall>>[]=[];
    for(let i=0;i<rounds;i++)samples.push(await fullCall(userId,workload.filters));
    const last=samples[samples.length-1]!,names=[...new Set(last.components.map(component=>component.component))];
    console.log(JSON.stringify({type:"full",operation:workload.name,calls:last.calls,wallMedianMs:median(samples.map(sample=>sample.ms)),cpuMedianMs:median(samples.map(sample=>sample.cpuMs)),gcMedianMs:median(samples.map(sample=>sample.gc.ms)),gcEvents:samples.map(sample=>sample.gc.events),heapDeltaMedianMiB:rounded(median(samples.map(sample=>sample.heapDelta))/1048576),components:names.map(name=>{
      const selected=samples.flatMap(sample=>sample.components.filter(component=>component.component===name));
      return {component:name,wallMedianMs:median(selected.map(component=>component.ms)),cpuMedianMs:median(selected.map(component=>component.cpuMs)),gcMedianMs:median(selected.map(component=>component.gc.ms)),heapDeltaMedianMiB:rounded(median(selected.map(component=>component.heapDeltaBytes))/1048576),inputRecords:selected[0]!.inputRecords,outputRecords:selected[0]!.outputRecords};
    }),queries:[...new Set(last.context.queries.map(query=>query.name))].map(name=>{
      const grouped=samples.map(sample=>sample.context.queries.filter(query=>query.name===name));
      return {name,wallMedianMs:median(grouped.map(group=>group.reduce((sum,q)=>sum+q.ms,0))),cpuMedianMs:median(grouped.map(group=>group.reduce((sum,q)=>sum+q.cpuMs,0))),jsonParseMedianMs:median(grouped.map(group=>group.reduce((sum,q)=>sum+q.jsonParseMs,0))),wireBytes:last.context.queries.filter(query=>query.name===name).reduce((sum,q)=>sum+q.wireBytes,0)};
    })}));
    for(const query of last.context.queries.filter(query=>query.name!=="transaction/lookups"))console.log(JSON.stringify({type:"probe",operation:workload.name,query:query.name,modes:await probes(userId,query)}));
    if(workload.name==="all")console.log(JSON.stringify({type:"cpu-profile",operation:workload.name,...await sampledCPU(userId,workload.filters)}));
  }
} finally {gcObserver.disconnect();await pool.end();}
