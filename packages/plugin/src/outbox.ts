import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { EventSchema,ContentPartSchema,type TelemetryEvent,type ContentPart } from "@observatory/contracts";
import { api,type ClientConfig,stateDir } from "./config.js";

type Row={event_id:string;payload:string};
export class Outbox{
  readonly db:Database;private inflight:Promise<number>|null=null;private contentInflight:Promise<number>|null=null;private timer?:ReturnType<typeof setTimeout>;private backoff=1000;private stopped=false;
  lastError:string|null=null;
  constructor(readonly config:ClientConfig,path=join(stateDir(),"outbox.db"),private fetcher:typeof fetch=fetch){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});chmodSync(dirname(path),0o700);
    this.db=new Database(path,{create:true});chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(acknowledged_at,created_at);
      CREATE TABLE IF NOT EXISTS content(id TEXT PRIMARY KEY,digest TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER);
      CREATE INDEX IF NOT EXISTS content_pending ON content(acknowledged_at,created_at);
      CREATE TABLE IF NOT EXISTS summary_state(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,session_id TEXT NOT NULL);
    `);
  }
  enqueue(value:TelemetryEvent){
    const event=EventSchema.parse(value);
    // Stable identity excludes capture time/runtime for historical replay; live revisions retain their runtime snapshots.
    const digest=createHash("sha256").update(JSON.stringify({installation:event.installationId,kind:event.kind,id:event.entityId,revision:event.revision,data:event.data,historical:event.historical,...(!event.historical?{runtime:event.runtime}: {})})).digest("hex");
    this.db.query("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,NULL)").run(event.eventId,digest,JSON.stringify(event),Date.now());
  }
  enqueueContent(value:ContentPart){
    const part=ContentPartSchema.parse(value);
    const id=[part.installationId,part.sessionId,part.messageId,part.partId,part.kind].join("\u0000");
    const digest=createHash("sha256").update(JSON.stringify(part)).digest("hex");
    this.db.query(`INSERT INTO content(id,digest,payload,created_at,acknowledged_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,payload=excluded.payload,created_at=excluded.created_at,acknowledged_at=NULL
      WHERE excluded.digest<>content.digest`).run(id,digest,JSON.stringify(part),Date.now());
  }
  health(){return {pending:(this.db.query("SELECT count(*) AS n FROM outbox WHERE acknowledged_at IS NULL").get() as {n:number}).n,pendingContent:(this.db.query("SELECT count(*) AS n FROM content WHERE acknowledged_at IS NULL").get() as {n:number}).n,acknowledged:(this.db.query("SELECT count(*) AS n FROM outbox WHERE acknowledged_at IS NOT NULL").get() as {n:number}).n,acknowledgedContent:(this.db.query("SELECT count(*) AS n FROM content WHERE acknowledged_at IS NOT NULL").get() as {n:number}).n,lastError:this.lastError};}
  flush():Promise<number>{
    if(this.inflight)return this.inflight;
    this.inflight=this.send().finally(()=>{this.inflight=null;});return this.inflight;
  }
  flushContent():Promise<number>{
    if(this.contentInflight)return this.contentInflight;
    this.contentInflight=this.sendContent().finally(()=>{this.contentInflight=null;});return this.contentInflight;
  }
  private async send(){
    try{
      const rows=this.db.query("SELECT event_id,payload FROM outbox WHERE acknowledged_at IS NULL ORDER BY created_at,event_id LIMIT 100").all() as Row[];
      if(!rows.length)return 0;
      const result=await api(this.config,"/api/ingest",{events:rows.map(r=>JSON.parse(r.payload))},this.fetcher) as {acknowledged?:unknown};
      if(!Array.isArray(result.acknowledged)||!result.acknowledged.every(v=>typeof v==="string"))throw new Error("Invalid server acknowledgement");
      const expected=new Set(rows.map(r=>r.event_id));let count=0;
      this.db.transaction(()=>{for(const id of result.acknowledged as string[])if(expected.has(id)){this.db.query("UPDATE outbox SET acknowledged_at=? WHERE event_id=? AND acknowledged_at IS NULL").run(Date.now(),id);count++;}})();
      if(!count)throw new Error("Server acknowledged no queued events");
      this.lastError=null;this.backoff=1000;return count;
    }catch(error){this.lastError=error instanceof Error?error.message:"Upload failed";this.backoff=Math.min(this.backoff*2,60000);throw error;}
  }
  private async sendContent(){
    try{
      const candidates=this.db.query("SELECT id,payload FROM content WHERE acknowledged_at IS NULL ORDER BY created_at,id LIMIT 20").all() as {id:string;payload:string}[];
      // Keep a batch under the server's 8 MB body limit even when several long
      // transcript parts are queued.
      const rows:{id:string;payload:string}[]=[];let bytes=0;
      for(const row of candidates){
        const size=Buffer.byteLength(row.payload,"utf8");
        if(rows.length&&bytes+size>6*1024*1024)break;
        rows.push(row);bytes+=size;
      }
      if(!rows.length)return 0;
      const result=await api(this.config,"/api/content",{parts:rows.map(r=>JSON.parse(r.payload))},this.fetcher) as {accepted?:unknown};
      if(typeof result.accepted!=="number"||result.accepted!==rows.length)throw new Error("Invalid content acknowledgement");
      const now=Date.now();
      this.db.transaction(()=>{for(const row of rows)this.db.query("UPDATE content SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL").run(now,row.id);})();
      this.lastError=null;this.backoff=1000;return rows.length;
    }catch(error){this.lastError=error instanceof Error?error.message:"Content upload failed";this.backoff=Math.min(this.backoff*2,60000);throw error;}
  }
  start(){
    if(this.timer)return;
    this.stopped=false;
    const tick=async()=>{
      try{await this.flush();}catch{}
      try{await this.flushContent();}catch{}
      if(this.stopped)return;
      const health=this.health();
      this.timer=setTimeout(tick,this.lastError?this.backoff+Math.random()*1000:health.pending||health.pendingContent?250:5000);this.timer.unref?.();
    };
    this.timer=setTimeout(tick,500);this.timer.unref?.();
  }
  async drain(){while(true){const health=this.health();if(!health.pending&&!health.pendingContent)break;let moved=0;if(health.pending)moved+=await this.flush();if(health.pendingContent)moved+=await this.flushContent();if(!moved)break;}return this.health();}
  replay(){this.db.query("UPDATE outbox SET acknowledged_at=NULL").run();this.db.query("UPDATE content SET acknowledged_at=NULL").run();}
  cursor(source:string){return this.db.query("SELECT updated_at,session_id FROM cursors WHERE source=?").get(source) as {updated_at:number;session_id:string}|null;}
  checkpoint(source:string,updatedAt:number,sessionId:string){this.db.query("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET updated_at=excluded.updated_at,session_id=excluded.session_id").run(source,updatedAt,sessionId);}
  summaryState(sessionId:string){return this.db.query("SELECT revision,status,attempts,error,updated_at FROM summary_state WHERE session_id=?").get(sessionId) as {revision:number;status:string;attempts:number;error:string|null;updated_at:number}|null;}
  setSummaryState(sessionId:string,revision:number,status:"pending"|"running"|"done"|"failed",error:string|null=null){
    this.db.query(`INSERT INTO summary_state(session_id,revision,status,attempts,updated_at,error) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,updated_at=excluded.updated_at,error=excluded.error,
        attempts=CASE WHEN excluded.status='failed' THEN summary_state.attempts+1 WHEN excluded.status='done' THEN 0 ELSE summary_state.attempts END`)
      .run(sessionId,revision,status,status==="failed"?1:0,Date.now(),error);
  }
  summaryCounts(){
    const rows=this.db.query("SELECT status,count(*) AS n FROM summary_state GROUP BY status").all() as {status:string;n:number}[];
    const counts:Record<string,number>={done:0,pending:0,running:0,failed:0};
    for(const row of rows)counts[row.status]=row.n;
    return counts;
  }
  async close(){this.stopped=true;if(this.timer)clearTimeout(this.timer);try{await this.inflight;}catch{}this.db.close();}
}
