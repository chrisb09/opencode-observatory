import type { Metadata } from "@observatory/contracts";
import type { ClientConfig } from "../config.js";
import { Collector } from "../metadata.js";
type PluginContext = {
    provider?: {
        get(input: {
            providerID: string;
        }): Promise<{
            data: {
                integrationID?: string;
            };
        }>;
    };
    integration: {
        connection: {
            active(integrationID: string): Promise<{
                type: string;
                id?: string;
                name?: string;
            } | undefined>;
            resolve(connection: {
                type: string;
                id?: string;
                name?: string;
            }): Promise<any>;
        };
    };
};
type Hooks = {
    request(event: any): Promise<void>;
    response(event: any): Promise<void>;
    clear(): void;
};
export declare function accountData(ctx: PluginContext, collector: Collector, config: ClientConfig, providerID: string): Promise<Metadata>;
export declare function createTransportHooks(plugin: PluginContext, collector: () => Collector | null, config: () => ClientConfig | null): Hooks;
export {};
