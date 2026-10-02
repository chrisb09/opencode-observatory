import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { Collector } from "./metadata.js";
import { Outbox } from "./outbox.js";
import { historyPath } from "./config.js";
export async function importHistory(collector:Collector,outbox:Outbox,path=collector.config.historyDatabase??historyPath(),options:{all?:boolean;onProgress?:(sessions:number)=>void}={}){
  const db=new Database(path,{readonly:true});let sessions=0;
  const source=resolve(path);let cursor=options.all?null:outbox.cursor(source);
  const cols=new Set((db.query("PRAGMA table_info(session)").all() as any[]).map(c=>c.name));
  const has=(c:string)=>cols.has(c)?c:`NULL AS ${c}`;
  const selectQuery=`SELECT id,project_id,parent_id,version,time_created,time_updated,${has("agent")},${has("model")},${has("cost")},${has("tokens_input")},${has("tokens_output")},${has("tokens_reasoning")},${has("tokens_cache_read")},${has("tokens_cache_write")} FROM session WHERE (time_updated>? OR (time_updated=? AND id>?)) ORDER BY time_updated,id LIMIT 25`;
  try{
    for(;;){
      const rows=db.query(selectQuery).all(cursor?.updated_at??0,cursor?.updated_at??0,cursor?.session_id??"") as any[];
      if(!rows.length)break;
      for(const session of rows){
        // A read transaction yields a consistent session snapshot while OpenCode continues writing in WAL mode.
        db.transaction(()=>outbox.db.transaction(()=>{
          collector.session(session,true,session.time_updated);
          const messages=db.query("SELECT id,data,time_updated FROM message WHERE session_id=? ORDER BY time_created,id").all(session.id) as any[];
          for(const row of messages){
            const info={...JSON.parse(row.data),id:row.id,sessionID:session.id};collector.message(info,true,row.time_updated);
            const parts=db.query("SELECT id,data,time_updated FROM part WHERE message_id=? ORDER BY time_created,id").all(row.id) as any[];
            for(const part of parts)collector.part({...JSON.parse(part.data),id:part.id,messageID:row.id,sessionID:session.id},true,part.time_updated);
            collector.messages.delete(row.id);
          }
          outbox.checkpoint(source,session.time_updated,session.id);
        })())();
        cursor={updated_at:session.time_updated,session_id:session.id};collector.sessions.delete(session.id);
        sessions++;options.onProgress?.(sessions);
      }
      // Yield to live requests between batches. Importing is local and does not depend on server availability.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {sessions,...outbox.health()};
  }finally{db.close();}
}
