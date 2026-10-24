import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { authenticate, HttpError, isAllowedOrigin } from "./security.js";
import { analytics, listEntities, dimensions, machines, errorBreakdown } from "./analytics.js";
import { getSessionSummaries, getSessionTranscript, searchContent } from "./memory.js";
import { listVaultClaims, listVaultConcepts, listVaultConflicts, readVaultLog, readVaultNote, searchVault } from "./vault-service.js";
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
    server.registerTool("search_sessions",{description:"Full-text search across scrubbed session transcripts from every machine. Returns bounded previews, never binary data.",inputSchema:{query:z.string().min(1).max(200),sessionId:z.string().optional(),installationId:z.string().uuid().optional(),kind:z.enum(["prompt","response","reasoning","tool_input","tool_output","media"]).optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().min(0).optional()}},async input=>result(await searchContent(user.id,input)));
    server.registerTool("session_transcript",{description:"Read deduplicated transcript parts for one session. Media is represented by hashes and descriptions.",inputSchema:{sessionId:z.string().min(1),installationId:z.string().uuid().optional(),kinds:z.array(z.enum(["prompt","response","reasoning","tool_input","tool_output","media"])).max(6).optional(),limit:z.number().int().min(1).max(200).optional(),offset:z.number().int().min(0).optional()}},async input=>result(await getSessionTranscript(user.id,input)));
    server.registerTool("session_summaries",{description:"Read model-generated part, message, turn, and session summaries for one session.",inputSchema:{sessionId:z.string().min(1)}},async input=>result(await getSessionSummaries(user.id,input)));
    server.registerTool("vault_concepts",{description:"List knowledge-vault concepts with their repository paths and latest commit.",inputSchema:{}},async()=>result(await listVaultConcepts(user.id)));
    server.registerTool("vault_claims",{description:"Read folded vault claims. Claims carry scope, evidence tier, validity interval, and conflict status.",inputSchema:{concept:z.string().optional(),status:z.enum(["active","superseded","disputed","hypothesis"]).optional(),scope:z.string().optional(),limit:z.number().int().min(1).max(200).optional(),offset:z.number().int().min(0).optional()}},async input=>result(await listVaultClaims(user.id,input)));
    server.registerTool("vault_conflicts",{description:"List open or resolved vault contradictions and evidence-asymmetry disputes.",inputSchema:{concept:z.string().optional(),status:z.enum(["open","resolved","dismissed"]).optional(),limit:z.number().int().min(1).max(200).optional(),offset:z.number().int().min(0).optional()}},async input=>result(await listVaultConflicts(user.id,input)));
    server.registerTool("vault_note",{description:"Read the rendered Markdown note for one concept, including curated prose and claim history.",inputSchema:{concept:z.string().min(1).max(200)}},async input=>result(await readVaultNote(user.id,input)));
    server.registerTool("vault_log",{description:"Read Git history and provenance trailers for the vault or one concept.",inputSchema:{concept:z.string().min(1).max(200).optional(),limit:z.number().int().min(1).max(200).optional()}},async input=>result(await readVaultLog(user.id,input)));
    server.registerTool("search_vault",{description:"Search vault concepts and claims lexically. Use vault_claims or vault_note for full statements.",inputSchema:{query:z.string().min(1).max(200),concept:z.string().min(1).max(200).optional(),limit:z.number().int().min(1).max(50).optional()}},async input=>result(await searchVault(user.id,input)));
    server.registerTool("session_details", {description:"Inspect model steps in a session; installation and runtime versions are returned.",inputSchema:{...args,sessionId:z.string()}},async input=>result(await listEntities(user.id,"step",input)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await transport.handleRequest(request.raw,reply.raw,request.body);
  });
}
