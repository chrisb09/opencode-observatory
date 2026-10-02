import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const password=randomBytes(24).toString("hex"),bootstrap=randomBytes(24).toString("hex"),key=randomBytes(32).toString("hex");
try{
  await writeFile(".env",`POSTGRES_PASSWORD=${bootstrap}\nAPP_DB_PASSWORD=${password}\nENCRYPTION_KEY=${key}\nPUBLIC_URL=http://localhost:7692\nDATABASE_URL=postgresql://observatory_app:${password}@127.0.0.1:7693/observatory\nPORT=7692\n`,{flag:"wx",mode:0o600});
  console.log("Created .env with random secrets. Set PUBLIC_URL to your externally accessible URL before deployment.");
}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")console.log(".env already exists; it was preserved.");else throw error;}
