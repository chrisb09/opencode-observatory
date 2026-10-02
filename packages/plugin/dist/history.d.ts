import { Collector } from "./metadata.js";
import { Outbox } from "./outbox.js";
export declare function importHistory(collector: Collector, outbox: Outbox, path?: string, options?: {
    all?: boolean;
    onProgress?: (sessions: number) => void;
}): Promise<{
    pending: number;
    acknowledged: number;
    lastError: string | null;
    sessions: number;
}>;
