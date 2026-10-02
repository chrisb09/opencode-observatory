import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {Database} from "bun:sqlite";
import {randomUUID} from "node:crypto";
import {EventSchema} from "@observatory/contracts";
const dir=await mkdtemp("/tmp/opencode/live-smoke-");const uploads:any[]=[];let providerRequests=0;
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==="/api/ingest"){const body=await request.json() as any;uploads.push(...body.events);return Response.json({acknowledged:body.events.map((e:any)=>e.eventId)});}
  if(url.pathname==="/v1/chat/completions"){
    providerRequests++;
    const chunks=[{id:"chatcmpl-fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{role:"assistant",content:"Fixture complete."},finish_reason:null}]},{id:"chatcmpl-fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:17,completion_tokens:4,total_tokens:21,prompt_tokens_details:{cached_tokens:5}}}];
    return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
  }
  return Response.json({error:"Not found"},{status:404});
}});
try{
  const xdgConfig=join(dir,"config"),xdgData=join(dir,"data"),xdgCache=join(dir,"cache");await mkdir(join(xdgConfig,"opencode-observatory"),{recursive:true});
  await writeFile(join(xdgConfig,"opencode-observatory","config.json"),JSON.stringify({url:server.url.origin,apiKey:"obs_fixture_only",fingerprintSecret:"fixture-only-fingerprint-secret",userId:randomUUID(),installationId:randomUUID(),machine:"smoke@isolated",autoImport:false,enableTools:false,accounts:{fixture:"smoke account"}}),{mode:0o600});
  const content={$schema:"https://opencode.ai/config.json",autoupdate:false,model:"fixture/fixture",small_model:"fixture/fixture",enabled_providers:["fixture"],plugin:[`file://${resolve("packages/plugin/dist/index.js")}`],provider:{fixture:{name:"Fixture",npm:"@ai-sdk/openai-compatible",options:{baseURL:`${server.url.origin}/v1`,apiKey:"fixture-provider-key"},models:{fixture:{name:"Fixture",limit:{context:128000,output:256},cost:{input:1,output:2,cache_read:.1,cache_write:1}}}}}};
  const child=Bun.spawn(["opencode","run","--model","fixture/fixture","--format","json","Say fixture complete, without calling tools."],{cwd:dir,env:{...process.env,XDG_CONFIG_HOME:xdgConfig,XDG_DATA_HOME:xdgData,XDG_CACHE_HOME:xdgCache,OPENCODE_CONFIG_CONTENT:JSON.stringify(content),OPENCODE_DISABLE_DEFAULT_PLUGINS:"1",OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_EXTERNAL_SKILLS:"1",OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:"1"},stdout:"pipe",stderr:"pipe"});
  const timeout=setTimeout(()=>child.kill(),90000);
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timeout);
  if(exit!==0)throw new Error(`Isolated OpenCode failed (${exit}): ${stderr.slice(-3000)} ${stdout.slice(-1000)}`);
  const db=new Database(join(xdgData,"opencode-observatory","outbox.db"),{readonly:true});
  const records=(db.query("SELECT payload FROM outbox").all() as any[]).map(r=>JSON.parse(r.payload));db.close();
  for(const record of records)EventSchema.parse(record);
  if(!records.some(r=>r.kind==="step"))throw new Error("OpenCode produced no lifecycle step telemetry");
  if(!records.some(r=>r.kind==="attempt"&&r.data.status==="completed"))throw new Error("OpenCode produced no completed transport telemetry");
  if(!records.some(r=>r.kind==="attempt"&&r.data.status==="completed"&&r.data.totalTokens===21&&r.data.firstOutputMs!=null))throw new Error("OpenCode transport did not parse provider token usage and first output timing");
  if(!records[0].runtime.opencode)throw new Error("OpenCode version inventory is missing");
  if(!records.some(r=>r.runtime.plugins.some((p:any)=>p.name==="opencode-observatory-plugin"&&p.version==="0.1.0")))throw new Error(`Plugin version inventory is missing: ${JSON.stringify(records[0].runtime.plugins)}`);
  if(JSON.stringify(records).includes("Fixture complete.")||JSON.stringify(records).includes("fixture-provider-key"))throw new Error("Content or credentials leaked into metadata");
  console.log(JSON.stringify({opencodeVersion:records[0].runtime.opencode,versionSource:records[0].runtime.opencodeSource,providerRequests,recordedSteps:records.filter(r=>r.kind==="step").length,recordedAttempts:records.filter(r=>r.kind==="attempt").length,acknowledgedUploads:uploads.length,metadataRecords:records.length},null,2));
}finally{server.stop(true);await rm(dir,{recursive:true,force:true});}
