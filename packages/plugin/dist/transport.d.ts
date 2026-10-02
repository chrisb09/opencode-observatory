import type { Metadata } from "@observatory/contracts";
import { Collector } from "./metadata.js";
export declare const ACCOUNT_BRIDGE: unique symbol;
type Context = {
    collector: Collector;
    sessionId: string;
    messageId: string | null;
    data: Metadata;
    hosts: Set<string>;
    createdAt: number;
};
type Registry = {
    original: typeof fetch;
    contexts: Map<string, Context>;
    refs: number;
    accounts: Map<string, string>;
    wrapper: typeof fetch;
};
export declare function installTransport(): Registry;
export declare function registerContext(registry: Registry, context: Omit<Context, "createdAt">): {
    "x-observatory-correlation": `${string}-${string}-${string}-${string}-${string}`;
};
export declare function uninstallTransport(registry: Registry, collector?: Collector | null): void;
export declare function observe(chunk: any, data: Metadata, elapsed: number): void;
export {};
