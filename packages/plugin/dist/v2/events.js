import { safeError, size } from "../metadata.js";
const contexts = new WeakMap();
function contextMap(collector) {
    let map = contexts.get(collector);
    if (!map) {
        map = new Map();
        contexts.set(collector, map);
    }
    return map;
}
function keyOf(sessionID, messageID) {
    return sessionID ? `${sessionID}:${messageID ?? "*"}` : null;
}
function payloadOf(event) {
    return event.data ?? event.properties ?? {};
}
function ids(payload) {
    return {
        sessionID: typeof payload.sessionID === "string" ? payload.sessionID : null,
        messageID: typeof payload.assistantMessageID === "string"
            ? payload.assistantMessageID
            : typeof payload.messageID === "string"
                ? payload.messageID
                : null,
    };
}
function base(payload, collector, sessionID, messageID) {
    const map = contextMap(collector);
    const known = (messageID ? map.get(`${sessionID}:${messageID}`) : undefined) ??
        (sessionID ? map.get(`${sessionID}:*`) : undefined);
    const account = sessionID ? collector.accounts.get(sessionID) : undefined;
    return {
        provider: payload.model?.providerID ?? known?.provider ?? null,
        model: payload.model?.id ?? payload.modelID ?? payload.model?.modelID ?? known?.model ?? null,
        agent: payload.agent ?? known?.agent ?? null,
        variant: payload.model?.variant ?? known?.variant ?? null,
        ...(account ?? {}),
    };
}
function timestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function duration(start, end) {
    const from = timestamp(start);
    const to = timestamp(end);
    return from !== undefined && to !== undefined && to >= from ? to - from : null;
}
export function observeEvent(event, collector) {
    const payload = payloadOf(event);
    const type = event.type ?? "";
    const now = timestamp(event.created) ?? Date.now();
    const { sessionID, messageID } = ids(payload);
    const data = base(payload, collector, sessionID, messageID);
    const map = contextMap(collector);
    if (sessionID) {
        if (payload.model || payload.agent) {
            const entry = {
                provider: data.provider ?? null,
                model: data.model ?? null,
                agent: data.agent ?? null,
                variant: data.variant ?? null,
            };
            if (messageID)
                map.set(`${sessionID}:${messageID}`, entry);
            map.set(`${sessionID}:*`, entry);
        }
    }
    switch (type) {
        case "session.created":
        case "session.updated":
        case "session.forked":
        case "session.renamed": {
            const info = payload.info ?? payload;
            if (typeof info?.id === "string")
                collector.session(info);
            return;
        }
        case "session.step.started": {
            if (!sessionID)
                return;
            collector.record("step", String(payload.id ?? payload.stepID ?? `${messageID ?? sessionID}:step:${now}`), {
                ...data,
                status: "running",
                startedAt: timestamp(payload.started) ?? timestamp(payload.time?.start) ?? now,
                purpose: payload.purpose === "compaction" ? "compaction" : "chat",
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.step.ended": {
            if (!sessionID)
                return;
            collector.record("step", String(payload.id ?? payload.stepID ?? `${messageID ?? sessionID}:step:${now}`), {
                ...data,
                ...(payload.tokens ? {
                    inputTokens: typeof payload.tokens.input === "number" ? payload.tokens.input : null,
                    outputTokens: typeof payload.tokens.output === "number" ? payload.tokens.output : null,
                    reasoningTokens: typeof payload.tokens.reasoning === "number" ? payload.tokens.reasoning : null,
                    cacheReadTokens: typeof payload.tokens.cache?.read === "number" ? payload.tokens.cache.read : null,
                    cacheWriteTokens: typeof payload.tokens.cache?.write === "number" ? payload.tokens.cache.write : null,
                    usageSource: "opencode",
                    usageSemantics: "opencode-exclusive-input",
                    outputSemantics: "exclusive-reasoning",
                } : {}),
                ...(typeof payload.cost === "number"
                    ? { cost: payload.cost, costSource: "opencode-estimate" }
                    : {}),
                status: "completed",
                finishReason: payload.finish ?? null,
                startedAt: timestamp(payload.started) ?? timestamp(payload.time?.start),
                endedAt: timestamp(payload.time?.end) ?? now,
                durationMs: duration(payload.started ?? payload.time?.start, payload.time?.end ?? now),
                purpose: payload.purpose === "compaction" ? "compaction" : "chat",
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.step.failed":
        case "session.execution.failed": {
            if (!sessionID)
                return;
            collector.record("error", String(payload.id ?? `${sessionID}:error:${now}`), { ...data, ...safeError(payload.error ?? { message: payload.message }), status: "failed" }, sessionID, messageID, false, now);
            return;
        }
        case "session.tool.called": {
            if (!sessionID)
                return;
            collector.record("tool", String(payload.id ?? payload.callID ?? `${sessionID}:tool:${now}`), {
                ...data,
                tool: String(payload.tool ?? payload.name ?? "unknown").slice(0, 512),
                callId: payload.callID ?? payload.id,
                status: "running",
                argumentBytes: size(payload.input ?? {}),
                startedAt: timestamp(payload.time?.start) ?? now,
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.tool.success": {
            if (!sessionID)
                return;
            collector.record("tool", String(payload.id ?? payload.callID ?? `${sessionID}:tool:${now}`), {
                ...data,
                tool: String(payload.tool ?? payload.name ?? "unknown").slice(0, 512),
                callId: payload.callID ?? payload.id,
                status: "completed",
                argumentBytes: size(payload.input ?? {}),
                outputBytes: typeof payload.output === "string" ? size(payload.output) : null,
                startedAt: timestamp(payload.time?.start),
                endedAt: timestamp(payload.time?.end) ?? now,
                durationMs: duration(payload.time?.start, payload.time?.end ?? now),
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.tool.failed": {
            if (!sessionID)
                return;
            collector.record("tool", String(payload.id ?? payload.callID ?? `${sessionID}:tool:${now}`), {
                ...data,
                tool: String(payload.tool ?? payload.name ?? "unknown").slice(0, 512),
                callId: payload.callID ?? payload.id,
                status: "failed",
                argumentBytes: size(payload.input ?? {}),
                ...safeError(payload.error ?? { message: payload.message }),
                startedAt: timestamp(payload.time?.start),
                endedAt: timestamp(payload.time?.end) ?? now,
                durationMs: duration(payload.time?.start, payload.time?.end ?? now),
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.text.ended":
        case "session.reasoning.ended": {
            if (!sessionID)
                return;
            const reasoning = type.startsWith("session.reasoning");
            collector.record("text", String(payload.id ?? `${messageID ?? sessionID}:${reasoning ? "reasoning" : "text"}:${now}`), {
                ...data,
                ...(reasoning
                    ? { reasoningBytes: size(payload.text ?? payload.delta ?? "") }
                    : { textBytes: size(payload.text ?? payload.delta ?? "") }),
                startedAt: timestamp(payload.time?.start),
                durationMs: duration(payload.time?.start, payload.time?.end),
            }, sessionID, messageID, false, now);
            return;
        }
        case "session.usage.updated":
        case "session.usage.recorded": {
            return;
        }
        case "session.retry.scheduled": {
            if (!sessionID)
                return;
            collector.record("error", String(payload.id ?? `${sessionID}:retry:${now}`), { ...data, ...safeError(payload.error ?? { message: "Retry scheduled" }), status: "failed" }, sessionID, messageID, false, now);
            return;
        }
        default:
            return;
    }
}
//# sourceMappingURL=events.js.map