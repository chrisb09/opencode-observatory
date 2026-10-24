import { z } from "zod";

const id = z.string().min(1).max(256);
const short = z.string().max(512);
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

/** Lowercase sha256 with an algorithm prefix; stable across machines. */
export const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Media is never uploaded. Clients record a content hash plus the metadata a
 * model or human needs in order to reason about the attachment.
 */
export const MediaSchema = z
  .object({
    contentHash: ContentHashSchema,
    mime: short,
    bytes: count.nullable(),
    width: count.nullable().optional(),
    height: count.nullable().optional(),
    filename: short.nullable().optional(),
    availability: z.enum(["inline", "local", "remote", "tool", "local_missing"]),
    visualKind: z
      .enum(["ui_screenshot", "terminal", "chart", "diagram", "document", "photo", "other"])
      .nullable()
      .optional(),
    description: z.string().max(4000).nullable().optional(),
    extractedText: z.string().max(20000).nullable().optional(),
    descriptorSource: z.enum(["vision", "context_inferred", "none"]).optional(),
    generatorModel: short.nullable().optional(),
  })
  .strict();

/**
 * One deduplicated transcript part. `kind` intentionally separates prompt text
 * from reasoning text so a tenant can delete one class without losing the other.
 */
export const ContentPartSchema = z
  .object({
    installationId: z.string().uuid(),
    sessionId: id,
    messageId: id,
    partId: id,
    kind: z.enum(["prompt", "response", "reasoning", "tool_input", "tool_output", "media"]),
    role: z.enum(["user", "assistant", "tool", "system"]).nullable(),
    text: z.string().max(1_000_000),
    /** sha256 of the scrubbed text, or of the descriptor for media parts. */
    contentHash: ContentHashSchema,
    truncated: z.boolean().default(false),
    originalBytes: count.nullable().default(null),
    observedAt: timestamp,
    media: MediaSchema.nullable().optional(),
  })
  .strict();

export const ContentBatchSchema = z.object({ parts: z.array(ContentPartSchema).min(1).max(20) }).strict();

/** A model-generated digest for one part, message, turn, or whole session. */
export const SummarySchema = z
  .object({
    installationId: z.string().uuid(),
    sessionId: id,
    targetKind: z.enum(["part", "message", "turn", "session"]),
    targetId: id,
    summaryShort: z.string().min(1).max(2000),
    summaryDetailed: z.string().max(20000),
    keyDecisions: z.array(z.string().max(500)).max(50).default([]),
    filesTouched: z.array(z.string().max(512)).max(200).default([]),
    concepts: z.array(z.string().max(200)).max(50).default([]),
    generatorModel: short,
    promptVersion: short,
    sourceHash: ContentHashSchema,
  })
  .strict();

export const EvidenceRefSchema = z
  .object({
    installationId: z.string().uuid(),
    sessionId: id,
    messageId: id.nullable().optional(),
    partId: id.nullable().optional(),
    tool: short.nullable().optional(),
    url: z.string().max(2048).nullable().optional(),
    observedAt: timestamp,
  })
  .strict();

/**
 * A candidate claim emitted by the session extractor. `subject` is the stable
 * key the model reuses for the same assertion ("slurm.gpu.binding_flag"), which
 * lets the vault compare claims without semantic string matching.
 */
export const ClaimCandidateSchema = z
  .object({
    concept: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,199}$/),
    subject: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/),
    statement: z.string().min(8).max(4000),
    polarity: z.enum(["affirm", "deny"]),
    modality: z.enum(["fact", "decision", "hypothesis"]),
    scope: z.enum(["global", "project", "machine"]),
    scopeValue: short.nullable().default(null),
    evidenceTier: z.enum(["tool_verified", "user_stated", "external_reference", "assistant_assertion"]),
    singleValued: z.boolean().default(true),
    evidence: z.array(EvidenceRefSchema).min(1).max(32),
    contradicts: z.array(id).max(16).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope !== "global" && !value.scopeValue) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeValue"], message: "scopeValue is required for project and machine scopes" });
    }
    if (value.scope === "global" && value.scopeValue !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeValue"], message: "scopeValue must be null for global scope" });
    }
  });

export const ClaimBatchSchema = z.object({ claims: z.array(ClaimCandidateSchema).min(1).max(64) }).strict();

/** Client → server envelope for a vault extraction pass. */
export const VaultApplySchema = z
  .object({
    claims: z.array(ClaimCandidateSchema).min(1).max(64),
    source: z
      .object({
        installationId: z.string().uuid().optional(),
        machine: short.optional(),
        rootSessionId: id.optional(),
        evidenceSessionId: id.optional(),
        messageIds: z.array(id).max(64).optional(),
        agent: short.optional(),
        model: short.optional(),
        promptVersion: short.optional(),
        evidenceTier: z.enum(["tool_verified", "user_stated", "external_reference", "assistant_assertion"]).optional(),
      })
      .strict()
      .optional(),
    message: z.string().max(200).optional(),
  })
  .strict();

export type Media = z.infer<typeof MediaSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type ClaimCandidate = z.infer<typeof ClaimCandidateSchema>;
export type ClaimPolarity = ClaimCandidate["polarity"];
export type ClaimModality = ClaimCandidate["modality"];
export type EvidenceTier = ClaimCandidate["evidenceTier"];
export type ClaimScopeKind = ClaimCandidate["scope"];
