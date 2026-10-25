import { Database } from "bun:sqlite";
import { type TelemetryEvent, type ContentPart } from "@observatory/contracts";
import { type ClientConfig } from "./config.js";
export declare class Outbox {
    readonly config: ClientConfig;
    private fetcher;
    readonly db: Database;
    private inflight;
    private contentInflight;
    private timer?;
    private backoff;
    private stopped;
    lastError: string | null;
    constructor(config: ClientConfig, path?: string, fetcher?: typeof fetch);
    enqueue(value: TelemetryEvent): void;
    enqueueContent(value: ContentPart): void;
    health(): {
        pending: number;
        pendingContent: number;
        acknowledged: number;
        acknowledgedContent: number;
        lastError: string | null;
    };
    flush(): Promise<number>;
    flushContent(): Promise<number>;
    private send;
    private sendContent;
    start(): void;
    drain(): Promise<{
        pending: number;
        pendingContent: number;
        acknowledged: number;
        acknowledgedContent: number;
        lastError: string | null;
    }>;
    replay(): void;
    cursor(source: string): {
        updated_at: number;
        session_id: string;
    } | null;
    checkpoint(source: string, updatedAt: number, sessionId: string): void;
    summaryState(sessionId: string): {
        revision: number;
        status: string;
        attempts: number;
        error: string | null;
        updated_at: number;
    } | null;
    setSummaryState(sessionId: string, revision: number, status: "pending" | "running" | "done" | "failed", error?: string | null): void;
    summaryCounts(): Record<string, number>;
    close(): Promise<void>;
}
