import { createHmac,randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Metadata,Runtime,TelemetryEvent } from "@observatory/contracts";
import type { ClientConfig } from "./config.js";
export const size=(value:unknown)=>Buffer.byteLength(typeof value==="string"?value:JSON.stringify(value)??"");
const num=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)&&value>=0?Math.floor(value):null;
export const fingerprint=(secret:string,value:string)=>`hmac:${createHmac("sha256",secret).update(value).digest("hex")}`;
export function safeError(error:any):Metadata{
  const status=num(error?.data?.statusCode??error?.statusCode??error?.status);
  const raw=String(error?.name??"")+" "+String(error?.message??error?.data?.message??"");
  const type=status===429?"rate_limit":status===401||status===403?"authentication":/abort|cancel/i.test(raw)?"cancelled":/timeout|timed out/i.test(raw)?"timeout":/context|overflow/i.test(raw)?"context_overflow":/filter|safety/i.test(raw)?"content_filter":/ECONN|network|fetch failed/i.test(raw)?"network":status!==null&&status>=400&&status<500?"provider_rejection":status!==null&&status>=500?"provider":"unknown";
  const descriptions:Record<string,string>={rate_limit:"Provider rate limit exceeded",authentication:"Provider authentication or permission failure",cancelled:"Request cancelled",timeout:"Request timed out",context_overflow:"Model context limit exceeded",content_filter:"Provider content filter rejected the request",network:"Network connection failed",provider_rejection:"Provider rejected the request",provider:"Provider server error",unknown:"Request failed; detailed content was excluded by metadata-only collection"};
  const code=error?.code??error?.data?.metadata?.code??error?.data?.code;
  const errorCode=typeof code==="string"&&/^[A-Za-z0-9_.-]{1,128}$/.test(code)?code:null;
  const retryable=typeof error?.data?.isRetryable==="boolean"?error.data.isRetryable:status===429||(status!==null&&status>=500)?true:status!==null?false:null;
  return {errorType:type,errorCode,errorMessage:descriptions[type],httpStatus:status&&status>=100&&status<=599?status:null,retryable};
}
export function usage(tokens:any,cost:unknown):Metadata{
  return {inputTokens:num(tokens?.input),outputTokens:num(tokens?.output),reasoningTokens:num(tokens?.reasoning),cacheReadTokens:num(tokens?.cache?.read),cacheWriteTokens:num(tokens?.cache?.write),totalTokens:num(tokens?.total),usageSource:tokens?"opencode":"unavailable",usageSemantics:"opencode-exclusive-input",outputSemantics:"exclusive-reasoning",cost:typeof cost==="number"&&cost>=0&&Number.isFinite(cost)?cost:null,costSource:typeof cost==="number"?"opencode-estimate":"unavailable"};
}
export class Collector{
  readonly instanceId=randomUUID();messages=new Map<string,any>();sessions=new Map<string,{projectId:string|null;version:string|null}>();
  accounts=new Map<string,{account:string|null;credential:string|null;authType:string|null;accountSource?:Metadata["accountSource"]}>();
  requestAccounts=new Map<string,{account:string|null;credential:string|null;authType:string|null;accountSource?:Metadata["accountSource"]}>();
  constructor(readonly config:ClientConfig,public runtime:Runtime,readonly emit:(event:TelemetryEvent)=>void,readonly projectId:string|null=null){}
  record(kind:TelemetryEvent["kind"],entityId:string,data:Metadata,sessionId:string|null=null,messageId:string|null=null,historical=false,revision=Date.now(),observedAt=data.startedAt??revision){
    const session=sessionId?this.sessions.get(sessionId):undefined;
    this.emit({schemaVersion:1,eventId:randomUUID(),installationId:this.config.installationId,instanceId:this.instanceId,machine:this.config.machine,projectId:session?.projectId??this.projectId,sessionId,messageId,kind,entityId,revision,observedAt,historical,
      runtime:historical?{...this.runtime,opencode:null,provenance:"import-current"}:this.runtime,data:{coverage:historical?"historical":"lifecycle",...data}});
  }
  session(info:any,historical=false,revision=info.time?.updated??info.time_updated??Date.now()){
    this.sessions.set(info.id,{projectId:info.projectID??info.project_id??null,version:info.version??null});
    const tokens = info.tokens ?? {
      input: info.tokens_input,
      output: info.tokens_output,
      reasoning: info.tokens_reasoning,
      cache: { read: info.tokens_cache_read, write: info.tokens_cache_write }
    };
    const created = info.time?.created ?? info.time_created ?? revision;
    const updated = info.time?.updated ?? info.time_updated ?? revision;
    let modelObj = info.model;
    if (typeof modelObj === "string" && modelObj.startsWith("{")) {
      try { modelObj = JSON.parse(modelObj); } catch {}
    }
    const model = typeof modelObj === "object" && modelObj ? `${modelObj.providerID}/${modelObj.id}` : (typeof modelObj === "string" ? modelObj : null);
    const provider = typeof modelObj === "object" && modelObj ? modelObj.providerID : (typeof model === "string" ? model.split("/")[0] : null);
    const cost = typeof info.cost === "number" ? info.cost : null;
    const durationMs = (updated && created && updated >= created) ? Math.max(0, updated - created) : null;
    const title = (typeof info.title === "string" && info.title.trim())
      ? info.title.trim().slice(0, 512)
      : (typeof info.slug === "string" && info.slug.trim())
      ? info.slug.trim().slice(0, 512)
      : null;
    this.record("session",info.id,{
      title,
      parentSessionId: info.parentID ?? info.parent_id ?? null,
      sessionVersion: info.version ?? null,
      startedAt: created,
      endedAt: updated,
      durationMs,
      status: "completed",
      agent: info.agent ?? null,
      provider: provider ?? null,
      model: model ?? null,
      ...usage(tokens, cost),
    },info.id,null,historical,revision,created);
  }
  message(info:any,historical=false,revision=Date.now()){
    this.messages.set(info.id,info);
    const assistant=info.role==="assistant",provider=info.providerID??info.model?.providerID,model=info.modelID??info.model?.modelID;
    const account=this.requestAccounts.get(`${info.sessionID}:${info.parentID??info.id}:${provider}:${model}`)??this.accounts.get(info.sessionID);
    const data:Metadata={provider:info.providerID??info.model?.providerID??null,model:info.modelID??info.model?.modelID??null,agent:info.agent??null,variant:info.variant??info.model?.variant??null,parentMessageId:info.parentID??null,startedAt:info.time?.created??revision,endedAt:info.time?.completed??null,
      status:info.error?(info.error.name==="MessageAbortedError"?"cancelled":"failed"):info.time?.completed?"completed":assistant?"running":"unknown",
      durationMs:info.time?.completed?Math.max(0,info.time.completed-info.time.created):null,finishReason:info.finish??null,...(!historical?account:{}),...(assistant?usage(info.tokens,info.cost):{}),...(info.error?safeError(info.error):{})};
    this.record("message",info.id,data,info.sessionID,info.id,historical,revision,info.time?.created??revision);
    if(info.error)this.record("error",`message:${info.id}`,{...data},info.sessionID,info.id,historical,revision,info.time?.created??revision);
  }
  part(part:any,historical=false,revision=Date.now()){
    const message=this.messages.get(part.messageID),provider=message?.providerID??message?.model?.providerID,model=message?.modelID??message?.model?.modelID;
    const account=this.requestAccounts.get(`${part.sessionID}:${message?.parentID??part.messageID}:${provider}:${model}`)??this.accounts.get(part.sessionID);
    const base:Metadata={provider:provider??null,model:model??null,agent:message?.agent??null,variant:message?.variant??null,...(!historical?account:{})};
    if(part.type==="step-finish")this.record("step",part.id,{...base,...usage(part.tokens,part.cost),status:"completed",finishReason:part.reason??null,purpose:message?.summary?"compaction":"chat",startedAt:message?.time?.created??revision},part.sessionID,part.messageID,historical,revision,message?.time?.created??revision);
    if(part.type==="tool"){
      const state=part.state??{},time=state.time;
      this.record("tool",part.id,{...base,tool:String(part.tool).slice(0,512),callId:part.callID,status:state.status==="error"?"failed":state.status==="completed"?"completed":"running",argumentBytes:size(state.input??{}),outputBytes:typeof state.output==="string"?size(state.output):null,startedAt:time?.start??revision,endedAt:time?.end??null,durationMs:time?.end?Math.max(0,time.end-time.start):null,...(state.error?safeError({message:state.error}):{})},part.sessionID,part.messageID,historical,revision,time?.start??revision);
      for(const attachment of state.attachments??[])this.attachment(attachment,historical,revision,"tool");
    }
    if(part.type==="file")this.attachment(part,historical,revision);
    if(part.type==="text"||part.type==="reasoning")this.record("text",part.id,{...base,...(part.type==="text"?{textBytes:size(part.text??"")}:{reasoningBytes:size(part.text??"")}),startedAt:part.time?.start??revision,durationMs:part.time?.end?Math.max(0,part.time.end-part.time.start):null},part.sessionID,part.messageID,historical,revision,part.time?.start??revision);
    if(part.type==="retry")this.record("error",part.id,{...base,...safeError(part.error)},part.sessionID,part.messageID,historical,revision,part.time?.created??revision);
  }
  attachment(part:any,historical:boolean,revision:number,source?:"tool"){
    let bytes:number|null=null,width:number|null=null,height:number|null=null;
    const url=String(part.url??"");const attachmentSource=source??(url.startsWith("data:")?"inline":url.startsWith("file:")?"local":"remote");
    if(url.startsWith("data:")){
      const comma=url.indexOf(",");if(comma!==-1){try{const buffer=url.slice(0,comma).includes(";base64")?Buffer.from(url.slice(comma+1),"base64"):Buffer.from(decodeURIComponent(url.slice(comma+1)));bytes=buffer.length;
        if(buffer.length>=24&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){width=buffer.readUInt32BE(16);height=buffer.readUInt32BE(20);}
        if(buffer.length>=10&&buffer.subarray(0,3).toString()==="GIF"){width=buffer.readUInt16LE(6);height=buffer.readUInt16LE(8);}
      }catch{}}
    }else if(url.startsWith("file:")&&!historical){try{bytes=statSync(fileURLToPath(url)).size;}catch{}}
    this.record("attachment",part.id??randomUUID(),{mime:String(part.mime??"application/octet-stream").slice(0,512),bytes,width,height,attachmentSource},part.sessionID??null,part.messageID??null,historical,revision);
  }
}
