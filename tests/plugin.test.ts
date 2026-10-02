import { describe,test,expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { Outbox } from "../packages/plugin/src/outbox.js";
import { Collector } from "../packages/plugin/src/metadata.js";
import { importHistory } from "../packages/plugin/src/history.js";
import { EventSchema } from "@observatory/contracts";
import { config,runtime,event } from "./fixtures.js";

describe("durable delivery",()=>{
  test("lost acknowledgement, restart, partial ack and replay preserve every event",async()=>{
    const dir=await mkdtemp("/tmp/opencode/outbox-test-");const server=new Set<string>();let fail=true,partial=true;
    const fetcher=(async(_url:any,options:any)=>{
      const batch=JSON.parse(options.body).events;for(const e of batch)server.add(e.eventId);
      if(fail){fail=false;throw new Error("Connection lost after commit");}
      return Response.json({acknowledged:partial?(partial=false,[batch[0].eventId]):batch.map((e:any)=>e.eventId)});
    }) as typeof fetch;
    let box=new Outbox(config,join(dir,"outbox.db"),fetcher);
    const a=event(),b=event();box.enqueue(a);box.enqueue(b);
    await expect(box.flush()).rejects.toThrow("Connection lost");expect(box.health().pending).toBe(2);await box.close();
    box=new Outbox(config,join(dir,"outbox.db"),fetcher);
    expect(await box.flush()).toBe(1);expect(box.health().pending).toBe(1);
    await box.drain();expect(server.size).toBe(2);expect(box.health().acknowledged).toBe(2);
    box.replay();expect(box.health().pending).toBe(2);await box.drain();expect(server.size).toBe(2);
    await box.close();await rm(dir,{recursive:true,force:true});
  });
  test("concurrent queue handles share receipts and coalesce overlapping flush calls",async()=>{
    const dir=await mkdtemp("/tmp/opencode/concurrent-test-");let uploads=0;
    const fetcher=(async(_url:any,init:any)=>{uploads++;await Bun.sleep(10);return Response.json({acknowledged:JSON.parse(init.body).events.map((e:any)=>e.eventId)});}) as typeof fetch;
    const a=new Outbox(config,join(dir,"outbox.db"),fetcher),b=new Outbox(config,join(dir,"outbox.db"),fetcher);
    a.enqueue(event());b.enqueue(event());await Promise.all([a.flush(),a.flush()]);
    expect(uploads).toBe(1);expect(b.health().pending).toBe(0);await Promise.all([a.close(),b.close()]);await rm(dir,{recursive:true,force:true});
  });
});
test("collector excludes content and credentials while retaining meaningful metadata",()=>{
  const records:any[]=[];const collector=new Collector(config,runtime,e=>records.push(e));
  collector.session({id:"ses_privacy",projectID:"prj_secret",title:"My Session Title",directory:"/PRIVATE_PATH",version:"1.17.0",time:{created:1,updated:2}});
  collector.message({id:"msg_privacy",sessionID:"ses_privacy",role:"assistant",providerID:"openai",modelID:"test-model",time:{created:1,completed:10},tokens:{input:5,output:4,reasoning:1,cache:{read:2,write:0}},cost:0.1,error:{name:"APIError",data:{message:"PROMPT_SECRET sk-key-secret",responseBody:"PROMPT_SECRET",statusCode:429}}});
  collector.part({type:"tool",id:"part_privacy",sessionID:"ses_privacy",messageID:"msg_privacy",tool:"bash",callID:"call_test",state:{status:"completed",input:{command:"COMMAND_SECRET"},output:"TOOL_SECRET",title:"TITLE_SECRET",time:{start:2,end:7},metadata:{apiKey:"KEY_SECRET"}}});
  collector.part({type:"text",id:"text_privacy",sessionID:"ses_privacy",messageID:"msg_privacy",text:"OUTPUT_SECRET"});
  const serialized=JSON.stringify(records);for(const secret of ["PROMPT_SECRET","sk-key-secret","COMMAND_SECRET","TOOL_SECRET","TITLE_SECRET","KEY_SECRET","OUTPUT_SECRET","PRIVATE_PATH"])expect(serialized).not.toContain(secret);
  expect(records.find(x=>x.kind==="tool").data.durationMs).toBe(5);expect(records.find(x=>x.kind==="error").data.errorType).toBe("rate_limit");for(const record of records)expect(EventSchema.safeParse(record).success).toBe(true);
});
test("historical import checkpoints transactionally and rescans only changed sessions",async()=>{
  const dir=await mkdtemp("/tmp/opencode/history-test-"),path=join(dir,"history.db");const db=new Database(path);
  db.exec("CREATE TABLE session(id TEXT,project_id TEXT,parent_id TEXT,version TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);");
  db.query("INSERT INTO session VALUES(?,?,?,?,?,?)").run("ses_old","prj_old",null,"1.10.0",100,200);
  db.query("INSERT INTO message VALUES(?,?,?,?,?)").run("msg_old","ses_old",JSON.stringify({role:"assistant",providerID:"openai",modelID:"old-model",time:{created:110,completed:150},tokens:{input:10,output:3,reasoning:0,cache:{read:4,write:0}},cost:0.01}),110,150);
  db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_old","msg_old","ses_old",JSON.stringify({type:"step-finish",tokens:{input:10,output:3,cache:{read:4,write:0}},cost:0.01,reason:"stop"}),150,150);
  let box=new Outbox(config,join(dir,"outbox.db"));let collector=new Collector(config,runtime,e=>box.enqueue(e));
  expect((await importHistory(collector,box,path)).sessions).toBe(1);expect(box.health().pending).toBe(3);await box.close();
  box=new Outbox(config,join(dir,"outbox.db"));collector=new Collector(config,runtime,e=>box.enqueue(e));
  expect((await importHistory(collector,box,path)).sessions).toBe(0);expect((await importHistory(collector,box,path,{all:true})).sessions).toBe(1);expect(box.health().pending).toBe(3);
  const events=box.db.query("SELECT payload FROM outbox").all() as any[];expect(events.every(x=>JSON.parse(x.payload).runtime.opencode===null)).toBe(true);expect(JSON.parse(events[0].payload).data.sessionVersion).toBe("1.10.0");
  db.query("UPDATE session SET time_updated=300").run();db.query("UPDATE part SET time_updated=300,data=?").run(JSON.stringify({type:"step-finish",tokens:{input:12,output:5},cost:0.02,reason:"stop"}));
  expect((await importHistory(collector,box,path)).sessions).toBe(1);expect(box.health().pending).toBe(5);
  db.close();await box.close();await rm(dir,{recursive:true,force:true});
});
test("configureObservatory and in-session observatory_setup tool configure and activate telemetry on the fly",async()=>{
  const dir=await mkdtemp("/tmp/opencode/setup-test-");
  const origXdg=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=dir;
  const { configureObservatory } = await import("../packages/plugin/src/config.js");
  const fakeServer=(async(input:any,init:any)=>{
    const url=String(input);
    if(url.endsWith("/api/health")) return Response.json({ok:true,version:"0.1.0"});
    if(url.endsWith("/api/client/config")){
      if(init?.headers?.Authorization!=="Bearer obs_valid_key") return Response.json({error:"Unauthorized"},{status:401});
      return Response.json({fingerprintSecret:"test-fingerprint-secret-long-enough",userId:"00000000-0000-0000-0000-000000000001",schemaVersion:1});
    }
    if(url.includes("/api/analytics")) return Response.json({summary:{calls:0}});
    return Response.json({error:"Not found"},{status:404});
  }) as typeof fetch;

  await expect(configureObservatory({url:"http://127.0.0.1:9999",apiKey:"not_obs_key",fetcher:fakeServer})).rejects.toThrow("Invalid API key format");
  await expect(configureObservatory({url:"http://127.0.0.1:9999",apiKey:"obs_wrong_key",fetcher:fakeServer})).rejects.toThrow("Authentication failed");

  const res=await configureObservatory({url:"http://127.0.0.1:9999",apiKey:"obs_valid_key",autoImport:true,fetcher:fakeServer});
  expect(res.config.url).toBe("http://127.0.0.1:9999");
  expect(res.config.apiKey).toBe("obs_valid_key");
  expect(res.hasReadScope).toBe(true);
  expect(res.message).toContain("OpenCode Observatory connected successfully");

  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeServer;
  try {
    const pluginModule = await import("../packages/plugin/src/index.js");
    const plugin = pluginModule.default;
    const mockCtx: any = {
      client: { app: { log: async () => {} } },
      directory: dir,
      serverUrl: new URL("http://127.0.0.1:9999"),
      project: { id: "prj_setup_test" },
    };
    const hooks = await plugin(mockCtx);
    expect(hooks.tool?.observatory_setup).toBeDefined();
    expect(hooks.tool?.observatory_status).toBeDefined();
    const setupOutput = await hooks.tool!.observatory_setup.execute({ apiKey: "obs_valid_key", url: "http://127.0.0.1:9999" }, {} as any);
    expect(typeof setupOutput === "string" ? setupOutput : (setupOutput as any).output).toContain("connected successfully");
    const statusOutput = await hooks.tool!.observatory_status.execute({}, {} as any);
    expect(typeof statusOutput === "string" ? statusOutput : (statusOutput as any).output).toContain("pending");

    // Test clearing via tool
    const clearOutput = await hooks.tool!.observatory_setup.execute({ clear: true }, {} as any);
    expect(typeof clearOutput === "string" ? clearOutput : (clearOutput as any).output).toContain("configuration removed");
    const statusAfterClear = await hooks.tool!.observatory_status.execute({}, {} as any);
    expect(typeof statusAfterClear === "string" ? statusAfterClear : (statusAfterClear as any).output).toContain("not configured");

    await hooks.dispose?.();
  } finally {
    globalThis.fetch = origFetch;
  }

  const { loadConfig, clearConfig } = await import("../packages/plugin/src/config.js");
  expect(await loadConfig()).toBeNull();
  await clearConfig({ data: true });

  process.env.XDG_CONFIG_HOME=origXdg;
  await rm(dir,{recursive:true,force:true});
});
