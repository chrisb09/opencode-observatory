import { migrate, pool } from "./db.js";
import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./security.js";
await migrate();
await bootstrapAdmin();
const app=await buildApp();
await app.listen({port:Number(process.env.PORT??7692),host:process.env.HOST??"0.0.0.0"});
for(const signal of ["SIGINT","SIGTERM"] as const) process.on(signal,()=>{void app.close().then(()=>pool.end()).then(()=>process.exit(0));});
