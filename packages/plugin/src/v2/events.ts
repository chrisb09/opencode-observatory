import type { Metadata } from "@observatory/contracts";
import { Collector, safeError, size, usage } from "../metadata.js";
import { collectSession } from "./history.js";

type AnyEvent = { type?: string; data?: any; properties?: any; created?: number };
type State = {
  models: Map<string, Metadata>;
  steps: Map<string, number>;
  tools: Map<string, { name: string; started?: number; argumentBytes?: number; inputText?: string }>;
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
  const type = (event.type ?? "").replace(/^session\.next\./, "session.");
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
    case "session.prompted":
    case "session.prompt.admitted": {
      const promptMessageID = payload.messageID ?? messageID ?? `${sessionID}:prompt`;
      collector.content({
        sessionId: sessionID, messageId: promptMessageID, partId: `${promptMessageID}:prompt`,
        kind: "prompt", role: "user", text: String(payload.prompt?.text ?? ""), observedAt: now,
      });
      for (const file of payload.prompt?.files ?? []) collector.contentAttachment(sessionID, promptMessageID, file, now, "user");
      return;
    }
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
      state.tools.set(`${contextKey}:${payload.callID ?? payload.id}`, { name: payload.name, started: now });
      return;
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const callID = payload.callID ?? payload.id;
      const key = `${contextKey}:${callID}`;
      const tool = state.tools.get(key) ?? { name: payload.name ?? payload.tool ?? "unknown", started: undefined, argumentBytes: undefined, inputText: undefined };
      if (type === "session.tool.called") {
        tool.started = now;
        tool.argumentBytes = size(payload.input ?? {});
        tool.inputText = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? {});
        state.tools.set(key, tool);
        if (collector.config.contentMode === "full") {
          collector.content({
            sessionId: sessionID, messageId: messageID ?? `${sessionID}:message`, partId: `${callID}:input`,
            kind: "tool_input", role: "assistant", text: tool.inputText ?? "", observedAt: now,
          });
        }
      }
      record("tool", callID, {
        tool: tool.name.slice(0, 512), callId: callID,
        status: type.endsWith("called") ? "running" : type.endsWith("failed") ? "failed" : "completed",
        argumentBytes: tool.argumentBytes ?? null,
        outputBytes: payload.content ? size(payload.content) : null,
        startedAt: tool.started,
        ...(type.endsWith("called") ? {} : { endedAt: now, durationMs: tool.started === undefined ? null : Math.max(0, now - tool.started) }),
        ...(payload.error ? safeError(payload.error) : {}),
      });
      if (!type.endsWith("called")) {
        if (collector.config.contentMode === "full") {
          const content = Array.isArray(payload.content) ? payload.content : [];
          const text = content
            .map((item: any) => (item?.type === "text" ? String(item.text ?? "") : `[file ${item?.mime ?? ""} ${item?.uri ?? ""}]`))
            .join("\n");
          collector.content({
            sessionId: sessionID, messageId: messageID ?? `${sessionID}:message`, partId: `${callID}:output`,
            kind: "tool_output", role: "tool", text, observedAt: now,
          });
        }
        for (const item of Array.isArray(payload.content) ? payload.content : []) {
          if (item?.type === "file") collector.contentAttachment(sessionID, messageID ?? `${sessionID}:message`, item, now);
        }
        state.tools.delete(key);
      }
      return;
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
      const partID = kind === "reasoning" ? payload.reasoningID : payload.textID;
      collector.content({
        sessionId: sessionID, messageId: messageID ?? `${sessionID}:message`,
        partId: partID ?? `${messageID ?? sessionID}:${kind}:${payload.ordinal ?? 0}`,
        kind: kind === "reasoning" ? "reasoning" : "response", role: "assistant",
        text: String(payload.text ?? ""), observedAt: now,
      });
      record("text", `${messageID}:${kind}:${payload.ordinal ?? 0}`, {
        ...(kind === "reasoning" ? { reasoningBytes: size(payload.text ?? "") } : { textBytes: size(payload.text ?? "") }),
      });
      return;
    }
    case "session.compaction.ended": {
      // Compaction has its own message ID derived from the durable event ID.
      const compactionID = (event as any).id?.replace(/^evt_/, "msg_") ?? `${sessionID}:compaction:${now}`;
      collector.record("message", compactionID, {
        ...data, ...usage(payload.tokens, payload.cost), purpose: "compaction", status: "completed", endedAt: now,
      }, sessionID, null, false, now);
      collector.content({
        sessionId: sessionID, messageId: compactionID, partId: `${compactionID}:summary`,
        kind: "response", role: "assistant", text: String(payload.summary ?? payload.recent ?? ""), observedAt: now,
      });
      return;
    }
    case "session.execution.failed":
    case "session.retry.scheduled":
      record("error", (event as any).id ?? `${sessionID}:error:${now}`, { ...safeError(payload.error), status: "failed" });
      return;
  }
}
