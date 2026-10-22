import { Plugin } from "@opencode/plugin";
import { COLLECTOR_VERSION, type Runtime } from "@observatory/contracts";
import { api, clearConfig, configureObservatory, loadConfig, type ClientConfig } from "../config.js";
import { Collector } from "../metadata.js";
import { Outbox } from "../outbox.js";
import { importHistory } from "../history.js";
import { inventory } from "../runtime.js";
import { observeEvent } from "./events.js";
import { accountData, createTransportHooks } from "./transport.js";
import { getModelContext, setModelContext, wrapLanguageModel } from "./wrap.js";

const COLLECTOR = COLLECTOR_VERSION;

const setupInput = {
  type: "object",
  properties: {
    apiKey: { type: "string", description: "Observatory telemetry API key (starts with obs_)" },
    url: { type: "string", description: "Observatory server URL (defaults to http://localhost:7692)" },
    autoImport: { type: "boolean", description: "Import past sessions automatically" },
    clear: { type: "boolean", description: "Disconnect Observatory and remove local configuration" },
    clearData: { type: "boolean", description: "Also delete the local outbox database when clearing" },
  },
  additionalProperties: false,
} as const;

const usageInput = {
  type: "object",
  properties: {
    from: { type: "number" },
    to: { type: "number" },
    provider: { type: "string" },
    model: { type: "string" },
    groupBy: {
      type: "string",
      enum: ["model", "provider", "account", "machine", "agent", "credential"],
    },
  },
  additionalProperties: false,
} as const;

export default Plugin.define({
  id: "observatory",
  async setup(ctx) {
    let clientConfig: ClientConfig | null = await loadConfig().catch(() => null);
    let collector: Collector | null = null;
    let outbox: Outbox | null = null;
    let importTask: Promise<unknown> | undefined;
    let runtime: Runtime = {
      opencode: ctx.app.version,
      opencodeSource: "executable",
      collector: COLLECTOR,
      plugins: [],
      capturedAt: Date.now(),
      provenance: "capture",
    };

    const log = (message: string) => console.warn(`[opencode-observatory] ${message}`);

    try {
      const listed = await ctx.plugin.list().catch(() => undefined);
      const specs = ((listed as any)?.data ?? [])
        .map((item: any) => item?.source?.spec ?? item?.id ?? item?.name)
        .filter((item: unknown): item is string => typeof item === "string");
      runtime = await inventory(specs, ctx.location.directory, ctx.app.version);
      runtime.opencodeSource = "executable";
    } catch {
      // The inventory is optional diagnostics; telemetry can continue without it.
    }

    const transport = createTransportHooks(ctx as any, () => collector, () => clientConfig);

    const startTelemetry = (next: ClientConfig) => {
      clientConfig = next;
      if (!outbox) {
        outbox = new Outbox(next);
        collector = new Collector(next, runtime, (event) => outbox?.enqueue(event), ctx.location.project.id);
        outbox.start();
        if (next.autoImport && !importTask) {
          importTask = importHistory(collector, outbox).catch(() => log("Historical import failed."));
        }
      }
    };

    if (clientConfig) startTelemetry(clientConfig);
    else log("Not configured. Use the observatory_setup tool or run opencode-observatory setup.");

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              if (collector) observeEvent(event as any, collector);
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`Event stream stopped: ${String(error)}`);
      }
    })();

    await ctx.session.hook("model.request", async (event) => {
      const active = collector;
      const current = clientConfig;
      if (!active || !current) return;
      const providerID = String(event.model.providerID);
      const modelID = String(event.model.id);
      const modelKey = `${providerID}:${modelID}`;
      const data = await accountData(ctx as any, active, current, providerID);
      active.accounts.set(event.sessionID, {
        account: data.account ?? null,
        credential: data.credential ?? null,
        authType: data.authType ?? null,
        accountSource: data.accountSource,
      });
      setModelContext(active, modelKey, {
        sessionID: event.sessionID,
        messageID: null,
        agent: String(event.agent),
        variant: (event.model as any).variant ?? null,
      });
    });
    await ctx.session.hook("http.request", transport.request);
    await ctx.session.hook("http.response", transport.response);

    await ctx.aisdk.hook("language", async (event) => {
      const active = collector;
      if (!active) return;
      const providerID = String(event.model.providerID ?? "");
      const modelID = String(event.model.id ?? (event.model as any).modelID ?? "");
      const modelKey = `${providerID}:${modelID}`;

      // Build the language model if not already set — some runtimes leave event.language unset
      // when the provider uses a custom SDK factory (sdk hook) rather than a native provider.
      if (!event.language && typeof event.sdk === "function") {
        try {
          event.language = event.sdk((event.model as any).modelID ?? modelID, event.options);
        } catch {
          // If calling the SDK factory fails, fall through without wrapping.
        }
      }
      if (!event.language) return;

      event.language = wrapLanguageModel(
        event.language,
        providerID,
        modelID,
        active,
        modelKey,
      );
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "observatory_setup",
        description:
          "Configure, connect, or clear OpenCode Observatory telemetry. To connect, provide apiKey (and optional url). To disconnect, pass clear: true.",
        input: setupInput,
        options: { codemode: false },
        execute: async (input: any) => {
          const args = input as {
            apiKey?: string;
            url?: string;
            autoImport?: boolean;
            clear?: boolean;
            clearData?: boolean;
          };
          try {
            if (args.clear) {
              await clearConfig({ data: args.clearData });
              if (outbox) {
                try {
                  await outbox.close();
                } catch {}
              }
              outbox = null;
              collector = null;
              clientConfig = null;
              return {
                content: `OpenCode Observatory configuration removed.${args.clearData ? " Local outbox database also cleared." : ""} Telemetry is now stopped.`,
              };
            }
            if (!args.apiKey) {
              return {
                content:
                  "Please provide your Observatory telemetry API key (starts with 'obs_') to connect, or pass clear: true to remove the current configuration.",
              };
            }
            const result = await configureObservatory({
              url: args.url,
              apiKey: args.apiKey,
              autoImport: args.autoImport,
            });
            startTelemetry(result.config);
            return { content: result.message };
          } catch (error) {
            return { content: `Failed to configure Observatory: ${(error as Error).message}` };
          }
        },
      });

      editor.add({
        name: "observatory_status",
        description: "Inspect durable local upload queue health; works when the server is unavailable.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({
          content: outbox
            ? JSON.stringify(outbox.health())
            : "OpenCode Observatory is not configured yet. Run the 'observatory_setup' tool with your Observatory server URL and API key.",
        }),
      });

      editor.add({
        name: "observatory_usage",
        description: "Query your centralized OpenCode usage statistics. Costs are labeled estimates and null metrics are unavailable.",
        input: usageInput,
        options: { codemode: false },
        execute: async (input: any) => {
          if (!clientConfig) {
            return {
              content:
                "OpenCode Observatory is not configured yet. Run the 'observatory_setup' tool to connect.",
            };
          }
          const args = input as Record<string, unknown>;
          const query = new URLSearchParams(
            Object.entries(args)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          );
          return { content: JSON.stringify(await api(clientConfig, `/api/analytics?${query}`)) };
        },
      });
    });

    return async () => {
      controller.abort();
      transport.clear();
      if (importTask) await importTask;
      if (outbox) {
        try {
          await outbox.flush();
        } catch {}
        await outbox.close();
      }
    };
  },
});
