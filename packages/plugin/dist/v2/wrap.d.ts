import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Collector } from "../metadata.js";
type ModelContext = {
    sessionID: string;
    messageID: string | null;
    agent: string | null;
    variant: string | null;
};
export declare function setModelContext(collector: Collector, modelKey: string, ctx: ModelContext): void;
export declare function getModelContext(collector: Collector, modelKey: string): ModelContext | undefined;
export declare function wrapLanguageModel(inner: LanguageModelV3, providerID: string, modelID: string, collector: Collector, modelKey: string): LanguageModelV3;
/**
 * Creates a fetch wrapper that records attempt-level telemetry.
 * Used as a fallback when the `language` hook isn't available in the runtime.
 */
export declare function createAttemptFetch(inner: typeof fetch, collector: Collector, modelKey: string): typeof fetch;
export {};
