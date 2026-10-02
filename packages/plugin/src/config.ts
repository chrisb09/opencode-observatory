import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
export const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(),".config"),"opencode-observatory");
export const stateDir = () => join(process.env.XDG_DATA_HOME ?? join(homedir(),".local","share"),"opencode-observatory");
const ConfigSchema=z.object({
  schemaVersion:z.number().int().optional(),
  url:z.string().url(),apiKey:z.string().min(10),fingerprintSecret:z.string().min(20),userId:z.string().uuid(),installationId:z.string().uuid(),
  machine:z.string().min(1).max(256),autoImport:z.boolean().default(false),enableTools:z.boolean().default(true),
  accounts:z.record(z.string()).default({}),historyDatabase:z.string().optional(),
}).strict();
export type ClientConfig=z.infer<typeof ConfigSchema>;
export async function loadConfig():Promise<ClientConfig|null>{
  try{return ConfigSchema.parse(JSON.parse(await readFile(join(configDir(),"config.json"),"utf8")));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
export async function saveConfig(config:ClientConfig){
  await mkdir(configDir(),{recursive:true,mode:0o700});
  await chmod(configDir(),0o700);
  const path=join(configDir(),"config.json");await writeFile(path,JSON.stringify(ConfigSchema.parse(config),null,2),{mode:0o600});await chmod(path,0o600);
}
export function defaultIdentity(){return {installationId:randomUUID(),machine:`${userInfo().username}@${hostname()}`};}
export function historyPath(){return join(process.env.XDG_DATA_HOME??join(homedir(),".local","share"),"opencode","opencode.db");}
export async function api(config:Pick<ClientConfig,"url"|"apiKey">,path:string,body?:unknown,fetcher:typeof fetch=fetch){
  const response=await fetcher(`${config.url.replace(/\/$/,"")}${path}`,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Observatory server returned HTTP ${response.status}`);
  return response.json();
}
export async function configureObservatory(options: {
  url?: string;
  apiKey: string;
  autoImport?: boolean;
  enableTools?: boolean;
  fetcher?: typeof fetch;
}): Promise<{
  config: ClientConfig;
  hasReadScope: boolean;
  message: string;
}> {
  let targetUrl = (options.url ?? "http://localhost:7692").trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = `http://${targetUrl}`;
  targetUrl = targetUrl.replace(/\/+$/, "");
  const apiKey = options.apiKey.trim();
  if (!apiKey.startsWith("obs_")) {
    throw new Error("Invalid API key format. Observatory telemetry API keys start with 'obs_'.");
  }
  const fetcher = options.fetcher ?? fetch;

  let health: any;
  try {
    const res = await fetcher(`${targetUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = await res.json();
  } catch (err) {
    throw new Error(`Observatory server unreachable at ${targetUrl}: ${(err as Error).message}`);
  }

  let remote: { fingerprintSecret: string; userId: string };
  try {
    remote = await api({ url: targetUrl, apiKey }, "/api/client/config", undefined, fetcher) as { fingerprintSecret: string; userId: string };
  } catch (err) {
    throw new Error(`Authentication failed with Observatory at ${targetUrl}: ${(err as Error).message}. Verify your API key in Observatory Settings.`);
  }

  const existing = await loadConfig();
  if (existing && existing.userId !== remote.userId) {
    throw new Error("This machine was previously configured for a different Observatory user. Clear or update the configuration directory to prevent sending data to a different account.");
  }

  const hasReadScope = await api({ url: targetUrl, apiKey }, "/api/analytics?limit=1", undefined, fetcher).then(() => true).catch(() => false);
  const enableTools = options.enableTools ?? hasReadScope;

  const identity = existing ? { installationId: existing.installationId, machine: existing.machine } : defaultIdentity();
  const config: ClientConfig = {
    url: targetUrl,
    apiKey,
    fingerprintSecret: remote.fingerprintSecret,
    userId: remote.userId,
    installationId: identity.installationId,
    machine: identity.machine,
    accounts: existing?.accounts ?? {},
    autoImport: options.autoImport ?? existing?.autoImport ?? true,
    enableTools,
  };

  await saveConfig(config);

  const message = [
    `✓ OpenCode Observatory connected successfully!`,
    `• Server: ${targetUrl} (v${health.version ?? "0.1.0"})`,
    `• User ID: ${config.userId}`,
    `• Machine: ${config.machine}`,
    `• Ingestion: Active`,
    `• Query tools: ${enableTools ? "Enabled" : "Disabled (requires API key with read scope)"}`,
    `• Past sessions auto-import: ${config.autoImport ? "Enabled" : "Disabled"}`,
  ].join("\n");

  return { config, hasReadScope, message };
}
