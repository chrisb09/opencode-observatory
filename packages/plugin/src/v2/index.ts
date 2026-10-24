import { Plugin } from "@opencode/plugin";
import { COLLECTOR_VERSION, type Runtime, type Metadata } from "@observatory/contracts";
import { api, clearConfig, configureObservatory, loadConfig, type ClientConfig } from "../config.js";
import { Collector } from "../metadata.js";
import { Outbox } from "../outbox.js";
import { collectSession, importV2History } from "./history.js";
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
    let importStatus: unknown = "not started";
    const controller = new AbortController();
    // Keep collection scoped to the session's actual location, even on shared servers.
    const hydrated = new Map<string, Promise<boolean>>();
    const refreshed = new Map<string, number>();
    const sessionStatus = new Map<string, Metadata["status"]>();
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
      const specs = (Array.isArray(listed) ? listed : (listed as any)?.data ?? [])
        .filter((item: any) => item?.source?.type !== "builtin")
        .map((item: any) => item?.source?.spec ?? item?.source?.path ?? item?.id ?? item?.name)
        .filter((item: unknown): item is string => typeof item === "string");
      runtime = await inventory(specs, ctx.location.directory, ctx.app.version);
      runtime.opencodeSource = "executable";
    } catch {
      // The inventory is optional diagnostics; telemetry can continue without it.
    }

    const transport = createTransportHooks(ctx as any, () => collector, () => clientConfig);

    const recover = () => {
      if (!collector || !outbox) return Promise.resolve();
      if (importTask) return importTask;
      importStatus = "running";
      importTask = importV2History(collector, outbox, undefined, {
        directory: ctx.location.directory, signal: controller.signal,
      }).then(result => { importStatus = result; }).catch(error => {
        importStatus = "failed";
        log(`V2 historical import failed: ${String(error)}`);
      }).finally(() => { importTask = undefined; });
      return importTask;
    };

    const hydrate = (sessionID: string, force = false): Promise<boolean> => {
      if (!collector) return Promise.resolve(false);
      if (!force && collector.sessions.has(sessionID) && Date.now() - (refreshed.get(sessionID) ?? 0) < 5000) return Promise.resolve(true);
      const pending = hydrated.get(sessionID);
      if (pending) return pending;
      const task = (async () => {
        const info = await ctx.session.get({ sessionID: sessionID as any });
        // Event subscriptions are server-wide, not scoped to this plugin instance.
        if (info.location.directory !== ctx.location.directory || !collector) return false;
        collectSession(collector, { ...info, status: sessionStatus.get(sessionID) });
        refreshed.set(sessionID, Date.now());
        return true;
      })().finally(() => hydrated.delete(sessionID));
      hydrated.set(sessionID, task);
      return task;
    };

    const startTelemetry = (next: ClientConfig) => {
      clientConfig = next;
      if (!outbox) {
        outbox = new Outbox(next);
        collector = new Collector(next, runtime, (event) => outbox?.enqueue(event), ctx.location.project.id);
        outbox.start();
        if (next.autoImport && !importTask) {
          void recover();
        }
      }
    };

    if (clientConfig) startTelemetry(clientConfig);
    else log("Not configured. Use the observatory_setup tool or run opencode-observatory setup.");

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!collector) continue;
          const value = event as any;
          const sessionID = value.data?.sessionID;
          if (!sessionID) continue;
          if (value.location?.directory && value.location.directory !== ctx.location.directory) continue;
          try {
            const statuses: Record<string, Metadata["status"]> = {
              "session.execution.started": "running", "session.execution.succeeded": "completed",
              "session.execution.failed": "failed", "session.execution.interrupted": "cancelled",
            };
            if (statuses[value.type]) sessionStatus.set(sessionID, statuses[value.type]);
            const lifecycle = /^session\.(created|renamed|moved|agent\.selected|model\.selected|usage\.updated|execution\.(started|succeeded|failed|interrupted))$/.test(value.type);
            if (!await hydrate(sessionID, lifecycle)) continue;
            // Lifecycle payloads are partial; hydrate already emitted the full snapshot.
            if (!lifecycle) observeEvent(value, collector);
          } catch (error) {
            log(`Could not collect ${value.type}: ${String(error)}`);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`Event stream stopped: ${String(error)}`);
      }
    })();

    await ctx.session.hook("model.request", async (event) => {
      const active = collector;
      const current = clientConfig;
      if (!active || !current) return;
      sessionStatus.set(event.sessionID, "running");
      await hydrate(event.sessionID).catch(() => false);
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
            ? JSON.stringify({ ...outbox.health(), history: importStatus })
            : "OpenCode Observatory is not configured yet. Run the 'observatory_setup' tool with your Observatory server URL and API key.",
        }),
      });

      editor.add({
        name: "observatory_import",
        description: "Recover missing V2 session metadata and usage from OpenCode's persisted history without submitting prompts or inferring historical credentials.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => {
          await recover();
          return { content: JSON.stringify({ history: importStatus, ...outbox?.health() }) };
        },
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
      await Promise.allSettled(hydrated.values());
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
