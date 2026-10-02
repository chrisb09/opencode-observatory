import type { Metadata, Runtime, TelemetryEvent } from "@observatory/contracts";
import type { ClientConfig } from "./config.js";
export declare const size: (value: unknown) => number;
export declare const fingerprint: (secret: string, value: string) => string;
export declare function safeError(error: any): Metadata;
export declare function usage(tokens: any, cost: unknown): Metadata;
export declare class Collector {
    readonly config: ClientConfig;
    runtime: Runtime;
    readonly emit: (event: TelemetryEvent) => void;
    readonly projectId: string | null;
    readonly instanceId: `${string}-${string}-${string}-${string}-${string}`;
    messages: Map<string, any>;
    sessions: Map<string, {
        projectId: string | null;
        version: string | null;
    }>;
    accounts: Map<string, {
        account: string | null;
        credential: string | null;
        authType: string | null;
        accountSource?: Metadata["accountSource"];
    }>;
    requestAccounts: Map<string, {
        account: string | null;
        credential: string | null;
        authType: string | null;
        accountSource?: Metadata["accountSource"];
    }>;
    constructor(config: ClientConfig, runtime: Runtime, emit: (event: TelemetryEvent) => void, projectId?: string | null);
    record(kind: TelemetryEvent["kind"], entityId: string, data: Metadata, sessionId?: string | null, messageId?: string | null, historical?: boolean, revision?: number, observedAt?: number): void;
    session(info: any, historical?: boolean, revision?: any): void;
    message(info: any, historical?: boolean, revision?: number): void;
    part(part: any, historical?: boolean, revision?: number): void;
    attachment(part: any, historical: boolean, revision: number, source?: "tool"): void;
}
