import { createInterface } from "node:readline/promises";
import { stdin,stdout } from "node:process";
import { migrate,pool } from "./db.js";
import { createUser,passwordHash,validateSecurityConfig } from "./security.js";
import { z } from "zod";
validateSecurityConfig();await migrate();
const rl=createInterface({input:stdin,output:stdout});
try{
  const email=z.string().email().parse((process.env.ADMIN_EMAIL??await rl.question("Admin email: ")).trim().toLowerCase());
  const password=z.string().min(12).max(256).parse(process.env.ADMIN_PASSWORD??await rl.question("Password (12+ characters; visible input): "));
  if(process.argv.includes("--reset")){
    const result=await pool.query("UPDATE users SET password_hash=$2 WHERE email=$1",[email,await passwordHash(password)]);
    if(!result.rowCount) throw new Error("User not found");
    await pool.query("DELETE FROM login_sessions WHERE user_id=(SELECT id FROM users WHERE email=$1)",[email]);
    console.log("Password reset; sessions invalidated.");
  }else{
    if((await pool.query("SELECT 1 FROM users WHERE admin=true LIMIT 1")).rowCount)throw new Error("An administrator already exists. Create additional accounts with an invitation.");
    await createUser(email,password,true);console.log("Administrator created.");
  }
}finally{rl.close();await pool.end();}
