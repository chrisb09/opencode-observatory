import {test,expect} from "bun:test";
import { Collector } from "../packages/plugin/src/metadata.js";
import { installTransport,registerContext,uninstallTransport,ACCOUNT_BRIDGE,observe } from "../packages/plugin/src/transport.js";
import {config,runtime} from "./fixtures.js";
test("Anthropic streaming usage does not erase earlier input/cache measurements",()=>{
  const data:any={};observe({type:"message_start",message:{model:"claude-fixture",usage:{input_tokens:11,cache_read_input_tokens:30,cache_creation_input_tokens:2,output_tokens:0}}},data,1);
  observe({type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:9}},data,10);
  expect(data.inputTokens).toBe(11);expect(data.cacheReadTokens).toBe(30);expect(data.cacheWriteTokens).toBe(2);expect(data.outputTokens).toBe(9);
});
test("inference interception preserves bytes, uses exact selected accounts, strips correlation markers and records failed retries",async()=>{
  const records:any[]=[];const original=globalThis.fetch;let calls=0,wireMarker:string|null=null;
  globalThis.fetch=(async(_input:any,init:any)=>{
    calls++;wireMarker=new Headers(init.headers).get("x-observatory-correlation");
    if(calls===1)return Response.json({error:{message:"PROMPT_SECRET"}},{status:429});
    const bytes='data: {"type":"response.output_text.delta","delta":"OUTPUT_SECRET"}\n\ndata: {"type":"response.completed","response":{"model":"actual-model","usage":{"input_tokens":23,"output_tokens":8,"input_tokens_details":{"cached_tokens":12}}}}\n\n';
    return new Response(bytes,{headers:{"content-type":"text/event-stream"}});
  }) as typeof fetch;
  const collector=new Collector(config,runtime,e=>records.push(e)),registry=installTransport();
  try{
    const bridge=(globalThis as any)[ACCOUNT_BRIDGE];bridge("token-a","alice@example.test");bridge("token-b","bob@example.test");
    const headers=registerContext(registry,{collector,sessionId:"ses_stream",messageId:"msg_stream",data:{provider:"google",model:"gemini-fixture",purpose:"chat"},hosts:new Set(["cloudcode-pa.googleapis.com"])});
    const failed=await fetch("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",{method:"POST",headers:{...headers,authorization:"Bearer token-a"},body:'{"model":"gemini-fixture","contents":"PROMPT_SECRET"}'});
    // Auth plugins may discard retry responses without consuming them: the failure must already be recorded.
    expect(records.at(-1).data.status).toBe("failed");await failed.body?.cancel();
    const success=await fetch("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",{method:"POST",headers:{...headers,authorization:"Bearer token-b"},body:'{"model":"gemini-fixture","contents":"PROMPT_SECRET"}'});
    expect(await success.text()).toContain("OUTPUT_SECRET");expect(wireMarker).toBeNull();
    const final=records.at(-1);expect(final.data.inputTokens).toBe(23);expect(final.data.cacheReadTokens).toBe(12);expect(final.data.responseModel).toBe("actual-model");expect(final.data.status).toBe("completed");expect(final.data.firstOutputMs).toBeGreaterThanOrEqual(0);
    expect(records[0].data.account).not.toBe(final.data.account);expect(JSON.stringify(records)).not.toContain("PROMPT_SECRET");expect(JSON.stringify(records)).not.toContain("OUTPUT_SECRET");expect(JSON.stringify(records)).not.toContain("token-a");expect(JSON.stringify(records)).not.toContain("alice@example.test");
    collector.message({id:"msg_assistant_stream",parentID:"msg_stream",sessionID:"ses_stream",providerID:"google",modelID:"gemini-fixture",role:"assistant",time:{created:1},tokens:{input:1,output:1,reasoning:0,cache:{read:0,write:0}},cost:0});
    collector.part({id:"step_stream",type:"step-finish",sessionID:"ses_stream",messageID:"msg_assistant_stream",tokens:{input:1,output:1,reasoning:0,cache:{read:0,write:0}},cost:0,reason:"stop"});
    expect(records.at(-1).data.account).toBe(final.data.account);expect(records.at(-1).data.accountSource).toBe("observed");
  }finally{uninstallTransport(registry,collector);globalThis.fetch=original;}
});
test("consumer cancellation and mid-stream errors settle attempts without changing bytes",async()=>{
  const original=globalThis.fetch;let cancelled=false;
  globalThis.fetch=(async()=>new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('data: {"delta":"a"}\n\n'));},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{"content-type":"text/event-stream"}})) as typeof fetch;
  const records:any[]=[];const collector=new Collector(config,runtime,e=>records.push(e)),registry=installTransport();
  try{const headers=registerContext(registry,{collector,sessionId:"ses_cancel",messageId:null,data:{provider:"openai",model:"fixture"},hosts:new Set(["fixture.test"])});
    const response=await fetch("https://fixture.test/v1/responses",{headers});const reader=response.body!.getReader();await reader.read();await reader.cancel();expect(cancelled).toBe(true);expect(records.at(-1).data.status).toBe("cancelled");
  }finally{uninstallTransport(registry,collector);globalThis.fetch=original;}
});
test("multiple sessions never borrow another session's identity",async()=>{
  const original=globalThis.fetch;globalThis.fetch=(async()=>Response.json({usage:{prompt_tokens:5,completion_tokens:2}})) as typeof fetch;
  const records:any[]=[];const a=new Collector(config,runtime,e=>records.push(e)),b=new Collector({...config,machine:"other@host"},runtime,e=>records.push(e));
  const ra=installTransport(),rb=installTransport();
  try{
    const ha=registerContext(ra,{collector:a,sessionId:"ses_a",messageId:"msg_a",data:{provider:"openai",model:"A"},hosts:new Set(["fixture.test"])}),hb=registerContext(rb,{collector:b,sessionId:"ses_b",messageId:"msg_b",data:{provider:"openai",model:"B"},hosts:new Set(["fixture.test"])});
    await Promise.all([fetch("https://fixture.test/v1/responses",{headers:ha}).then(r=>r.text()),fetch("https://fixture.test/v1/responses",{headers:hb}).then(r=>r.text())]);
    expect(records.filter(r=>r.sessionId==="ses_a").every(r=>r.data.model==="A"&&r.machine===config.machine)).toBe(true);expect(records.filter(r=>r.sessionId==="ses_b").every(r=>r.data.model==="B"&&r.machine==="other@host")).toBe(true);
  }finally{uninstallTransport(ra,a);uninstallTransport(rb,b);globalThis.fetch=original;}
});
test("public API-key fallback fingerprints the key without claiming the selected OAuth account",async()=>{
  const original=globalThis.fetch;globalThis.fetch=(async()=>Response.json({usageMetadata:{promptTokenCount:5,candidatesTokenCount:2,thoughtsTokenCount:1,totalTokenCount:8,cachedContentTokenCount:0}})) as typeof fetch;
  const snapshots:any[]=[];const collector=new Collector(config,runtime,e=>snapshots.push(e)),registry=installTransport();
  try{
    (globalThis as any)[ACCOUNT_BRIDGE]("opaque-oauth-token","oauth@example.test");
    const headers=registerContext(registry,{collector,sessionId:"ses_fallback",messageId:"msg_fallback",data:{provider:"google",model:"gemini-fixture",authType:"oauth"},hosts:new Set(["fixture.test"])});
    await (await fetch("https://fixture.test/v1/models/gemini-fixture:generateContent",{headers:{...headers,Authorization:"Bearer opaque-oauth-token","x-goog-api-key":"fixture-api-key"}})).text();
    const data=snapshots.at(-1).data;expect(data.authType).toBe("api-key");expect(data.account).toBeNull();expect(data.accountSource).toBe("unassigned");expect(data.credential).toMatch(/^hmac:/);expect(data.outputSemantics).toBe("exclusive-reasoning");expect(JSON.stringify(snapshots)).not.toContain("fixture-api-key");
  }finally{uninstallTransport(registry,collector);globalThis.fetch=original;}
});
test("mislabeled SSE, multiline events, fragmented bytes and a final event without newline retain provider usage",async()=>{
  const original=globalThis.fetch;
  const body='event: delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"PRIVATE_OUTPUT"}\r\n\r\nevent: completed\r\ndata: {"type":"response.completed","response":{"model":"actual-fixture","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40},"output_tokens_details":{"reasoning_tokens":5}}}}';
  const bytes=new TextEncoder().encode(body);let offset=0;
  globalThis.fetch=(async()=>new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}c.enqueue(bytes.slice(offset,offset+13));offset=Math.min(bytes.length,offset+13);}}),{headers:{"content-type":"application/json"}})) as typeof fetch;
  const snapshots:any[]=[],collector=new Collector(config,runtime,e=>snapshots.push(e)),registry=installTransport();
  try{
    const headers=registerContext(registry,{collector,sessionId:"ses_sse_sniff",messageId:"msg_sse_sniff",data:{provider:"openai",model:"requested-fixture"},hosts:new Set(["fixture.test"])});
    expect(await(await fetch("https://fixture.test/v1/responses",{headers})).text()).toBe(body);
    const data=snapshots.at(-1).data;expect(data.status).toBe("completed");expect(data.totalTokens).toBe(120);expect(data.cacheReadTokens).toBe(40);expect(data.reasoningTokens).toBe(5);expect(data.responseModel).toBe("actual-fixture");expect(data.firstOutputMs).toBeGreaterThanOrEqual(0);expect(JSON.stringify(snapshots)).not.toContain("PRIVATE_OUTPUT");
  }finally{uninstallTransport(registry,collector);globalThis.fetch=original;}
});
