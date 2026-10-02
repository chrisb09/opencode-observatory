const url=new URL(process.env.DATABASE_URL??"");
if(!["127.0.0.1","localhost"].includes(url.hostname))throw new Error("Local integration tests require a localhost database URL");
url.pathname="/observatory_test";
const child=Bun.spawn(["bun","test","tests"],{env:{...process.env,TEST_DATABASE_URL:url.toString()},stdout:"inherit",stderr:"inherit"});
process.exitCode=await child.exited;
