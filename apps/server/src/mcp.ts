import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { authenticate, HttpError, isAllowedOrigin } from "./security.js";
import { analytics, listEntities, dimensions, machines, errorBreakdown } from "./analytics.js";
const args = {
  from: z.number().optional(), to: z.number().optional(), provider: z.string().optional(), model: z.string().optional(),
  account: z.string().optional(), credential:z.string().optional(), machine: z.string().optional(), sessionId: z.string().optional(), installationId:z.string().uuid().optional(),
  groupBy: z.enum(["model","provider","account","machine","agent","credential"]).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(),
};
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export async function registerMcp(app: FastifyInstance) {
  app.post("/mcp", async (request, reply) => {
    if (!request.headers.authorization?.startsWith("Bearer ")) throw new HttpError(401,"MCP requires a scoped API key");
    const user = await authenticate(request,"read");
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin, request.headers.host)) throw new HttpError(403,"Invalid MCP origin");
    const server = new McpServer({ name: "opencode-observatory", version: "0.1.0" });
    for (const name of ["usage_summary","usage_timeseries","compare_models"])
      server.registerTool(name, { description: "Read your OpenCode usage. UTC millisecond timestamps, exclusive end time; null means unavailable. Costs are labeled estimates.", inputSchema: args }, async input => result(await analytics(user.id,input)));
    server.registerTool("list_accounts", {description:"List observed provider/account/key dimensions; credentials are one-way fingerprints.",inputSchema:{}},async()=>result(await dimensions(user.id)));
    server.registerTool("list_machines", {description:"List your installations and their recorded version inventories.",inputSchema:{}},async()=>result(await machines(user.id)));
    for (const [name,kind] of [["list_sessions","session"],["request_attempts","attempt"],["tool_executions","tool"]] as const)
      server.registerTool(name,{description:`Read your ${kind} metadata with bounded pagination.`,inputSchema:args},async input=>result(await listEntities(user.id,kind,input)));
    server.registerTool("error_breakdown",{description:"Aggregate sanitized failed model-call attempts by error category, provider, model, status, and retryability.",inputSchema:args},async input=>result(await errorBreakdown(user.id,input)));
    server.registerTool("session_details", {description:"Inspect model steps in a session; installation and runtime versions are returned.",inputSchema:{...args,sessionId:z.string()}},async input=>result(await listEntities(user.id,"step",input)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await transport.handleRequest(request.raw,reply.raw,request.body);
  });
}
