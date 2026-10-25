import { z } from "zod";
import { type ClientConfig } from "./config.js";
import type { Outbox } from "./outbox.js";
/**
 * Client-side digest worker. It runs only in the V2 plugin, where
 * `ctx.generate.text` provides a one-shot model call. Transcripts are read from
 * the local OpenCode V2 projections and never leave the machine as part of the
 * prompt; only the resulting summaries and claims are posted to Observatory.
 */
export declare const SUMMARY_PROMPT_VERSION = "v1";
export declare const SUMMARY_MARKER = "[observatory-summary]";
export interface ModelSpec {
    providerID: string;
    id: string;
    variant?: string;
}
export interface SummaryDependencies {
    config: ClientConfig;
    outbox: Outbox;
    directory: string;
    projectId: string | null;
    generate?: (input: {
        prompt: string;
        model: ModelSpec;
    }) => Promise<{
        text: string;
    }>;
    fetcher?: typeof fetch;
    log?: (message: string) => void;
}
export interface SummaryBatchOptions {
    limit?: number;
    sessionId?: string;
    force?: boolean;
    signal?: AbortSignal;
}
export interface SummaryBatchResult {
    processed: number;
    skipped: number;
    failures: number;
    done: number;
    pending: number;
    running: number;
    failed: number;
    errors: string[];
}
interface HistorySession {
    id: string;
    project_id: string | null;
    parent_id: string | null;
    directory: string | null;
    title: string | null;
    agent: string | null;
    model: string | null;
    time_created: number;
    time_updated: number;
}
interface HistoryMessage {
    id: string;
    type: string;
    seq: number;
    time_updated: number;
    data: string;
}
declare const DigestSchema: z.ZodObject<{
    messages: z.ZodDefault<z.ZodArray<z.ZodObject<{
        messageId: z.ZodString;
        kind: z.ZodEnum<["prompt", "response", "reasoning", "tool", "turn"]>;
        summaryShort: z.ZodString;
        summaryDetailed: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "tool" | "prompt" | "response" | "reasoning" | "turn";
        messageId: string;
        summaryShort: string;
        summaryDetailed: string;
    }, {
        kind: "tool" | "prompt" | "response" | "reasoning" | "turn";
        messageId: string;
        summaryShort: string;
        summaryDetailed?: string | undefined;
    }>, "many">>;
    session: z.ZodObject<{
        summaryShort: z.ZodString;
        summaryDetailed: z.ZodDefault<z.ZodString>;
        keyDecisions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        filesTouched: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        concepts: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        summaryShort: string;
        summaryDetailed: string;
        keyDecisions: string[];
        filesTouched: string[];
        concepts: string[];
    }, {
        summaryShort: string;
        summaryDetailed?: string | undefined;
        keyDecisions?: string[] | undefined;
        filesTouched?: string[] | undefined;
        concepts?: string[] | undefined;
    }>;
    claims: z.ZodDefault<z.ZodArray<z.ZodObject<{
        concept: z.ZodString;
        subject: z.ZodString;
        statement: z.ZodString;
        polarity: z.ZodDefault<z.ZodEnum<["affirm", "deny"]>>;
        modality: z.ZodDefault<z.ZodEnum<["fact", "decision", "hypothesis"]>>;
        scope: z.ZodDefault<z.ZodEnum<["global", "project", "machine"]>>;
        scopeValue: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        evidenceTier: z.ZodDefault<z.ZodEnum<["tool_verified", "user_stated", "external_reference", "assistant_assertion"]>>;
        singleValued: z.ZodDefault<z.ZodBoolean>;
        messageIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        contradicts: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        concept: string;
        subject: string;
        statement: string;
        polarity: "affirm" | "deny";
        modality: "fact" | "decision" | "hypothesis";
        scope: "machine" | "global" | "project";
        scopeValue: string | null;
        evidenceTier: "tool_verified" | "user_stated" | "external_reference" | "assistant_assertion";
        singleValued: boolean;
        messageIds: string[];
        contradicts: string[];
    }, {
        concept: string;
        subject: string;
        statement: string;
        polarity?: "affirm" | "deny" | undefined;
        modality?: "fact" | "decision" | "hypothesis" | undefined;
        scope?: "machine" | "global" | "project" | undefined;
        scopeValue?: string | null | undefined;
        evidenceTier?: "tool_verified" | "user_stated" | "external_reference" | "assistant_assertion" | undefined;
        singleValued?: boolean | undefined;
        messageIds?: string[] | undefined;
        contradicts?: string[] | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    session: {
        summaryShort: string;
        summaryDetailed: string;
        keyDecisions: string[];
        filesTouched: string[];
        concepts: string[];
    };
    messages: {
        kind: "tool" | "prompt" | "response" | "reasoning" | "turn";
        messageId: string;
        summaryShort: string;
        summaryDetailed: string;
    }[];
    claims: {
        concept: string;
        subject: string;
        statement: string;
        polarity: "affirm" | "deny";
        modality: "fact" | "decision" | "hypothesis";
        scope: "machine" | "global" | "project";
        scopeValue: string | null;
        evidenceTier: "tool_verified" | "user_stated" | "external_reference" | "assistant_assertion";
        singleValued: boolean;
        messageIds: string[];
        contradicts: string[];
    }[];
}, {
    session: {
        summaryShort: string;
        summaryDetailed?: string | undefined;
        keyDecisions?: string[] | undefined;
        filesTouched?: string[] | undefined;
        concepts?: string[] | undefined;
    };
    messages?: {
        kind: "tool" | "prompt" | "response" | "reasoning" | "turn";
        messageId: string;
        summaryShort: string;
        summaryDetailed?: string | undefined;
    }[] | undefined;
    claims?: {
        concept: string;
        subject: string;
        statement: string;
        polarity?: "affirm" | "deny" | undefined;
        modality?: "fact" | "decision" | "hypothesis" | undefined;
        scope?: "machine" | "global" | "project" | undefined;
        scopeValue?: string | null | undefined;
        evidenceTier?: "tool_verified" | "user_stated" | "external_reference" | "assistant_assertion" | undefined;
        singleValued?: boolean | undefined;
        messageIds?: string[] | undefined;
        contradicts?: string[] | undefined;
    }[] | undefined;
}>;
type Digest = z.infer<typeof DigestSchema>;
export declare function parseModelSpec(value: string): ModelSpec | null;
export declare function parseDigest(text: string): Digest;
export declare function buildPrompt(session: HistorySession, messages: HistoryMessage[], machine: string): {
    prompt: string;
    sourceHash: string;
    messageTimes: Map<string, number>;
    messageHashes: Map<string, string>;
};
export declare function generateDigest(deps: SummaryDependencies, prompt: string): Promise<{
    digest: Digest;
    model: string;
    raw: string;
}>;
export declare function summarizeSession(deps: SummaryDependencies, sessionId: string, options?: {
    force?: boolean;
}): Promise<{
    processed: boolean;
    messageSummaries: number;
    claims: number;
}>;
export declare function summarizeBatch(deps: SummaryDependencies, options?: SummaryBatchOptions): Promise<SummaryBatchResult>;
/**
 * Coalesces live idle/completion events. Only one summarization runs at a time;
 * a session is re-queued if it changes while the worker is busy.
 */
export declare class SummaryWorker {
    private readonly deps;
    private readonly delayMs;
    private readonly queue;
    private timer?;
    private running;
    constructor(deps: SummaryDependencies, delayMs?: number);
    updateConfig(config: ClientConfig): void;
    enqueue(sessionId: string): void;
    drain(): Promise<void>;
    close(): void;
}
export {};
