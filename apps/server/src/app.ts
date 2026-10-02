import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { pool, tenant } from "./db.js";
import { authenticate, browserUser, checkOrigin, createUser, decrypt, encrypt, hash, HttpError, passwordHash, passwordValid, token, validateSecurityConfig } from "./security.js";
import { ingest } from "./ingest.js";
import { analytics, listEntities, dimensions, machines, errorBreakdown } from "./analytics.js";
import { registerMcp } from "./mcp.js";
import { invalidateAnalytics } from "./cache.js";

const credentials = z.object({ email:z.string().email().max(254).transform(v=>v.toLowerCase().trim()),password:z.string().min(12).max(256) }).strict();
export async function buildApp(logger = true) {
  validateSecurityConfig();
  const app = Fastify({ logger: logger ? { redact: ["req.headers.authorization","req.headers.cookie","res.headers.set-cookie"] } : false, bodyLimit: 2*1024*1024, trustProxy: process.env.TRUST_PROXY === "true" });
  await app.register(cookie);
  await app.register(rateLimit,{max:600,timeWindow:"1 minute"});
  app.addHook("onRequest",async request=>{checkOrigin(request);});
  app.addHook("onSend",async(_request,reply)=>{
    reply.header("X-Content-Type-Options","nosniff").header("Referrer-Policy","same-origin");
    reply.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    reply.header("Cache-Control","no-store");
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:"Invalid input",details:error.issues.map(x=>({path:x.path,message:x.message}))});
    const detail = error instanceof Error ? error : new Error("Unknown error");
    const status = error instanceof HttpError ? error.statusCode : (detail as {statusCode?:number}).statusCode ?? 500;
    if(status>=500) request.log.error({message:detail.message},"Request failed");
    return reply.code(status).send({error:status>=500?"Internal server error":detail.message});
  });
  app.get("/api/health",async()=>{await pool.query("SELECT 1");return {ok:true,version:"0.1.0"};});
  app.post("/api/auth/login",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async(request,reply)=>{
    const input=credentials.parse(request.body), {rows}=await pool.query("SELECT * FROM users WHERE email=$1",[input.email]);
    const user=rows[0];
    if(!user || !(await passwordValid(input.password,user.password_hash))) throw new HttpError(401,"Invalid email or password");
    const session=token();
    await pool.query("DELETE FROM login_sessions WHERE expires_at<now()");
    await pool.query("INSERT INTO login_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[hash(session),user.id]);
    const isHttps = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    reply.setCookie("obs_session",session,{httpOnly:true,sameSite:"lax",secure:isHttps,path:"/",maxAge:604800});
    return {id:user.id,email:user.email,admin:user.admin};
  });
  app.post("/api/auth/logout",async(request,reply)=>{
    await pool.query("DELETE FROM login_sessions WHERE token_hash=$1",[hash(request.cookies.obs_session??"")]);reply.clearCookie("obs_session",{path:"/"});return {ok:true};
  });
  app.get("/api/auth/me",async request=>browserUser(request));
  app.post("/api/auth/accept-invite",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async request=>{
    const input=credentials.extend({invite:z.string().min(20).max(100)}).parse(request.body),db=await pool.connect();
    try{
      await db.query("BEGIN");
      const {rows}=await db.query("SELECT * FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",[hash(input.invite)]);
      if(!rows[0] || rows[0].email!==input.email) throw new HttpError(400,"Invitation is invalid or expired");
      if((await db.query("SELECT 1 FROM users WHERE email=$1",[input.email])).rowCount) throw new HttpError(409,"An account already exists");
      await createUser(input.email,input.password,false,db as any);
      await db.query("UPDATE invitations SET used_at=now() WHERE token_hash=$1",[hash(input.invite)]);
      await db.query("COMMIT");return {ok:true};
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  });
  app.post("/api/invitations",async request=>{
    const user=await browserUser(request);if(!user.admin) throw new HttpError(403,"Administrator required");
    const {email}=credentials.pick({email:true}).parse(request.body),invite=token();
    await pool.query("INSERT INTO invitations(token_hash,email,created_by,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[hash(invite),email,user.id]);
    return {url:`${process.env.PUBLIC_URL??"http://localhost:7692"}/?invite=${invite}`,expiresInDays:7};
  });
  app.post("/api/auth/password",async request=>{
    const user=await browserUser(request),input=z.object({current:z.string().max(256),password:z.string().min(12).max(256)}).strict().parse(request.body);
    const {rows}=await pool.query("SELECT password_hash FROM users WHERE id=$1",[user.id]);
    if(!await passwordValid(input.current,rows[0].password_hash)) throw new HttpError(403,"Incorrect password");
    await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1",[user.id,await passwordHash(input.password)]);
    await pool.query("DELETE FROM login_sessions WHERE user_id=$1 AND token_hash<>$2",[user.id,hash(request.cookies.obs_session??"")]);return {ok:true};
  });
  app.get("/api/keys",async request=>{
    const user=await browserUser(request);return (await pool.query("SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC",[user.id])).rows;
  });
  app.post("/api/keys",async request=>{
    const user=await browserUser(request),input=z.object({name:z.string().min(1).max(100),scopes:z.array(z.enum(["ingest","read"])).min(1).max(2)}).strict().parse(request.body);
    const id=randomUUID(),key=`obs_${token()}`;
    await pool.query("INSERT INTO api_keys(id,user_id,name,token_hash,encrypted_token,scopes) VALUES($1,$2,$3,$4,$5,$6)",[id,user.id,input.name,hash(key),encrypt(key),input.scopes]);return {id,key};
  });
  app.post<{Params:{id:string}}>("/api/keys/:id/reveal",async request=>{
    const user=await browserUser(request),{password}=z.object({password:z.string().max(256)}).strict().parse(request.body);
    const {rows}=await pool.query("SELECT password_hash FROM users WHERE id=$1",[user.id]);
    if(!await passwordValid(password,rows[0].password_hash)) throw new HttpError(403,"Incorrect password");
    const key=await pool.query("SELECT encrypted_token FROM api_keys WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL",[user.id,z.string().uuid().parse(request.params.id)]);
    if(!key.rows[0]) throw new HttpError(404,"API key not found");return {key:decrypt(key.rows[0].encrypted_token)};
  });
  app.delete<{Params:{id:string}}>("/api/keys/:id",async request=>{
    const user=await browserUser(request);await pool.query("UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND id=$2",[user.id,z.string().uuid().parse(request.params.id)]);return {ok:true};
  });
  app.get("/api/client/config",async request=>{
    const user=await authenticate(request,"ingest"),{rows}=await pool.query("SELECT fingerprint_secret FROM users WHERE id=$1",[user.id]);
    return {fingerprintSecret:decrypt(rows[0].fingerprint_secret),schemaVersion:1,userId:user.id};
  });
  app.post("/api/ingest",async request=>ingest((await authenticate(request,"ingest")).id,request.body));
  app.get("/api/analytics",async request=>analytics((await authenticate(request,"read")).id,request.query));
  app.get("/api/dimensions",async request=>dimensions((await authenticate(request,"read")).id));
  app.get("/api/machines",async request=>machines((await authenticate(request,"read")).id));
  app.get("/api/errors",async request=>errorBreakdown((await authenticate(request,"read")).id,request.query));
  app.get<{Params:{kind:string}}>("/api/entities/:kind",async request=>{
    const kind=z.enum(["session","message","step","attempt","tool","attachment","text","error"]).parse(request.params.kind);
    return listEntities((await authenticate(request,"read")).id,kind,request.query);
  });
  app.get("/api/aliases",async request=>{const user=await authenticate(request,"read");return tenant(user.id,async db=>(await db.query("SELECT fingerprint,alias FROM account_aliases WHERE user_id=$1",[user.id])).rows);});
  app.post("/api/aliases",async request=>{
    const user=await authenticate(request),input=z.object({fingerprint:z.string().min(1).max(512),alias:z.string().min(1).max(100)}).strict().parse(request.body);
    await tenant(user.id,async db=>{await db.query("INSERT INTO account_aliases VALUES($1,$2,$3) ON CONFLICT(user_id,fingerprint) DO UPDATE SET alias=EXCLUDED.alias",[user.id,input.fingerprint,input.alias]);});
    invalidateAnalytics(user.id); return {ok:true};
  });
  app.get("/api/account-assignments",async request=>{const user=await authenticate(request);return tenant(user.id,async db=>(await db.query("SELECT * FROM account_assignments WHERE user_id=$1 ORDER BY from_time DESC",[user.id])).rows);});
  app.post("/api/account-assignments",async request=>{
    const user=await authenticate(request),input=z.object({provider:z.string().min(1).max(512),installationId:z.string().uuid().nullable().default(null),from:z.number().int().nonnegative(),to:z.number().int().nonnegative().nullable().default(null),label:z.string().min(1).max(100)}).strict().refine(x=>x.to===null||x.to>x.from,"End must be after start").parse(request.body);
    const id=randomUUID();await tenant(user.id,async db=>{const prior=await db.query("SELECT account FROM account_assignments WHERE user_id=$1 AND provider=$2 AND label=$3 LIMIT 1",[user.id,input.provider,input.label]);await db.query("INSERT INTO account_assignments VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,user.id,input.provider,input.installationId,input.from,input.to,prior.rows[0]?.account??`assigned:${id}`,input.label]);});
    invalidateAnalytics(user.id);return {id};
  });
  app.delete<{Params:{id:string}}>("/api/account-assignments/:id",async request=>{const user=await authenticate(request);await tenant(user.id,async db=>{await db.query("DELETE FROM account_assignments WHERE user_id=$1 AND id=$2",[user.id,z.string().uuid().parse(request.params.id)]);});invalidateAnalytics(user.id);return {ok:true};});
  app.get("/api/prices",async request=>{const user=await authenticate(request,"read");return tenant(user.id,async db=>(await db.query("SELECT * FROM prices WHERE user_id=$1 ORDER BY effective_at DESC",[user.id])).rows);});
  app.post("/api/prices",async request=>{
    const user=await browserUser(request),input=z.object({provider:z.string().min(1).max(512),model:z.string().min(1).max(512),account:z.string().max(512).nullable().default(null),effectiveAt:z.number().int().nonnegative(),input:z.number().nonnegative(),output:z.number().nonnegative(),cacheRead:z.number().nonnegative(),cacheWrite:z.number().nonnegative()}).strict().parse(request.body);
    const id=randomUUID();await tenant(user.id,async db=>{await db.query("INSERT INTO prices(id,user_id,provider,model,account,effective_at,input,output,cache_read,cache_write) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,user.id,input.provider,input.model,input.account,input.effectiveAt,input.input,input.output,input.cacheRead,input.cacheWrite]);});invalidateAnalytics(user.id);return {id};
  });
  app.get<{Params:{kind:string}}>("/api/export/:kind",async(request,reply)=>{
    const kind=z.enum(["step","attempt","tool","session","error","attachment"]).parse(request.params.kind),user=await authenticate(request,"read"),rows=kind==="error"?await errorBreakdown(user.id,request.query):await listEntities(user.id,kind,request.query);
    reply.header("Content-Disposition",`attachment; filename="observatory-${kind}.json"`);return rows;
  });
  await registerMcp(app);
  const web=resolve(process.env.WEB_ROOT??"apps/web/dist");
  if(existsSync(web)){
    await app.register(staticFiles,{root:web,index:"index.html",dotfiles:"deny"});
    app.setNotFoundHandler((request,reply)=>request.url.startsWith("/api/")||request.url.startsWith("/mcp")?reply.code(404).send({error:"Not found"}):reply.sendFile("index.html"));
  }
  return app;
}
