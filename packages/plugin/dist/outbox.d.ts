import { Database } from "bun:sqlite";
import { type TelemetryEvent } from "@observatory/contracts";
import { type ClientConfig } from "./config.js";
export declare class Outbox {
    readonly config: ClientConfig;
    private fetcher;
    readonly db: Database;
    private inflight;
    private timer?;
    private backoff;
    private stopped;
    lastError: string | null;
    constructor(config: ClientConfig, path?: string, fetcher?: typeof fetch);
    enqueue(value: TelemetryEvent): void;
    health(): {
        pending: number;
        acknowledged: number;
        lastError: string | null;
    };
    flush(): Promise<number>;
    private send;
    start(): void;
    drain(): Promise<{
        pending: number;
        acknowledged: number;
        lastError: string | null;
    }>;
    replay(): void;
    cursor(source: string): {
        updated_at: number;
        session_id: string;
    } | null;
    checkpoint(source: string, updatedAt: number, sessionId: string): void;
    close(): Promise<void>;
}
