import { z } from "zod";

const count = z.number().int().nonnegative().nullable();
const timestamp = z.number().int().nonnegative();
const id = z.string().min(1).max(256);
const short = z.string().max(512);
export const RuntimeSchema = z.object({
  opencode: short.nullable(), opencodeSource: z.enum(["server-health","executable","unknown"]).optional(), collector: short,
  plugins: z.array(z.object({ spec: short, name: short, version: short.nullable(), hash: short.optional(), source: z.enum(["resolved", "declared", "unknown"]) }).strict()).max(100),
  capturedAt: timestamp,
  provenance: z.enum(["capture", "import-current", "historical"]),
}).strict();
export const MetadataSchema = z.object({
  provider: short.nullable().optional(), model: short.nullable().optional(), responseModel: short.nullable().optional(),
  account: short.nullable().optional(), credential: short.nullable().optional(), authType: short.nullable().optional(),
  parentSessionId: id.nullable().optional(), parentMessageId: id.nullable().optional(), agent: short.nullable().optional(), variant: short.nullable().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled", "unknown"]).optional(),
  startedAt: timestamp.optional(), endedAt: timestamp.nullable().optional(),
  durationMs: z.number().nonnegative().nullable().optional(), headerMs: z.number().nonnegative().nullable().optional(), firstOutputMs: z.number().nonnegative().nullable().optional(),
  inputTokens: count.optional(), outputTokens: count.optional(), reasoningTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), totalTokens: count.optional(),
  usageSource: z.enum(["opencode", "provider", "unavailable"]).optional(), usageSemantics: z.enum(["opencode-exclusive-input", "provider-inclusive-input", "unknown"]).optional(),
  outputSemantics: z.enum(["exclusive-reasoning", "inclusive-reasoning", "unknown"]).optional(), accountSource: z.enum(["observed", "configured", "assigned", "unassigned"]).optional(),
  cost: z.number().nonnegative().nullable().optional(), costSource: z.enum(["opencode-estimate", "provider", "unavailable", "override-estimate"]).optional(),
  contextLimit: count.optional(), outputLimit: count.optional(), requestBytes: count.optional(), responseBytes: count.optional(),
  textBytes: count.optional(), reasoningBytes: count.optional(), argumentBytes: count.optional(), outputBytes: count.optional(),
  title: z.string().max(512).nullable().optional(), marketCost: z.number().nonnegative().nullable().optional(),
  tool: short.optional(), callId: id.optional(), finishReason: short.nullable().optional(),
  httpStatus: z.number().int().min(100).max(599).nullable().optional(), retryable: z.boolean().nullable().optional(),
  errorType: short.nullable().optional(), errorCode: short.nullable().optional(), errorMessage: z.string().max(1024).nullable().optional(),
  mime: short.optional(), bytes: count.optional(), width: count.optional(), height: count.optional(), attachmentSource: z.enum(["inline", "local", "remote", "tool"]).optional(),
  requestId: short.nullable().optional(), sessionVersion: short.nullable().optional(),
  purpose: z.enum(["chat", "compaction", "auxiliary", "unknown"]).optional(),
  coverage: z.enum(["lifecycle", "transport", "historical"]).optional(),
}).strict();
export const EventSchema = z.object({
  schemaVersion: z.literal(1), eventId: z.string().uuid(), installationId: z.string().uuid(), instanceId: z.string().uuid(),
  machine: z.string().min(1).max(256), projectId: id.nullable(), sessionId: id.nullable(), messageId: id.nullable(),
  kind: z.enum(["session", "message", "step", "attempt", "tool", "attachment", "text", "error"]), entityId: id,
  observedAt: timestamp, revision: timestamp, historical: z.boolean(), runtime: RuntimeSchema, data: MetadataSchema,
}).strict();
export const BatchSchema = z.object({ events: z.array(EventSchema).min(1).max(100) }).strict();
export const FilterSchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().nonnegative().optional(),
  provider: short.optional(), model: short.optional(), account: short.optional(), credential: short.optional(), machine: short.optional(), sessionId: id.optional(), installationId: z.string().uuid().optional(), projectId: id.optional(), status: short.optional(),
  groupBy: z.enum(["model", "provider", "account", "machine", "agent", "credential"]).default("model"),
  sortBy: z.enum(["observed_at", "entity_id", "model", "provider", "machine", "status", "agent", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "totalTokens", "cost", "marketCost", "durationMs", "tool", "mime", "bytes", "argumentBytes", "outputBytes", "coverage", "error_type", "error_code", "http_status", "occurrences", "sessions", "retryable", "last_seen"]).default("observed_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict().refine(f => f.from === undefined || f.to === undefined || f.to > f.from, "to must be later than from");
export type TelemetryEvent = z.infer<typeof EventSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type Filters = z.infer<typeof FilterSchema>;
export const COLLECTOR_VERSION = "0.1.0";
