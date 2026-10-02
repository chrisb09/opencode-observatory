#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin,stdout } from "node:process";
import { loadConfig,saveConfig,defaultIdentity,api,configureObservatory } from "./config.js";
import { Outbox } from "./outbox.js";
import { Collector } from "./metadata.js";
import { inventory,detectVersion } from "./runtime.js";
import { importHistory } from "./history.js";
const command=process.argv[2]??"status";
try{
  let config=await loadConfig();
  if(command==="setup"){
    const rl=createInterface({input:stdin,output:stdout});
    try{
      const rawUrl=process.env.OBSERVATORY_URL??((await rl.question(`Server URL [${config?.url??"http://localhost:7692"}]: `))||config?.url||"http://localhost:7692");
      const apiKey=process.env.OBSERVATORY_API_KEY??await rl.question("Observatory API key (visible input): ");
      const autoImport=(await rl.question("Automatically import past sessions on startup? [y/N]: ")).toLowerCase()==="y";
      const enableTools=(await rl.question("Enable in-OpenCode statistics tools? [Y/n]: ")).toLowerCase()!=="n";
      const result=await configureObservatory({url:rawUrl,apiKey,autoImport,enableTools});
      console.log(result.message);
      console.log("Add the plugin to OpenCode, then quit and restart OpenCode. Run 'opencode-observatory import' to import history now.");
    }finally{rl.close();}
  }else{
    if(!config)throw new Error("Run opencode-observatory setup first.");
    const outbox=new Outbox(config);
    try{
      if(command==="import"){
        const index=process.argv.indexOf("--database");const path=index!==-1?process.argv[index+1]:undefined;
        if(index!==-1&&!path)throw new Error("--database requires a SQLite path");
        const collector=new Collector(config,await inventory([],process.cwd(),detectVersion()),event=>outbox.enqueue(event));
        const result=await importHistory(collector,outbox,path,{all:process.argv.includes("--all"),onProgress:n=>{if(n%100===0)console.log(`Queued ${n} sessions`);}});
        console.log(JSON.stringify(result,null,2));
        try{console.log(JSON.stringify(await outbox.drain(),null,2));}catch(err){console.error(`Upload paused: ${outbox.lastError??(err instanceof Error?err.message:String(err))}. Imported metadata remains queued; run flush later or start OpenCode.`);}
      }else if(command==="flush"){try{console.log(JSON.stringify(await outbox.drain(),null,2));}catch(err){console.error(`Flush paused: ${outbox.lastError??(err instanceof Error?err.message:String(err))}`);}}
      else if(command==="replay"){outbox.replay();console.log("All retained metadata is pending again. Run flush to replay it.");}
      else if(command==="status")console.log(JSON.stringify(outbox.health(),null,2));
      else if(command==="mcp-config")console.log(JSON.stringify({$schema:"https://opencode.ai/config.json",mcp:{observatory:{type:"remote",url:`${config.url.replace(/\/$/,"")}/mcp`,oauth:false,headers:{Authorization:"Bearer {env:OBSERVATORY_API_KEY}"}}}},null,2));
      else throw new Error("Commands: setup, status, import [--all] [--database PATH], flush, replay, mcp-config");
    }finally{await outbox.close();}
  }
}catch(error){console.error(error instanceof Error?error.message:"Operation failed");process.exitCode=1;}
