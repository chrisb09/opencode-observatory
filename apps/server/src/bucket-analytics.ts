import { providerGroup, type Filters } from "@observatory/contracts";
import { Aggregate, chooseBucket, bucketTime, nextBucket, outputHistogram, type UsageBucket, type UsageDimensions } from "./metrics.js";

type GroupKind=Filters["groupBy"];
const kinds:GroupKind[]=["model","provider","account","credential","machine","agent"];
function identity(d:UsageDimensions,kind:GroupKind) {
  const provider=providerGroup(d.provider,d.model);
  const id={model:d.model_id,provider,account:d.account_id,credential:d.credential_id,machine:d.machine,agent:d.agent}[kind];
  const label=kind==="account"?`${d.provider} · ${d.account_label}`:kind==="credential"?`${d.provider} · ${d.credential_label}`:kind==="model"?`${provider}/${d.model}`:id;
  return {id,label,provider:["model","provider"].includes(kind)?provider:["account","credential"].includes(kind)?d.provider:null};
}
const empty={calls:0,input_tokens:0,output_tokens:0,reasoning_tokens:0,cache_read_tokens:0,cache_write_tokens:0,prompt_tokens:0,completion_tokens:0,total_tokens:0,cost:0,market_cost:0,cache_savings:0,cache_reuse_ratio:null,cache_hit_ratio:null,unknown_usage_calls:0,unknown_market_calls:0,unknown_cost_calls:0};

export function bucketAnalytics(buckets:UsageBucket[],from:number,to:number,groupBy:GroupKind) {
  const summary=new Aggregate(),bucket=chooseBucket(from,to),totals=new Map<number,Aggregate>();
  const groups=new Map(kinds.map(kind=>[kind,new Map<string,{aggregate:Aggregate;label:string;provider:string|null;attribution:string|null;credential_kind?:string}>()]));
  const models=new Map<string,{label:string;points:Map<number,Aggregate>}>(),selected=groupBy==="model"?models:new Map<string,{label:string;points:Map<number,Aggregate>}>();
  const chart=(map:typeof models,d:UsageDimensions,kind:GroupKind,time:number,row:UsageBucket)=>{
    const {id,label}=identity(d,kind);
    if(!map.has(id))map.set(id,{label,points:new Map()});
    const points=map.get(id)!.points;if(!points.has(time))points.set(time,new Aggregate());points.get(time)!.addBucket(row);
  };
  for(const row of buckets) {
    const d=row.dimensions,time=bucketTime(row.time,bucket);
    summary.addBucket(row,true);
    for(const kind of kinds) {
      const {id,label,provider}=identity(d,kind),map=groups.get(kind)!;
      if(!map.has(id))map.set(id,{aggregate:new Aggregate(),label,provider,attribution:kind==="account"?d.attribution:null,...(kind==="credential"?{credential_kind:d.credential_kind}:{})});
      map.get(id)!.aggregate.addBucket(row,true);
    }
    if(!totals.has(time))totals.set(time,new Aggregate());totals.get(time)!.addBucket(row);
    chart(models,d,"model",time,row);if(groupBy!=="model")chart(selected,d,groupBy,time,row);
  }
  const timeline:number[]=[];
  for(let t=bucketTime(from,bucket);t<to&&timeline.length<768;t=nextBucket(t,bucket))timeline.push(t);
  const finishSeries=(map:typeof models)=>[...map].sort(([a],[b])=>a.localeCompare(b)).map(([id,value])=>({id,label:value.label,series:timeline.map(time=>({time,...(value.points.get(time)?.finish()??empty)}))}));
  const finishGroups=(kind:GroupKind)=>[...groups.get(kind)!].map(([id,v])=>({id,label:v.label,provider:v.provider,attribution:v.attribution,credential_kind:v.credential_kind,...v.aggregate.finish(true)})).sort((a,b)=>b.calls-a.calls||a.id.localeCompare(b.id));
  const modelGroups=finishGroups("model"),providerGroups=finishGroups("provider"),accountGroups=finishGroups("account"),credentialGroups=finishGroups("credential"),machineGroups=finishGroups("machine"),agentGroups=finishGroups("agent");
  const modelSeries=finishSeries(models);
  return {summary:summary.finish(true),bucket,series:timeline.map(time=>({time,...(totals.get(time)?.finish()??empty)})),modelSeries,
    modelGroups,providerGroups,accountGroups,credentialGroups,machineGroups,agentGroups,
    outputDistribution:outputHistogram(summary.outputs),
    groups:{model:modelGroups,provider:providerGroups,account:accountGroups,credential:credentialGroups,machine:machineGroups,agent:agentGroups}[groupBy],
    groupBy,groupSeries:groupBy==="model"?modelSeries:finishSeries(selected),
    timeframe:{from,to,timezone:"UTC",endExclusive:true,bucket:bucket.unit}};
}
