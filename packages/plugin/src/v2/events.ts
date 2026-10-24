import type { Metadata } from "@observatory/contracts";
import { Collector, safeError, size, usage } from "../metadata.js";
import { collectSession } from "./history.js";

type AnyEvent = { type?: string; data?: any; properties?: any; created?: number };
type State = {
  models: Map<string, Metadata>;
  steps: Map<string, number>;
  tools: Map<string, { name: string; started?: number; argumentBytes?: number }>;
};
const states = new WeakMap<Collector, State>();
function stateOf(collector: Collector): State {
  let state = states.get(collector);
  if (!state) {
    state = { models: new Map(), steps: new Map(), tools: new Map() };
    states.set(collector, state);
  }
  return state;
}

export function observeEvent(event: AnyEvent, collector: Collector): void {
  const payload = event.data ?? event.properties ?? {};
  const type = event.type ?? "";
  const now = event.created ?? Date.now();
  const sessionID = payload.sessionID ?? payload.info?.id;
  if (!sessionID) return;
  const messageID = payload.assistantMessageID ?? payload.messageID ?? null;
  const state = stateOf(collector);
  const contextKey = `${sessionID}:${messageID ?? "*"}`;
  const known = state.models.get(contextKey) ?? state.models.get(`${sessionID}:*`);
  const data: Metadata = {
    provider: payload.model?.providerID ?? known?.provider ?? null,
    model: payload.model?.id ?? known?.model ?? null,
    agent: payload.agent ?? known?.agent ?? null,
    variant: payload.model?.variant ?? known?.variant ?? null,
    ...collector.accounts.get(sessionID),
  };
  if (payload.model || payload.agent) {
    state.models.set(contextKey, data);
    state.models.set(`${sessionID}:*`, data);
  }
  const record = (kind: "step" | "tool" | "text" | "error" | "message", id: string, metadata: Metadata) =>
    collector.record(kind, id, { ...data, ...metadata }, sessionID, messageID, false, now);

  switch (type) {
    case "session.created":
    case "session.updated":
    case "session.renamed": {
      const info = payload.info ?? { ...payload, id: sessionID, time: { created: now, updated: now } };
      // The caller hydrates partial lifecycle events from session.get. A created
      // event is also independently usable; V2 identifies it with sessionID.
      if (type !== "session.renamed" || payload.info) collectSession(collector, info);
      return;
    }
    case "session.step.started": {
      const id = `${messageID}:step`;
      state.steps.set(contextKey, payload.started ?? now);
      record("step", id, { status: "running", startedAt: payload.started ?? now, purpose: "chat" });
      return;
    }
    case "session.step.ended":
    case "session.step.failed": {
      const startedAt = state.steps.get(contextKey);
      record("step", `${messageID}:step`, {
        ...(payload.tokens ? usage(payload.tokens, payload.cost) : {}),
        status: type.endsWith("failed") ? "failed" : "completed",
        ...(payload.error ? safeError(payload.error) : {}),
        finishReason: payload.finish ?? null,
        startedAt,
        endedAt: now,
        durationMs: startedAt === undefined ? null : Math.max(0, now - startedAt),
        purpose: "chat",
      });
      state.steps.delete(contextKey);
      return;
    }
    case "session.tool.input.started":
      state.tools.set(`${contextKey}:${payload.id}`, { name: payload.name, started: now });
      return;
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const key = `${contextKey}:${payload.id}`;
      const tool = state.tools.get(key) ?? { name: payload.name ?? "unknown", started: undefined, argumentBytes: undefined };
      if (type === "session.tool.called") {
        tool.started = now;
        tool.argumentBytes = size(payload.input ?? {});
        state.tools.set(key, tool);
      }
      record("tool", payload.id, {
        tool: tool.name.slice(0, 512), callId: payload.id,
        status: type.endsWith("called") ? "running" : type.endsWith("failed") ? "failed" : "completed",
        argumentBytes: tool.argumentBytes ?? null,
        outputBytes: payload.content ? size(payload.content) : null,
        startedAt: tool.started,
        ...(type.endsWith("called") ? {} : { endedAt: now, durationMs: tool.started === undefined ? null : Math.max(0, now - tool.started) }),
        ...(payload.error ? safeError(payload.error) : {}),
      });
      if (!type.endsWith("called")) state.tools.delete(key);
      return;
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
      record("text", `${messageID}:${kind}:${payload.ordinal ?? 0}`, {
        ...(kind === "reasoning" ? { reasoningBytes: size(payload.text ?? "") } : { textBytes: size(payload.text ?? "") }),
      });
      return;
    }
    case "session.compaction.ended":
      // Compaction has its own message ID derived from the durable event ID.
      collector.record("message", (event as any).id?.replace(/^evt_/, "msg_") ?? `${sessionID}:compaction:${now}`, {
        ...data, ...usage(payload.tokens, payload.cost), purpose: "compaction", status: "completed", endedAt: now,
      }, sessionID, null, false, now);
      return;
    case "session.execution.failed":
    case "session.retry.scheduled":
      record("error", (event as any).id ?? `${sessionID}:error:${now}`, { ...safeError(payload.error), status: "failed" });
      return;
  }
}
