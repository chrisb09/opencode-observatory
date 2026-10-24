import { randomUUID } from "node:crypto";
import type { Metadata } from "@observatory/contracts";
import type { ClientConfig } from "../config.js";
import { Collector, fingerprint, safeError } from "../metadata.js";
import { observe } from "../transport.js";

const CORRELATION = "x-observatory-correlation";

type Context = {
  collector: Collector;
  sessionID: string;
  messageID: string | null;
  id: string;
  data: Metadata;
  startedAt: number;
  clock: number;
};

type PluginContext = {
  provider?: { get(input: { providerID: string }): Promise<{ data: { integrationID?: string } }> };
  integration: {
    connection: {
      active(integrationID: string): Promise<{ type: string; id?: string; name?: string } | undefined>;
      resolve(connection: { type: string; id?: string; name?: string }): Promise<any>;
    };
  };
};

type Hooks = {
  request(event: any): Promise<void>;
  response(event: any): Promise<void>;
  clear(): void;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export async function accountData(
  ctx: PluginContext,
  collector: Collector,
  config: ClientConfig,
  providerID: string,
): Promise<Metadata> {
  try {
    const integrationID = ctx.provider ? (await ctx.provider.get({ providerID })).data.integrationID ?? providerID : providerID;
    const connection = await ctx.integration.connection.active(integrationID);
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    if (!credential) return { authType: null };
    const metadata = credential.metadata ?? {};
    const account =
      typeof metadata.email === "string"
        ? metadata.email
        : typeof metadata.accountID === "string"
          ? metadata.accountID
          : typeof metadata.accountId === "string"
            ? metadata.accountId
            : null;
    if (credential.type === "key") {
      return {
        account,
        credential: credential.key ? fingerprint(config.fingerprintSecret, credential.key) : null,
        authType: "api-key",
        accountSource: account ? "configured" : "unassigned",
      };
    }
    if (credential.type === "oauth") {
      return {
        account,
        credential: credential.access ? fingerprint(config.fingerprintSecret, credential.access) : null,
        authType: "oauth",
        accountSource: account ? "configured" : "unassigned",
      };
    }
  } catch {
    // Credential lookup must never block the request.
  }
  return { authType: null };
}

export function createTransportHooks(
  plugin: PluginContext,
  collector: () => Collector | null,
  config: () => ClientConfig | null,
): Hooks {
  const contexts = new Map<string, Context>();

  return {
    async request(event) {
      const active = collector();
      const currentConfig = config();
      if (!active || !currentConfig) return;

      const sessionID = String(event.sessionID ?? "");
      if (!sessionID) return;
      const providerID = String(event.model?.providerID ?? "");
      const modelID = String(event.model?.id ?? event.model?.modelID ?? "");
      const marker = randomUUID();
      const headers = new Headers(event.request.headers);
      headers.set(CORRELATION, marker);
      event.request = new Request(event.request, { headers });

      const data: Metadata = {
        provider: providerID || null,
        model: modelID || null,
        agent: event.agent ?? null,
        variant: event.model?.variant ?? null,
        purpose:
          event.kind === "compaction" ? "compaction" : event.kind === "primary" ? "chat" : "auxiliary",
        status: "running",
        startedAt: Date.now(),
        requestBytes: count(headers.get("content-length")),
        ...(await accountData(plugin, active, currentConfig, providerID)),
      };
      active.accounts.set(sessionID, {
        account: data.account ?? null,
        credential: data.credential ?? null,
        authType: data.authType ?? null,
        accountSource: data.accountSource,
      });
      contexts.set(marker, {
        collector: active,
        sessionID,
        messageID: typeof event.messageID === "string" ? event.messageID : null,
        id: randomUUID(),
        data,
        startedAt: Date.now(),
        clock: performance.now(),
      });
    },

    async response(event) {
      const marker = event.request?.headers?.get(CORRELATION);
      const context = marker ? contexts.get(marker) : undefined;
      if (!context) return;

      const response: Response = event.response;
      context.data.headerMs = performance.now() - context.clock;
      context.data.httpStatus = response.status;
      context.data.requestId = (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 512) ?? null;
      if (!response.ok) {
        Object.assign(context.data, safeError({ status: response.status }), { status: "failed" });
      }

      const record = (status?: Metadata["status"]) => {
        const now = Date.now();
        context.data.status = status ?? (context.data.status === "failed" ? "failed" : "completed");
        context.data.endedAt = now;
        context.data.durationMs = performance.now() - context.clock;
        context.collector.record(
          "attempt",
          context.id,
          context.data,
          context.sessionID,
          context.messageID,
          false,
          now,
          context.startedAt,
        );
      };
      record();

      if (!response.body) {
        contexts.delete(marker!);
        return;
      }

      let sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
      let buffer = "";
      let json = "";
      let eventData: string[] = [];
      let eventBytes = 0;
      let eventOverflow = false;
      let overflow = false;
      let ended = false;
      const decoder = new TextDecoder();
      const observeEvent = () => {
        if (!eventData.length || eventOverflow) return;
        try {
          observe(JSON.parse(eventData.join("\n")), context.data, performance.now() - context.clock);
        } catch {}
        eventData = [];
        eventBytes = 0;
        eventOverflow = false;
      };
      const line = (text: string) => {
        const value = text.trim();
        if (value.startsWith("data:")) {
          sse = true;
          eventBytes += value.length;
          if (eventBytes > 1024 * 1024) {
            eventOverflow = true;
            eventData = [];
          }
          if (!eventOverflow) eventData.push(value.slice(5).trimStart());
        } else if (!value) observeEvent();
      };
      const consume = (text: string) => {
        if (!sse && !overflow) {
          json += text;
          if (json.length > 1024 * 1024) {
            json = "";
            overflow = true;
          }
        }
        buffer += text;
        if (buffer.length > 1024 * 1024) {
          buffer = "";
          eventData = [];
          overflow = true;
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
        if (sse) json = "";
      };
      const finish = (status?: Metadata["status"]) => {
        if (ended) return;
        ended = true;
        consume(decoder.decode());
        if (buffer) {
          line(buffer);
          buffer = "";
        }
        observeEvent();
        if (!sse && json && !overflow) {
          try {
            observe(JSON.parse(json), context.data, performance.now() - context.clock);
          } catch {}
        }
        record(status);
        contexts.delete(marker!);
      };

      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              finish();
              controller.close();
              return;
            }
            context.data.responseBytes = (context.data.responseBytes ?? 0) + next.value.byteLength;
            consume(decoder.decode(next.value, { stream: true }));
            controller.enqueue(next.value);
          } catch (error) {
            Object.assign(context.data, safeError(error));
            finish("failed");
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish(context.data.status === "failed" ? "failed" : "cancelled");
          await reader.cancel(reason);
        },
      });

      event.response = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    clear() {
      contexts.clear();
    },
  };
}
