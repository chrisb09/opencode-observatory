import { Collector } from "../metadata.js";
import { Outbox } from "../outbox.js";
export declare function collectSession(collector: Collector, info: any, historical?: boolean): void;
export declare function collectMessage(collector: Collector, sessionID: string, message: any, revision?: any): void;
export declare function importV2History(collector: Collector, outbox: Outbox, path?: string, options?: {
    directory?: string;
    all?: boolean;
    signal?: AbortSignal;
}): Promise<{
    pending: number;
    acknowledged: number;
    lastError: string | null;
    sessions: number;
}>;
