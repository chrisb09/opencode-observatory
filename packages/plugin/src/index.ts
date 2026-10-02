import { type Plugin,type Hooks,tool } from "@opencode-ai/plugin";
import { loadConfig,api,configureObservatory } from "./config.js";
import { inventory,detectVersion,syncLocalAccounts } from "./runtime.js";
import { Collector,fingerprint } from "./metadata.js";
import { Outbox } from "./outbox.js";
import { importHistory } from "./history.js";
import { installTransport,registerContext,uninstallTransport } from "./transport.js";

const plugin:Plugin=async ctx=>{
  let config=await loadConfig();
  const log=async(message:string)=>{try{await ctx.client.app.log({body:{service:"observatory",level:"warn",message}});}catch{}};
  if(!config){await log("OpenCode Observatory is not configured. Use the observatory_setup tool or run opencode-observatory setup in terminal.");}
  const registry=installTransport();
  let outbox:Outbox|null=config?new Outbox(config,undefined,registry.original):null;
  let version:string|null=null,versionSource:"server-health"|"executable"|"unknown"="unknown";
  try{const result=await registry.original(new URL("/global/health",ctx.serverUrl),{signal:AbortSignal.timeout(2000)});if(result.ok){const health=await result.json() as {version?:string};version=health.version??null;if(version)versionSource="server-health";}}catch{}
  if(!version){version=detectVersion();versionSource=version?"executable":"unknown";}
  let runtime=await inventory([],ctx.directory,version);runtime.opencodeSource=versionSource;
  let collector:Collector|null=config?new Collector(config,runtime,event=>outbox?.enqueue(event),ctx.project.id):null;
  if(outbox)outbox.start();
  if(config)void syncLocalAccounts(config,registry.original);
  let importTask:Promise<unknown>|undefined;
  const safe=(fn:()=>void)=>{try{fn();}catch{void log("Metadata could not be written to the local outbox. Check disk space and permissions.");}};

  const startTelemetry=(newConfig:NonNullable<typeof config>)=>{
    config=newConfig;
    void syncLocalAccounts(config,registry.original);
    if(!outbox){
      outbox=new Outbox(config,undefined,registry.original);
      collector=new Collector(config,runtime,event=>outbox?.enqueue(event),ctx.project.id);
      outbox.start();
      if(config.autoImport&&!importTask){
        importTask=importHistory(collector,outbox).catch(()=>log("Historical import failed."));
      }
    }
  };

  const tools:NonNullable<Hooks["tool"]>={
    observatory_setup:tool({
      description:"Configure or connect OpenCode Observatory telemetry collector with the server URL and API key. If the user asks to connect or configure Observatory without an API key, ask them for their Observatory URL (defaults to http://localhost:7692) and telemetry API key from the Observatory Settings page.",
      args:{
        apiKey:tool.schema.string().describe("Observatory telemetry API key (starts with 'obs_') created in the Observatory Settings page"),
        url:tool.schema.string().optional().describe("Observatory server URL (e.g. http://localhost:7692 or your LAN address). Defaults to http://localhost:7692 if omitted"),
        autoImport:tool.schema.boolean().optional().describe("Whether to automatically import historical sessions (default: true)"),
      },
      async execute(args){
        try{
          const result=await configureObservatory({url:args.url,apiKey:args.apiKey,autoImport:args.autoImport,fetcher:registry.original});
          startTelemetry(result.config);
          return result.message;
        }catch(error){
          return `Failed to configure Observatory: ${(error as Error).message}`;
        }
      }
    }),
    observatory_status:tool({
      description:"Inspect durable local upload queue health; works when the server is unavailable.",
      args:{},
      async execute(){
        if(!outbox)return "OpenCode Observatory is not configured yet. Run the 'observatory_setup' tool with your Observatory server URL and API key.";
        return JSON.stringify(outbox.health());
      }
    }),
    observatory_usage:tool({
      description:"Query your centralized OpenCode usage statistics. Costs are labeled estimates and null metrics are unavailable.",
      args:{
        from:tool.schema.number().optional(),
        to:tool.schema.number().optional(),
        provider:tool.schema.string().optional(),
        model:tool.schema.string().optional(),
        groupBy:tool.schema.enum(["model","provider","account","machine","agent","credential"]).optional()
      },
      async execute(args){
        if(!config)return "OpenCode Observatory is not configured yet. Run the 'observatory_setup' tool to connect.";
        const query=new URLSearchParams(Object.entries(args).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
        return JSON.stringify(await api(config,`/api/analytics?${query}`,undefined,registry.original));
      }
    })
  };

  return {
    config:async cfg=>{
      const source=runtime.opencodeSource;runtime=await inventory(cfg.plugin??[],ctx.directory,runtime.opencode);runtime.opencodeSource=source;
      if(collector)collector.runtime=runtime;
      if(config?.autoImport&&!importTask&&collector&&outbox)importTask=importHistory(collector,outbox).catch(()=>log("Historical import failed. Run opencode-observatory import for diagnostics."));
    },
    event:async({event})=>safe(()=>{
      if(!collector)return;
      const value=event as any,props=value.properties??value.data??{};
      if(value.type==="session.created"||value.type==="session.updated")collector.session(props.info);
      if(value.type==="message.updated")collector.message(props.info);
      if(value.type==="message.part.updated")collector.part(props.part,false,props.time??Date.now());
      // Error message updates are canonical; a session error may occur without an assistant message.
      if(value.type==="session.error"&&props.error)collector.record("error",`session:${props.sessionID??"unknown"}:${Date.now()}`,{errorType:props.error.name??"unknown",errorMessage:"OpenCode session error (content excluded)"},props.sessionID??null);
    }),
    "chat.params":async(input)=>safe(()=>{
      if(!collector||!config)return;
      const key=input.provider.options?.apiKey??input.provider.info?.key;
      const oauth=input.model.providerID==="google"&&input.model.id.startsWith("antigravity-");
      const account=config.accounts[input.model.providerID]??null;
      collector.accounts.set(input.sessionID,{account,credential:!oauth&&typeof key==="string"&&!/placeholder|oauth|dummy/i.test(key)&&key?fingerprint(config.fingerprintSecret,key):null,authType:oauth?"oauth":typeof key==="string"&&key?"api-key":null,accountSource:account?"configured":"unassigned"});
    }),
    "chat.headers":async(input,output)=>safe(()=>{
      if(!collector)return;
      const hosts=new Set<string>();for(const value of [input.model.api?.url,input.provider.options?.baseURL]){if(typeof value==="string")try{hosts.add(new URL(value).host);}catch{}}
      // Antigravity rewrites Gemini endpoints to Google Cloud Code endpoints.
      if(input.model.providerID==="google")for(const host of ["cloudcode-pa.googleapis.com","daily-cloudcode-pa.googleapis.com","daily-cloudcode-pa.sandbox.googleapis.com"])hosts.add(host);
      Object.assign(output.headers,registerContext(registry,{collector,sessionId:input.sessionID,messageId:input.message.id,data:{provider:input.model.providerID,model:input.model.id,agent:input.agent,variant:(input.message as any).model?.variant??null,contextLimit:input.model.limit?.context??null,outputLimit:input.model.limit?.output??null,purpose:/title|summary/.test(input.agent)?"auxiliary":"chat",...collector.accounts.get(input.sessionID)},hosts}));
    }),
    tool:tools,
    dispose:async()=>{
      if(importTask)await importTask;
      if(outbox){try{await outbox.flush();}catch{}await outbox.close();}
      uninstallTransport(registry,collector);
    },
  };
};
export default plugin;
