import { randomUUID } from "node:crypto";
import { safeError } from "../metadata.js";
/** Per-plugin map of providerID:modelID -> last known session context (best-effort). */
const sessionContexts = new WeakMap();
function getMap(collector) {
    let map = sessionContexts.get(collector);
    if (!map) {
        map = new Map();
        sessionContexts.set(collector, map);
    }
    return map;
}
export function setModelContext(collector, modelKey, ctx) {
    getMap(collector).set(modelKey, ctx);
}
export function getModelContext(collector, modelKey) {
    return getMap(collector).get(modelKey);
}
function extractUsage(usage) {
    return {
        inputTokens: usage.inputTokens?.noCache != null && usage.inputTokens?.cacheRead != null
            ? (usage.inputTokens.noCache ?? 0) + (usage.inputTokens.cacheRead ?? 0)
            : (usage.inputTokens?.total ?? null),
        outputTokens: usage.outputTokens?.total ?? null,
        reasoningTokens: usage.outputTokens?.reasoning ?? null,
        cacheReadTokens: usage.inputTokens?.cacheRead ?? null,
        cacheWriteTokens: usage.inputTokens?.cacheWrite ?? null,
        usageSource: "provider",
        usageSemantics: "opencode-exclusive-input",
        outputSemantics: "exclusive-reasoning",
    };
}
export function wrapLanguageModel(inner, providerID, modelID, collector, modelKey) {
    const getMeta = (ctx, options) => {
        let account = collector.accounts.get(ctx.sessionID);
        const pinned = options.headers?.["x-opencode-router-account"];
        if (providerID === "antigravity" && pinned && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pinned)) {
            // A routed account is request-scoped and does not activate the global
            // credential. Attribute its account, but never invent its token fingerprint.
            account = { account: pinned, credential: null, authType: "oauth", accountSource: "configured" };
            collector.accounts.set(ctx.sessionID, account);
        }
        return {
            provider: providerID || null,
            model: modelID || null,
            agent: ctx?.agent ?? null,
            variant: ctx?.variant ?? null,
            ...(account ?? {}),
        };
    };
    const getCtx = (options) => {
        const known = getMap(collector).get(modelKey);
        if (!known)
            return undefined;
        const explicit = options.headers?.["x-opencode-session-id"];
        if (!explicit)
            return known;
        return {
            sessionID: explicit,
            messageID: explicit === known.sessionID ? known.messageID : null,
            agent: options.headers?.["x-opencode-router-agent"] ?? (explicit === known.sessionID ? known.agent : null),
            variant: options.headers?.["x-opencode-router-model"]?.split("#")[1] ?? (explicit === known.sessionID ? known.variant : null),
        };
    };
    return {
        specificationVersion: "v3",
        provider: inner.provider,
        modelId: inner.modelId,
        supportedUrls: inner.supportedUrls,
        async doGenerate(options) {
            const ctx = getCtx(options);
            if (!ctx)
                return inner.doGenerate(options); // no session context yet; skip attempt tracking
            const id = randomUUID();
            const { sessionID, messageID } = ctx;
            const startedAt = Date.now();
            const clock = performance.now();
            const base = getMeta(ctx, options);
            collector.record("attempt", id, { ...base, status: "running", startedAt, purpose: "chat" }, sessionID, messageID, false, startedAt, startedAt);
            try {
                const result = await inner.doGenerate(options);
                const endedAt = Date.now();
                const responseHeaders = result.response?.headers;
                collector.record("attempt", id, {
                    ...base,
                    status: "completed",
                    startedAt,
                    endedAt,
                    durationMs: performance.now() - clock,
                    finishReason: result.finishReason?.unified ?? null,
                    httpStatus: result.response?.status ?? null,
                    requestId: responseHeaders?.["x-request-id"] ?? responseHeaders?.["request-id"] ?? null,
                    ...extractUsage(result.usage),
                    purpose: "chat",
                }, sessionID, messageID, false, endedAt, startedAt);
                return result;
            }
            catch (error) {
                const endedAt = Date.now();
                collector.record("attempt", id, {
                    ...base,
                    ...safeError(error),
                    status: "failed",
                    startedAt,
                    endedAt,
                    durationMs: performance.now() - clock,
                    purpose: "chat",
                }, sessionID, messageID, false, endedAt, startedAt);
                throw error;
            }
        },
        async doStream(options) {
            const ctx = getCtx(options);
            if (!ctx)
                return inner.doStream(options); // no session context; skip attempt tracking
            const id = randomUUID();
            const { sessionID, messageID } = ctx;
            const startedAt = Date.now();
            const clock = performance.now();
            const base = getMeta(ctx, options);
            collector.record("attempt", id, { ...base, status: "running", startedAt, purpose: "chat" }, sessionID, messageID, false, startedAt, startedAt);
            let streamResult;
            try {
                streamResult = await inner.doStream(options);
            }
            catch (error) {
                const endedAt = Date.now();
                collector.record("attempt", id, {
                    ...base,
                    ...safeError(error),
                    status: "failed",
                    startedAt,
                    endedAt,
                    durationMs: performance.now() - clock,
                    purpose: "chat",
                }, sessionID, messageID, false, endedAt, startedAt);
                throw error;
            }
            const originalStream = streamResult.stream;
            let finishReason = null;
            let requestId = null;
            let usageMeta = null;
            let ended = false;
            const commit = (status, extra) => {
                if (ended)
                    return;
                ended = true;
                const endedAt = Date.now();
                collector.record("attempt", id, {
                    ...base,
                    status,
                    startedAt,
                    endedAt,
                    durationMs: performance.now() - clock,
                    finishReason,
                    requestId,
                    ...(usageMeta ?? {}),
                    purpose: "chat",
                    ...(extra ?? {}),
                }, sessionID, messageID, false, endedAt, startedAt);
            };
            const reader = originalStream.getReader();
            const wrapped = new ReadableStream({
                async pull(controller) {
                    try {
                        const next = await reader.read();
                        if (next.done) {
                            commit("completed");
                            controller.close();
                            return;
                        }
                        const part = next.value;
                        if (part.type === "finish") {
                            finishReason = part.finishReason?.unified ?? null;
                            usageMeta = extractUsage(part.usage);
                        }
                        else if (part.type === "response-metadata") {
                            const headers = part.headers;
                            requestId = headers?.["x-request-id"] ?? headers?.["request-id"] ?? null;
                        }
                        else if (part.type === "error") {
                            commit("failed", safeError(part.error));
                        }
                        controller.enqueue(part);
                    }
                    catch (error) {
                        commit("failed", safeError(error));
                        controller.error(error);
                    }
                },
                async cancel(reason) {
                    commit(ended ? "completed" : "cancelled");
                    await reader.cancel(reason);
                },
            });
            return { ...streamResult, stream: wrapped };
        },
    };
}
const CORRELATION = "x-observatory-correlation";
/**
 * Creates a fetch wrapper that records attempt-level telemetry.
 * Used as a fallback when the `language` hook isn't available in the runtime.
 */
export function createAttemptFetch(inner, collector, modelKey) {
    const wrapped = async (input, init) => {
        const ctx = getMap(collector).get(modelKey);
        if (!ctx)
            return inner(input, init);
        const id = randomUUID();
        const { sessionID, messageID } = ctx;
        const startedAt = Date.now();
        const clock = performance.now();
        const base = {
            provider: modelKey.split(":")[0] ?? null,
            model: modelKey.split(":").slice(1).join(":") || null,
            agent: ctx.agent ?? null,
            variant: ctx.variant ?? null,
            ...(collector.accounts.get(sessionID) ?? {}),
        };
        // Tag the request so we can match request+response.
        const headers = new Headers(init?.headers);
        headers.set(CORRELATION, id);
        const requestInit = { ...(init ?? {}), headers };
        collector.record("attempt", id, { ...base, status: "running", startedAt, purpose: "chat" }, sessionID, messageID, false, startedAt, startedAt);
        let response;
        try {
            response = await inner(input, requestInit);
        }
        catch (error) {
            const endedAt = Date.now();
            collector.record("attempt", id, {
                ...base,
                ...safeError(error),
                status: "failed",
                startedAt,
                endedAt,
                durationMs: performance.now() - clock,
                purpose: "chat",
            }, sessionID, messageID, false, endedAt, startedAt);
            throw error;
        }
        const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? null;
        const httpStatus = response.status;
        if (!response.ok) {
            const endedAt = Date.now();
            collector.record("attempt", id, {
                ...base,
                ...safeError({ status: httpStatus }),
                status: "failed",
                startedAt,
                endedAt,
                durationMs: performance.now() - clock,
                httpStatus,
                requestId,
                purpose: "chat",
            }, sessionID, messageID, false, endedAt, startedAt);
            return response;
        }
        // For streaming responses, tee the body to observe without blocking the consumer.
        if (!response.body) {
            const endedAt = Date.now();
            collector.record("attempt", id, {
                ...base,
                status: "completed",
                startedAt,
                endedAt,
                durationMs: performance.now() - clock,
                httpStatus,
                requestId,
                purpose: "chat",
            }, sessionID, messageID, false, endedAt, startedAt);
            return response;
        }
        let ended = false;
        const commit = (status) => {
            if (ended)
                return;
            ended = true;
            const endedAt = Date.now();
            collector.record("attempt", id, {
                ...base,
                status,
                startedAt,
                endedAt,
                durationMs: performance.now() - clock,
                httpStatus,
                requestId,
                purpose: "chat",
            }, sessionID, messageID, false, endedAt, startedAt);
        };
        const reader = response.body.getReader();
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (next.done) {
                        commit("completed");
                        controller.close();
                        return;
                    }
                    controller.enqueue(next.value);
                }
                catch (error) {
                    commit("failed");
                    controller.error(error);
                }
            },
            async cancel(reason) {
                commit(ended ? "completed" : "cancelled");
                await reader.cancel(reason);
            },
        });
        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
    return wrapped;
}
//# sourceMappingURL=wrap.js.map