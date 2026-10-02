import { execFileSync } from "node:child_process";
import { readFile,readdir,stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname,join,isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { COLLECTOR_VERSION,type Runtime } from "@observatory/contracts";
import { fingerprint } from "./metadata.js";
import { api, type ClientConfig } from "./config.js";
export async function inventory(specs:Array<string|[string,unknown]>,directory:string,opencode:string|null):Promise<Runtime>{
  specs=[...specs];
  for(const root of [join(directory,".opencode"),join(process.env.XDG_CONFIG_HOME??join(homedir(),".config"),"opencode")])for(const sub of ["plugins","plugin"]){
    try{for(const name of await readdir(join(root,sub)))if(/\.(ts|js)$/.test(name))specs.push(join(root,sub,name));}catch{}
  }
  const plugins:Runtime["plugins"]=[];
  for(const entry of specs.slice(0,100)){
    const spec=typeof entry==="string"?entry:entry[0];let name=spec,version:string|null=null,source:"resolved"|"declared"|"unknown"="unknown";
    const match=spec.match(/^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/);
    if(match){name=match[1]!;if(/^\d+\.\d+\.\d+/.test(match[2]!)){version=match[2]!;source="declared";}}
    const cache=process.env.XDG_CACHE_HOME??join(homedir(),".cache"),userConfig=process.env.XDG_CONFIG_HOME??join(homedir(),".config");
    const roots=[directory,join(cache,"opencode"),join(userConfig,"opencode")];
    let candidates:string[]=[];
    if(spec.startsWith("file:")){let path=fileURLToPath(spec);try{if((await stat(path)).isFile())path=dirname(path);}catch{}for(let depth=0;depth<6;depth++){candidates.push(join(path,"package.json"));const next=dirname(path);if(next===path)break;path=next;}}
    else if(isAbsolute(spec)||spec.startsWith(".")){let path=isAbsolute(spec)?spec:join(directory,spec);try{if((await stat(path)).isFile())path=dirname(path);}catch{}for(let depth=0;depth<6;depth++){candidates.push(join(path,"package.json"));const next=dirname(path);if(next===path)break;path=next;}}
    else candidates=roots.flatMap(root=>[join(root,"node_modules",name,"package.json"),join(root,"node_modules",name.split("/").join("+"),"package.json")]);
    for(const path of candidates){try{const pkg=JSON.parse(await readFile(path,"utf8"));if(typeof pkg.version==="string"){name=pkg.name??name;version=pkg.version;source="resolved";break;}}catch{}}
    let fileHash:string|undefined;
    if(isAbsolute(spec)||spec.startsWith(".")||spec.startsWith("file:")){try{fileHash=createHash("sha256").update(await readFile(spec.startsWith("file:")?fileURLToPath(spec):isAbsolute(spec)?spec:join(directory,spec))).digest("hex");}catch{}}
    plugins.push({spec:spec.slice(0,512),name:name.slice(0,512),version:version?.slice(0,512)??null,source,...(fileHash?{hash:fileHash}:{})});
  }
  for(const name of ["builtin:openai-auth","builtin:github-copilot-auth"])plugins.push({spec:name,name,version:opencode,source:opencode?"resolved":"unknown"});
  plugins.splice(100);
  return {opencode,collector:COLLECTOR_VERSION,plugins,capturedAt:Date.now(),provenance:"capture"};
}
export function detectVersion(){
  try{return execFileSync("opencode",["--version"],{encoding:"utf8",timeout:5000,stdio:["ignore","pipe","ignore"]}).trim().slice(0,512);}catch{return null;}
}
export async function syncLocalAccounts(config: ClientConfig, fetcher: typeof fetch = fetch) {
  try {
    const userConfigDir = process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
    const dataDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), opencodeDataDir = join(dataDir, "opencode");

    // 1. Antigravity accounts (Google emails)
    try {
      const antigravityPath = join(userConfigDir, "antigravity-accounts.json");
      const data = JSON.parse(await readFile(antigravityPath, "utf8"));
      for (const a of data.accounts ?? []) {
        if (a.email) {
          const fp = fingerprint(config.fingerprintSecret, `google:${a.email}`);
          await api(config, "/api/aliases", { fingerprint: fp, alias: a.email }, fetcher).catch(() => {});
          if (a.refreshToken) {
            const fpToken = fingerprint(config.fingerprintSecret, `google:${a.refreshToken}`);
            await api(config, "/api/aliases", { fingerprint: fpToken, alias: a.email }, fetcher).catch(() => {});
          }
        }
      }
    } catch {}

    // 2. OpenCode auth.json (OpenAI, Google, etc.)
    try {
      const authPath = join(opencodeDataDir, "auth.json");
      const auth = JSON.parse(await readFile(authPath, "utf8"));
      if (auth.openai?.accountId) {
        const fp = fingerprint(config.fingerprintSecret, `openai:${auth.openai.accountId}`);
        await api(config, "/api/aliases", { fingerprint: fp, alias: "ChatGPT Account" }, fetcher).catch(() => {});
      }
    } catch {}
  } catch {}
}
