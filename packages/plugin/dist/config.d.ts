import { z } from "zod";
export declare const configDir: () => string;
export declare const stateDir: () => string;
export declare function clearConfig(options?: {
    data?: boolean;
}): Promise<void>;
declare const ConfigSchema: z.ZodObject<{
    schemaVersion: z.ZodOptional<z.ZodNumber>;
    url: z.ZodString;
    apiKey: z.ZodString;
    fingerprintSecret: z.ZodString;
    userId: z.ZodString;
    installationId: z.ZodString;
    machine: z.ZodString;
    autoImport: z.ZodDefault<z.ZodBoolean>;
    enableTools: z.ZodDefault<z.ZodBoolean>;
    accounts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    historyDatabase: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    url: string;
    apiKey: string;
    fingerprintSecret: string;
    userId: string;
    installationId: string;
    machine: string;
    autoImport: boolean;
    enableTools: boolean;
    accounts: Record<string, string>;
    schemaVersion?: number | undefined;
    historyDatabase?: string | undefined;
}, {
    url: string;
    apiKey: string;
    fingerprintSecret: string;
    userId: string;
    installationId: string;
    machine: string;
    schemaVersion?: number | undefined;
    autoImport?: boolean | undefined;
    enableTools?: boolean | undefined;
    accounts?: Record<string, string> | undefined;
    historyDatabase?: string | undefined;
}>;
export type ClientConfig = z.infer<typeof ConfigSchema>;
export declare function loadConfig(): Promise<ClientConfig | null>;
export declare function saveConfig(config: ClientConfig): Promise<void>;
export declare function defaultIdentity(): {
    installationId: `${string}-${string}-${string}-${string}-${string}`;
    machine: string;
};
export declare function historyPath(): string;
export declare function api(config: Pick<ClientConfig, "url" | "apiKey">, path: string, body?: unknown, fetcher?: typeof fetch): Promise<any>;
export declare function configureObservatory(options: {
    url?: string;
    apiKey: string;
    autoImport?: boolean;
    enableTools?: boolean;
    fetcher?: typeof fetch;
}): Promise<{
    config: ClientConfig;
    hasReadScope: boolean;
    message: string;
}>;
export {};
