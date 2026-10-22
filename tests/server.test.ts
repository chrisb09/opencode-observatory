import {describe,test,expect,beforeAll,afterAll} from "bun:test";
import {randomUUID,randomBytes} from "node:crypto";
import {event} from "./fixtures.js";

const enabled=!!process.env.TEST_DATABASE_URL;
if(enabled){process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.ENCRYPTION_KEY=randomBytes(32).toString("hex");process.env.PUBLIC_URL="http://localhost:7692";}
describe.skipIf(!enabled)("PostgreSQL end-to-end API and MCP",()=>{
  let app:any,pool:any,tenant:any,userA:string,userB:string,keyA:string,keyB:string,cookie:string,sessionId="ses_"+randomUUID();
  const password="integration-only-password-long";
  const origin={origin:"http://localhost:7692"};
  const bearer=(key:string)=>({authorization:`Bearer ${key}`});
  beforeAll(async()=>{
    const db=await import("../apps/server/src/db.js");pool=db.pool;tenant=db.tenant;await db.migrate();
    const security=await import("../apps/server/src/security.js");
    const suffix=randomUUID();userA=await security.createUser(`a-${suffix}@example.test`,password,true);userB=await security.createUser(`b-${suffix}@example.test`,password);
    app=await (await import("../apps/server/src/app.js")).buildApp(false);
    const login=await app.inject({method:"POST",url:"/api/auth/login",headers:origin,payload:{email:`a-${suffix}@example.test`,password}});expect(login.statusCode).toBe(200);cookie=String(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]).split(";")[0];
    const result=await app.inject({method:"POST",url:"/api/keys",headers:{...origin,cookie},payload:{name:"client",scopes:["ingest","read"]}});expect(result.statusCode).toBe(200);keyA=result.json().key;
    keyB=`obs_${security.token()}`;await pool.query("INSERT INTO api_keys VALUES($1,$2,$3,$4,$5,$6,now(),NULL,NULL)",[randomUUID(),userB,"client-b",security.hash(keyB),security.encrypt(keyB),["ingest","read"]]);
  });
  afterAll(async()=>{
    await app?.close();if(pool){await pool.query("DELETE FROM invitations WHERE created_by=ANY($1::uuid[])",[[userA,userB].filter(Boolean)]);await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[userA,userB].filter(Boolean)]);await pool.end();}
  });
  test("anonymous users cannot read usage or ingest; browser CSRF and key-management boundaries hold",async()=>{
    expect((await app.inject("/api/analytics")).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:origin,payload:{events:[event()]}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/keys",headers:{cookie,origin:"https://evil.test"},payload:{name:"bad",scopes:["read"]}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/api/keys",headers:bearer(keyA),payload:{name:"bad",scopes:["read"]}})).statusCode).toBe(403);
  });
  test("acknowledged duplicates and message/step snapshots do not double-count usage",async()=>{
    const step=event({sessionId,entityId:"part_canonical",messageId:"msg_canonical"});
    const message=event({sessionId,kind:"message",entityId:"msg_canonical",messageId:"msg_canonical",data:{...step.data,cost:0.001}});
    const attempt=event({sessionId,kind:"attempt",entityId:"attempt_context",messageId:"msg_canonical",data:{...step.data,contextLimit:200,usageSource:"provider",usageSemantics:"opencode-exclusive-input",status:"completed",durationMs:80}});
    const body={events:[message,step,attempt]};
    for(let i=0;i<2;i++){const result=await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:body});expect(result.statusCode).toBe(200);expect(result.json().acknowledged).toEqual([message.eventId,step.eventId,attempt.eventId]);}
    const result=await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)});expect(result.statusCode).toBe(200);
    expect(result.json().summary.calls).toBe(1);expect(Number(result.json().summary.input_tokens)).toBe(100);expect(Number(result.json().summary.output_tokens)).toBe(20);
    expect(result.json().outputDistribution.reduce((sum:number,b:any)=>sum+b.calls,0)).toBe(1);expect(result.json().contextDistribution[0].range).toBe("50–75%");expect(Number(result.json().contextPercentiles.p50_ratio)).toBeCloseTo(.7);
    const newer=event({sessionId,entityId:step.entityId,messageId:step.messageId,revision:step.revision+10,data:{...step.data,inputTokens:120}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[newer]}});
    const stale=event({...step,eventId:randomUUID()});await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[stale]}});
    expect(Number((await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)})).json().summary.input_tokens)).toBe(120);
    const historical=event({sessionId,kind:"step",entityId:step.entityId,messageId:step.messageId,revision:step.revision+1000,historical:true,data:{...step.data,inputTokens:999,outputTokens:888}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[historical]}});
    const protectedData=await app.inject({url:`/api/entities/step?sessionId=${sessionId}`,headers:bearer(keyA)});
    expect(protectedData.json().items[0].historical).toBe(false);expect(protectedData.json().items[0].data.inputTokens).toBe(120);
    expect((await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)})).json().summary.imported_calls).toBe(0);
    const laterLive=event({sessionId,entityId:step.entityId,messageId:step.messageId,revision:step.revision+20,data:{...step.data,inputTokens:130}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[laterLive]}});
    expect(Number((await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)})).json().summary.input_tokens)).toBe(130);
  });
  test("auxiliary usage is deduplicated only by matching parent, installation, provider and model",async()=>{
    const sessionId=`ses_${randomUUID()}`,parent=`user_${randomUUID()}`,messageId=`msg_${randomUUID()}`;
    const usage=event().data;
    const message=event({sessionId,kind:"message",entityId:messageId,messageId,data:{...usage,parentMessageId:parent}});
    const attempts=[
      {},
      {provider:"other"},
      {model:"other"},
    ].map(data=>event({sessionId,kind:"attempt",messageId:parent,data:{...usage,purpose:"auxiliary",...data}}));
    const otherInstallation=event({sessionId,kind:"attempt",installationId:randomUUID(),messageId:parent,data:{...usage,purpose:"auxiliary"}});
    const result=await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[message,...attempts,otherInstallation]}});
    expect(result.statusCode).toBe(200);
    const stats=await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)});
    expect(stats.statusCode).toBe(200);expect(stats.json().summary.calls).toBe(4);
    // Updating the parent must update the indexed lookup too, restoring the unmatched attempt.
    const updated=event({...message,eventId:randomUUID(),revision:message.revision+1,data:{...message.data,parentMessageId:"different-parent"}});
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[updated]}})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)})).json().summary.calls).toBe(5);
  });
  test("analytics component profiling preserves results and identifies cache-miss work",async()=>{
    const {analytics}=await import("../apps/server/src/analytics.js");
    const {invalidateAnalytics}=await import("../apps/server/src/cache.js");
    const sessionId=`ses_${randomUUID()}`,step=event({sessionId});
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[step]}})).statusCode).toBe(200);
    const query={sessionId,from:step.observedAt,to:step.observedAt+1000,groupBy:"provider"};
    const expected=await analytics(userA,query);
    invalidateAnalytics(userA);
    const samples:import("../apps/server/src/analytics.js").AnalyticsProfile[]=[];
    const actual=await analytics(userA,query,sample=>samples.push(sample));
    expect(actual).toEqual(expected);
    expect(samples.find(sample=>sample.component==="hourly buckets + exact boundaries")).toMatchObject({inputRecords:1,outputRecords:1});
    expect(samples.find(sample=>sample.component==="bucket totals + breakdowns + charts")).toMatchObject({inputRecords:1,outputRecords:1});
    expect(samples.every(sample=>sample.ms>=0)).toBe(true);
    expect(samples.every(sample=>sample.startedAt>=0&&sample.cpuMs>=0&&Number.isFinite(sample.heapDeltaBytes))).toBe(true);
    expect(samples.some(sample=>sample.component==="usage SQL + driver")).toBe(false);
    const cachedSamples:unknown[]=[];
    expect(await analytics(userA,query,sample=>cachedSamples.push(sample))).toEqual(expected);
    expect(cachedSamples).toHaveLength(0);
  });
  test("tenant-scoped APIs and PostgreSQL RLS prevent reads across users",async()=>{
    const result=await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyB)});expect(result.json().summary.calls).toBe(0);
    expect((await app.inject({url:`/api/entities/step?sessionId=${sessionId}`,headers:bearer(keyB)})).json().total).toBe(0);
    const role=await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");expect(role.rows[0].rolsuper).toBe(false);expect(role.rows[0].rolbypassrls).toBe(false);
    const hidden=await tenant(userB,async(db:any)=>(await db.query("SELECT count(*)::int AS n FROM entities WHERE session_id=$1",[sessionId])).rows[0].n);expect(hidden).toBe(0);
    for(const table of ["usage_facts","usage_hourly","usage_dirty","usage_rollup_state"]){
      expect(await tenant(userB,async(db:any)=>(await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[userA])).rows[0].n)).toBe(0);
    }
  });
  test("hourly analytics matches raw analytics across exact boundaries, filters, corrections and rebuilds",async()=>{
    const {analytics,analyticsLegacy}=await import("../apps/server/src/analytics.js");
    const {invalidateAnalytics}=await import("../apps/server/src/cache.js");
    const {refreshUsage}=await import("../apps/server/src/rollups.js");
    const sessionId=`ses_${randomUUID()}`,h=3600000,base=Math.floor(1700000000000/h)*h;
    const steps=Array.from({length:10},(_,i)=>event({sessionId,observedAt:base+i*1300000+500,revision:base+i*1300000+1000,data:{...event().data,inputTokens:100+i,durationMs:10+i,agent:i%2?"plan":"build",...(i===9?{inputTokens:null,cost:null}:{}),...(i===8?{account:"test-account",authType:"oauth"}:{})}}));
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:steps}})).statusCode).toBe(200);
    const equal=(a:any,b:any)=>{
      if(typeof a==="number"&&typeof b==="number")expect(a).toBeCloseTo(b,8);
      else if(a!==null&&b!==null&&typeof a==="object"&&typeof b==="object"){
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());for(const key of Object.keys(b))equal(a[key],b[key]);
      }else expect(a).toEqual(b);
    };
    const verify=async()=>{
      for(const range of [{from:base,to:base+4*h},{from:base+123,to:base+h+456},{from:base+h+500,to:base+h+1500},{from:base-100*24*h,to:base+100*24*h},{to:base+4*h}]){
        for(const filter of [{},{model:"test-model"},{account:"test-account"},{status:"completed"},{projectId:"prj_test"},{sessionId}]){
          const q={...range,...filter,installationId:steps[0]!.installationId,groupBy:"provider"};
          // Scope the unfiltered query to this fixture's unique machine.
          const query={...q,machine:"rollup-fixture"};equal(await analytics(userA,query),await analyticsLegacy(userA,query));
        }
      }
    };
    const upload=async(events:any[])=>{expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:events.map(e=>({...e,machine:"rollup-fixture"}))}})).statusCode).toBe(200);};
    await upload(steps.map(e=>({...e,eventId:randomUUID(),revision:e.revision+1})));await verify();
    const changed=steps[0]!;
    await upload([event({...changed,eventId:randomUUID(),revision:changed.revision+100,data:{...changed.data,model:"changed",inputTokens:900}})]);await verify();
    await tenant(userA,async(db:any)=>{await db.query("DELETE FROM entities WHERE user_id=$1 AND installation_id=$2 AND kind='step' AND entity_id=$3",[userA,steps[1]!.installationId,steps[1]!.entityId]);});
    invalidateAnalytics(userA);await verify();
    await tenant(userA,async(db:any)=>{await db.query("UPDATE usage_hourly SET metrics[1]=metrics[1]+7 WHERE user_id=$1",[userA]);await refreshUsage(db,userA,true);});invalidateAnalytics(userA);await verify();
  },30000);
  test("fact triggers move contributions and roll back hourly changes atomically",async()=>{
    const marker=new Error("rollback trigger test");
    await expect(tenant(userA,async(db:any)=>{
      const baseline=Number((await db.query("SELECT sum(metrics[1]) AS calls FROM usage_hourly WHERE user_id=$1",[userA])).rows[0].calls);
      const row=(await db.query("SELECT installation_id,kind,entity_id FROM usage_facts WHERE user_id=$1 LIMIT 1",[userA])).rows[0];
      const args=[userA,row.installation_id,row.kind,row.entity_id];
      await db.query(`UPDATE usage_facts SET observed_at=observed_at+3600000,dimensions=jsonb_set(dimensions,'{machine}','"moved-by-trigger"') WHERE user_id=$1 AND installation_id=$2 AND kind=$3 AND entity_id=$4`,args);
      expect(Number((await db.query("SELECT sum(metrics[1]) AS calls FROM usage_hourly WHERE user_id=$1 AND dimensions->>'machine'='moved-by-trigger'",[userA])).rows[0].calls)).toBe(1);
      await db.query("DELETE FROM usage_facts WHERE user_id=$1 AND installation_id=$2 AND kind=$3 AND entity_id=$4",args);
      expect(Number((await db.query("SELECT sum(metrics[1]) AS calls FROM usage_hourly WHERE user_id=$1",[userA])).rows[0].calls)).toBe(baseline-1);
      throw marker;
    })).rejects.toBe(marker);
  });
  test("deleting steps and messages restores the correct canonical fallback in full-hour buckets",async()=>{
    const {analytics}=await import("../apps/server/src/analytics.js"),{invalidateAnalytics}=await import("../apps/server/src/cache.js");
    const sessionId=`ses_${randomUUID()}`,messageId=`msg_${randomUUID()}`,parent=`user_${randomUUID()}`,base=Math.floor(1700000000000/3600000)*3600000;
    const data=event().data,message=event({sessionId,kind:"message",entityId:messageId,messageId,data:{...data,parentMessageId:parent}});
    const auxiliary=event({sessionId,kind:"attempt",messageId:parent,data:{...data,purpose:"auxiliary",inputTokens:80}});
    const step=event({sessionId,messageId,data:{...data,inputTokens:120}});
    const query={machine:`fallback-${sessionId}`,from:base,to:base+3600000};
    const summary=async()=>{invalidateAnalytics(userA);return(await analytics(userA,query)).summary;};
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[message,auxiliary,step].map(e=>({...e,machine:query.machine}))}})).statusCode).toBe(200);
    expect((await summary()).input_tokens).toBe(120);
    const remove=async(kind:string,id:string)=>tenant(userA,(db:any)=>db.query("DELETE FROM entities WHERE user_id=$1 AND installation_id=$2 AND kind=$3 AND entity_id=$4",[userA,step.installationId,kind,id]));
    await remove("step",step.entityId);expect((await summary()).input_tokens).toBe(100);
    await remove("message",message.entityId);expect((await summary()).input_tokens).toBe(80);
    await remove("attempt",auxiliary.entityId);expect((await summary()).calls).toBe(0);
  });
  test("market catalog changes invalidate persisted usage valuation",async()=>{
    const {analytics}=await import("../apps/server/src/analytics.js"),{invalidateAnalytics}=await import("../apps/server/src/cache.js");
    const sessionId=`ses_${randomUUID()}`,model=`catalog-${randomUUID()}`,step=event({sessionId,data:{...event().data,model}});
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[step]}})).statusCode).toBe(200);
    const cost=async()=>{invalidateAnalytics(userA);return(await analytics(userA,{sessionId})).summary.market_cost;};
    expect(await cost()).toBeNull();
    try{
      await pool.query("INSERT INTO market_rates VALUES($1,1,2,0.5,0)",[model]);expect(await cost()).toBeCloseTo(.000168,10);
      await pool.query("UPDATE market_rates SET input=2 WHERE model_pattern=$1",[model]);expect(await cost()).toBeCloseTo(.000268,10);
    }finally{await pool.query("DELETE FROM market_rates WHERE model_pattern=$1",[model]);}
    expect(await cost()).toBeNull();
  });
  test("rollup dimension keys preserve escaped and Unicode metadata",async()=>{
    const machine='quoted " \\ newline\n café',sessionId=`ses_${randomUUID()}`;
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[event({machine,sessionId})]}})).statusCode).toBe(200);
    const result=await app.inject({url:`/api/analytics?machine=${encodeURIComponent(machine)}`,headers:bearer(keyA)});
    expect(result.statusCode).toBe(200);expect(result.json().summary.calls).toBe(1);expect(result.json().machineGroups[0].id).toBe(machine);
  });
  test("pricing overrides select immutable effective rules and preserve original measurements",async()=>{
    const result=await app.inject({method:"POST",url:"/api/prices",headers:{...origin,cookie},payload:{provider:"openai",model:"test-model",effectiveAt:0,input:1,output:2,cacheRead:0.5,cacheWrite:0}});expect(result.statusCode).toBe(200);
    const result2=await app.inject({url:`/api/analytics?sessionId=${sessionId}`,headers:bearer(keyA)});expect(Number(result2.json().summary.market_cost)).toBeCloseTo((130+(20+4)*2+40*.5)/1000000,8);expect(Number(result2.json().summary.cost)).toBe(.001);
    const records=(await app.inject({url:`/api/entities/step?sessionId=${sessionId}`,headers:bearer(keyA)})).json();expect(records.items[0].data.cost).toBe(0.001);
    const missingCache=event({sessionId,kind:"step",entityId:"part_no_cache",messageId:"msg_no_cache",data:{provider:"openai",model:"cache-model",inputTokens:100,outputTokens:10,cacheReadTokens:null,cacheWriteTokens:null,usageSemantics:"opencode-exclusive-input",costSource:"opencode-estimate"}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[missingCache]}});
    await app.inject({method:"POST",url:"/api/prices",headers:{...origin,cookie},payload:{provider:"openai",model:"cache-model",effectiveAt:0,input:1,output:2,cacheRead:.5,cacheWrite:.5}});
    const unknownCost=await app.inject({url:`/api/analytics?sessionId=${sessionId}&model=cache-model`,headers:bearer(keyA)});
    expect(unknownCost.json().summary.cost).toBeNull();expect(unknownCost.json().summary.unknown_cost_calls).toBe(1);expect(unknownCost.json().summary.market_cost).toBeNull();
  });
  test("invitations are email-bound and single-use, and key reveal requires a password",async()=>{
    const email=`invited-${randomUUID()}@example.test`;
    const invite=await app.inject({method:"POST",url:"/api/invitations",headers:{...origin,cookie},payload:{email}});expect(invite.statusCode).toBe(200);
    const code=new URL(invite.json().url).searchParams.get("invite");
    const bad=await app.inject({method:"POST",url:"/api/auth/accept-invite",headers:origin,payload:{email:"wrong@example.test",password,invite:code}});expect(bad.statusCode).toBe(400);
    const good=await app.inject({method:"POST",url:"/api/auth/accept-invite",headers:origin,payload:{email,password,invite:code}});expect(good.statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/api/auth/accept-invite",headers:origin,payload:{email,password,invite:code}})).statusCode).toBe(400);
    const keys=(await app.inject({url:"/api/keys",headers:{cookie}})).json();const id=keys[0].id;
    expect((await app.inject({method:"POST",url:`/api/keys/${id}/reveal`,headers:{...origin,cookie},payload:{password:"incorrect"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/api/keys/${id}/reveal`,headers:{...origin,cookie},payload:{password}})).json().key).toBe(keyA);
    await pool.query("DELETE FROM users WHERE email=$1",[email]);
  });
  test("MCP requires scoped bearer auth and answers bounded tenant queries",async()=>{
    expect((await app.inject({method:"POST",url:"/mcp",headers:origin,payload:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}}})).statusCode).toBe(401);
    const headers={...bearer(keyA),"content-type":"application/json",accept:"application/json, text/event-stream"};
    const init=await app.inject({method:"POST",url:"/mcp",headers,payload:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}}});expect(init.statusCode).toBe(200);expect(init.json().result.serverInfo.name).toBe("opencode-observatory");
    const result=await app.inject({method:"POST",url:"/mcp",headers,payload:{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"usage_summary",arguments:{sessionId,model:"test-model"}}}});expect(result.statusCode).toBe(200);expect(JSON.parse(result.json().result.content[0].text).summary.calls).toBe(1);
  });
  test("revoked keys cannot upload queued data",async()=>{
    const key=await app.inject({method:"POST",url:"/api/keys",headers:{...origin,cookie},payload:{name:"temporary",scopes:["ingest"]}});
    expect((await app.inject({method:"DELETE",url:`/api/keys/${key.json().id}`,headers:{...origin,cookie}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/api/ingest",headers:bearer(key.json().key),payload:{events:[event()]}})).statusCode).toBe(401);
  });
  test("error breakdown returns sanitized, filterable provider failure categories",async()=>{
    const failure=event({sessionId,kind:"attempt",entityId:"attempt_failure",data:{provider:"openai",model:"failed-model",status:"failed",errorType:"rate_limit",errorCode:"rate_limit_exceeded",errorMessage:"Provider rate limit exceeded",httpStatus:429,retryable:true}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[failure]}});
    const result=await app.inject({url:`/api/errors?sessionId=${sessionId}&model=failed-model`,headers:bearer(keyA)});
    expect(result.statusCode).toBe(200);expect(result.json().items[0].error_type).toBe("rate_limit");expect(result.json().items[0].occurrences).toBe(1);expect(result.json().items[0].retryable).toBe(1);
  });
  test("hourly and per-model series reconcile with totals, including empty intervals",async()=>{
    const from=Date.UTC(2026,9,1),to=from+86400000,session="ses_series";
    const first=event({sessionId:session,entityId:"series_a",messageId:"message_series_a",observedAt:from+1000,data:{provider:"openai",model:"gpt-5.5",inputTokens:100,cacheReadTokens:40,cacheWriteTokens:0,outputTokens:20,reasoningTokens:4,usageSource:"opencode",usageSemantics:"opencode-exclusive-input",cost:0,status:"completed"}});
    const second=event({...first,eventId:randomUUID(),entityId:"series_b",messageId:"message_series_b",observedAt:from+4*3600000,data:{...first.data,model:"gpt-5.4",inputTokens:200}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[first,second]}});
    const r=(await app.inject({url:`/api/analytics?sessionId=${session}&from=${from}&to=${to}`,headers:bearer(keyA)})).json();
    expect(r.timeframe.bucket).toBe("hour");expect(r.series).toHaveLength(24);expect(r.series[1].total_tokens).toBe(0);expect(r.summary.total_tokens).toBe(428);
    expect(r.series.reduce((sum:number,p:any)=>sum+(p.total_tokens??0),0)).toBe(428);expect(r.modelSeries.reduce((sum:number,m:any)=>sum+m.series.reduce((n:number,p:any)=>n+(p.total_tokens??0),0),0)).toBe(428);
    expect(r.summary.market_cost).toBeGreaterThan(0);expect(r.providerGroups[0].account_count).toBe(0);expect(r.accountGroups[0].label).toContain("unassigned");
  });
  test("three provider accounts remain distinct; assignments are explicit and invalidate cached analytics",async()=>{
    const session="ses_accounts",events=["a","b","c"].map(id=>event({sessionId:session,entityId:`account_${id}`,messageId:`message_account_${id}`,data:{...event().data,provider:"google",model:"gemini-3.8-flash",account:`hmac:${id}`,credential:`hmac:key_${id}`,accountSource:"observed"}}));
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events}});
    const before=(await app.inject({url:`/api/analytics?sessionId=${session}&groupBy=account`,headers:bearer(keyA)})).json();expect(before.groups).toHaveLength(3);expect(before.providerGroups[0].account_count).toBe(3);expect(before.credentialGroups).toHaveLength(3);
    const drill=(await app.inject({url:`/api/entities/step?sessionId=${session}&account=${encodeURIComponent("google/hmac:b")}`,headers:bearer(keyA)})).json();expect(drill.total).toBe(1);expect(drill.items[0].data.account).toBe("hmac:b");
    const unassigned=event({sessionId:"ses_assign",entityId:"assign",data:{...event().data,provider:"google",model:"gemini-3.8-flash"}});await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[unassigned]}});
    expect((await app.inject({url:"/api/analytics?sessionId=ses_assign&groupBy=account",headers:bearer(keyA)})).json().groups[0].attribution).toBe("unassigned");
    const assignment=await app.inject({method:"POST",url:"/api/account-assignments",headers:{...origin,cookie},payload:{provider:"google",label:"Historical personal",from:0,to:null,installationId:unassigned.installationId}});expect(assignment.statusCode).toBe(200);
    const after=(await app.inject({url:"/api/analytics?sessionId=ses_assign&groupBy=account",headers:bearer(keyA)})).json();expect(after.groups[0].attribution).toBe("assigned");expect(after.groups[0].label).toContain("Historical personal");expect(after.summary.credential_count).toBe(0);
    const assignedDrill=(await app.inject({url:`/api/entities/step?sessionId=ses_assign&account=${encodeURIComponent(after.groups[0].id)}`,headers:bearer(keyA)})).json();expect(assignedDrill.total).toBe(1);
    expect((await app.inject({url:"/api/analytics?sessionId=ses_assign&groupBy=account",headers:bearer(keyB)})).json().summary.calls).toBe(0);
  });
  test("grouped timelines reconcile calls, tokens and costs; Antigravity is separate from Google",async()=>{
    const session="ses_grouped_charts",from=Date.UTC(2026,9,1),to=from+86400000;
    const definitions=[
      ["google","antigravity-gemini-3.8-flash","a","desk"],
      ["google","antigravity-claude-sonnet-4-6","b","laptop"],
      ["google","gemini-3.8-flash","a","desk"],
      ["openai","gpt-5.5","a","laptop"]
    ];
    const events=definitions.map(([provider,model,account,machine],i)=>event({sessionId:session,machine,entityId:`grouped_${i}`,messageId:`grouped_message_${i}`,observedAt:from+i*3600000,data:{...event().data,provider,model,account:`hmac:${account}`,credential:`hmac:key_${account}`,accountSource:"observed",cost:i===3?null:.1*(i+1)}}));
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events}});
    const query=`/api/analytics?sessionId=${session}&from=${from}&to=${to}`;
    for(const grouping of ["model","provider","account","credential","machine"]){
      const r=(await app.inject({url:`${query}&groupBy=${grouping}`,headers:bearer(keyA)})).json();
      expect(r.groupBy).toBe(grouping);expect(r.summary.calls).toBe(4);
      for(const metric of ["calls","total_tokens","cost","unknown_cost_calls"]){
        const sum=r.groupSeries.reduce((n:number,g:any)=>n+g.series.reduce((total:number,p:any)=>total+(p[metric]??0),0),0);
        expect(sum).toBeCloseTo(r.summary[metric]);
      }
      for(const g of r.groupSeries){expect(g.series).toHaveLength(24);expect(g.series[10].calls).toBe(0);expect(g.series[10].cost).toBe(0);}
    }
    const providers=(await app.inject({url:`${query}&groupBy=provider`,headers:bearer(keyA)})).json();
    expect(providers.groups).toHaveLength(3);expect(providers.groups.find((g:any)=>g.id==="antigravity").calls).toBe(2);
    for(const [provider,count] of [["antigravity",2],["google",1]]){
      const r=(await app.inject({url:`${query}&provider=${provider}&groupBy=provider`,headers:bearer(keyA)})).json();
      expect(r.summary.calls).toBe(count);expect(r.groups).toHaveLength(1);expect(r.groups[0].id).toBe(provider);
    }
    const account=(await app.inject({url:`${query}&account=google%2Fhmac%3Ab&groupBy=account`,headers:bearer(keyA)})).json();
    expect(account.groups).toHaveLength(1);expect(account.groupSeries).toHaveLength(1);expect(account.summary.calls).toBe(1);
    const machine=(await app.inject({url:`${query}&machine=desk&groupBy=machine`,headers:bearer(keyA)})).json();
    expect(machine.groups).toHaveLength(1);expect(machine.groupSeries[0].id).toBe("desk");expect(machine.summary.calls).toBe(2);
  });
  test("numeric sorting applies before pagination and sessions sum mixed-model canonical usage",async()=>{
    const session="ses_sort",rows=[1,20,3].map(n=>event({sessionId:session,kind:"tool",entityId:`sort_${n}`,messageId:null,data:{tool:"bash",durationMs:n,status:"completed"}}));
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:rows}});
    const r=(await app.inject({url:`/api/entities/tool?sessionId=${session}&sortBy=durationMs&sortDir=desc&limit=1&offset=1`,headers:bearer(keyA)})).json();expect(r.items[0].data.durationMs).toBe(3);
    expect((await app.inject({url:"/api/entities/tool?sortBy=not_a_column",headers:bearer(keyA)})).statusCode).toBe(400);
    const sessionEvent=event({kind:"session",entityId:"ses_series",sessionId:"ses_series",messageId:null,data:{status:"completed",cost:99,inputTokens:999,outputTokens:999}});await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[sessionEvent]}});
    const s=(await app.inject({url:"/api/entities/session?sessionId=ses_series",headers:bearer(keyA)})).json().items[0];expect(s.data.totalTokens).toBe(428);expect(s.data.cost).toBe(0);expect(s.data.marketCost).toBeGreaterThan(0);
  });
  test("OAuth without a provider key is distinct from unknown historical key identity",async()=>{
    const session="ses_oauth_keys",base=event().data;
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[event({sessionId:session,entityId:"oauth_known",data:{...base,account:"hmac:oauth_account",authType:"oauth",accountSource:"observed"}}),event({sessionId:session,entityId:"oauth_historical",historical:true,data:base})]}});
    const r=(await app.inject({url:`/api/analytics?sessionId=${session}`,headers:bearer(keyA)})).json();
    expect(r.credentialGroups).toHaveLength(2);expect(r.summary.credential_count).toBe(0);expect(r.credentialGroups.find((g:any)=>g.credential_kind==="oauth").label).toContain("OAuth");
    expect((await app.inject({url:`/api/entities/step?sessionId=${session}&credential=openai%2Foauth`,headers:bearer(keyA)})).json().total).toBe(1);
  });
  test("imported errors deduplicate message copies, paginate full totals, and use qualified account filters",async()=>{
    const session="ses_error_history",data={provider:"google",model:"error-fixture",status:"failed" as const,errorType:"rate_limit",httpStatus:429,retryable:true};
    const message=event({sessionId:session,kind:"message",entityId:"msg_hist_error",messageId:"msg_hist_error",historical:true,data});
    const error=event({...message,eventId:randomUUID(),kind:"error",entityId:"message:msg_hist_error"});
    const cancellation=event({sessionId:session,kind:"error",entityId:"cancel_hist",historical:true,data:{...data,status:"cancelled",errorType:"cancelled",retryable:false}});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[message,error,cancellation]}});
    const r=(await app.inject({url:`/api/errors?sessionId=${session}&limit=1&offset=1`,headers:bearer(keyA)})).json();expect(r.total).toBe(2);expect(r.items).toHaveLength(1);expect(r.summary.occurrences).toBe(2);expect(r.summary.failed).toBe(1);expect(r.summary.cancelled).toBe(1);expect(r.summary.historical).toBe(2);
    const assigned=await app.inject({method:"POST",url:"/api/account-assignments",headers:{...origin,cookie},payload:{provider:"google",label:"Error history",installationId:message.installationId,from:message.observedAt}});expect(assigned.statusCode).toBe(200);
    const rule=(await app.inject({url:"/api/account-assignments",headers:{cookie}})).json().find((x:any)=>x.label==="Error history");
    expect((await app.inject({url:`/api/errors?sessionId=${session}&account=${encodeURIComponent(`google/${rule.account}`)}`,headers:bearer(keyA)})).json().summary.occurrences).toBe(2);
    expect((await app.inject({url:`/api/errors?sessionId=${session}`,headers:bearer(keyB)})).json().total).toBe(0);
  });
  test("request usage recovery is one-to-one, labeled, sorted before pagination, and preserves stored counters",async()=>{
    const session="ses_attempt_recovery",now=Date.now(),events:any[]=[];
    for(let i=0;i<2;i++){
      const id=`recovery_${i}`,end=now+i*10000,usage={...event().data,totalTokens:100+i*100,inputTokens:76+i*100,cacheReadTokens:0,cost:.01+i*.01};
      events.push(event({sessionId:session,kind:"message",entityId:`msg_${id}`,messageId:`msg_${id}`,revision:end+5,data:{...usage,parentMessageId:`user_${id}`}}));
      events.push(event({sessionId:session,kind:"step",entityId:`step_${id}`,messageId:`msg_${id}`,revision:end+5,data:usage}));
      events.push(event({sessionId:session,kind:"attempt",entityId:`attempt_${id}`,messageId:`user_${id}`,data:{provider:"openai",model:"test-model",status:"completed",startedAt:end-2000,endedAt:end,durationMs:2000,usageSource:"unavailable",...(i===0?{cost:.99,costSource:"provider" as const}:{})}}));
    }
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events}});
    const r=(await app.inject({url:`/api/entities/attempt?sessionId=${session}&sortBy=totalTokens&limit=1`,headers:bearer(keyA)})).json();expect(r.items[0].data.totalTokens).toBe(200);expect(r.items[0].data.usageProvenance).toBe("lifecycle-correlated");expect(r.summary.known_usage).toBe(2);expect(r.summary.total_tokens).toBe(300);
    const all=(await app.inject({url:`/api/entities/attempt?sessionId=${session}`,headers:bearer(keyA)})).json();expect(all.items.find((row:any)=>row.entity_id==="attempt_recovery_0").data.cost).toBe(.99);expect(all.items.find((row:any)=>row.entity_id==="attempt_recovery_0").data.costSource).toBe("provider");
    const stored=await tenant(userA,async(db:any)=>(await db.query("SELECT data FROM entities WHERE user_id=$1 AND session_id=$2 AND kind='attempt'",[userA,session])).rows);expect(stored.every((row:any)=>row.data.totalTokens===undefined)).toBe(true);
    const ambiguous=event({sessionId:session,kind:"step",entityId:"duplicate_recovery_step",messageId:"msg_recovery_1",revision:now+10005,data:event().data});
    await app.inject({method:"POST",url:"/api/ingest",headers:bearer(keyA),payload:{events:[ambiguous]}});
    const after=(await app.inject({url:`/api/entities/attempt?sessionId=${session}`,headers:bearer(keyA)})).json();expect(after.summary.known_usage).toBe(1);expect(after.items.find((row:any)=>row.entity_id==="attempt_recovery_1").data.totalTokens).toBeNull();
  });
  test("bootstrapAdmin is safe, idempotent, and does not overwrite existing administrators",async()=>{
    const { bootstrapAdmin } = await import("../apps/server/src/security.js");
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);
    process.env.ADMIN_EMAIL = "newadmin@example.test";
    process.env.ADMIN_PASSWORD = "short";
    await bootstrapAdmin(log);
    expect(logs.some(l => l.includes("at least 12 characters"))).toBe(true);

    process.env.ADMIN_PASSWORD = "long-secure-password-123";
    logs.length = 0;
    await bootstrapAdmin(log);
    // Since userA already exists as admin in the test DB, it must gracefully skip
    const check = await pool.query("SELECT email FROM users WHERE email='newadmin@example.test'");
    expect(check.rowCount).toBe(0);
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });
});
