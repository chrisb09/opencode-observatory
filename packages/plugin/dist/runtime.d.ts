import { type Runtime } from "@observatory/contracts";
import { type ClientConfig } from "./config.js";
export declare function inventory(specs: Array<string | [string, unknown]>, directory: string, opencode: string | null): Promise<Runtime>;
export declare function detectVersion(): string | null;
export declare function syncLocalAccounts(config: ClientConfig, fetcher?: typeof fetch): Promise<void>;
