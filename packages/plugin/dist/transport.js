import { randomUUID } from "node:crypto";
import { fingerprint, safeError } from "./metadata.js";
const KEY = Symbol.for("opencode.observatory.transport.v1");
export const ACCOUNT_BRIDGE = Symbol.for("opencode.observatory.account.v1");
const MARKER = "x-observatory-correlation";
const globalState = globalThis;
export function installTransport() {
    if (globalState[KEY]) {
        globalState[KEY].refs++;
        return globalState[KEY];
    }
    const original = globalThis.fetch;
    const registry = { original, contexts: new Map(), refs: 1, accounts: new Map(), wrapper: original };
    globalState[ACCOUNT_BRIDGE] = (accessToken, stableAccountId) => {
        // Auth-plugin bridge maps the ACTUAL selected access token, not an on-disk active-account index.
        if (registry.accounts.size > 500)
            registry.accounts.clear();
        registry.accounts.set(accessToken, stableAccountId);
    };
    registry.wrapper = (async (input, init) => {
        let url;
        try {
            url = new URL(input instanceof Request ? input.url : String(input));
        }
        catch {
            return original(input, init);
        }
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const marker = headers.get(MARKER);
        headers.delete(MARKER);
        // Remove our local correlation marker even when no collector can correlate the request.
        const forwarded = marker ? { ...init, headers } : init;
        const direct = marker ? registry.contexts.get(marker) : undefined;
        const session = headers.get("x-opencode-session-id") ?? headers.get("x-opencode-session") ?? headers.get("x-session-id") ?? headers.get("x-session-affinity");
        const inference = /\/(responses|chat\/completions|messages)(?:\?|\/|$)|:(?:streamGenerateContent|generateContent)/.test(url.pathname);
        const candidates = direct ? [direct] : [...registry.contexts.values()].filter(c => c.hosts.has(url.host) && ((session && c.sessionId === session) || (!session && Date.now() - c.createdAt < 30000)));
        const context = inference && candidates.length === 1 ? candidates[0] : undefined;
        if (!context)
            return original(input, forwarded);
        const { collector } = context, id = randomUUID(), start = Date.now(), clock = performance.now();
        const body = init?.body;
        let requestedModel = context.data.model ?? null;
        if (typeof body === "string") {
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed.model === "string")
                    requestedModel = parsed.model.slice(0, 512);
            }
            catch { }
        }
        const authorization = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        const apiCredential = headers.get("x-api-key") ?? headers.get("api-key") ?? headers.get("x-goog-api-key") ?? url.searchParams.get("key");
        const credential = apiCredential ?? authorization;
        const stable = headers.get("chatgpt-account-id") ?? (authorization ? registry.accounts.get(authorization) : undefined);
        let jwtAccount;
        if (!stable && authorization?.split(".").length === 3) {
            try {
                const claims = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString());
                jwtAccount = claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.sub;
            }
            catch { }
        }
        const authType = apiCredential ? "api-key" : stable || jwtAccount ? "oauth" : context.data.authType ?? (credential ? "api-key" : null);
        const observedIdentity = authType === "oauth" ? (stable ?? jwtAccount) : undefined;
        const contentLength = headers.get("content-length");
        const requestBytes = typeof body === "string" ? Buffer.byteLength(body) : contentLength && /^\d+$/.test(contentLength) ? count(Number(contentLength)) : null;
        const data = { ...context.data, coverage: "transport", model: requestedModel, startedAt: start, status: "running", usageSource: "unavailable", usageSemantics: "unknown", requestBytes, responseBytes: 0,
            credential: credential && authType !== "oauth" ? fingerprint(collector.config.fingerprintSecret, credential) : context.data.credential ?? null,
            account: observedIdentity ? fingerprint(collector.config.fingerprintSecret, `${context.data.provider}:${observedIdentity}`) : context.data.account ?? null, accountSource: observedIdentity ? "observed" : context.data.account ? "configured" : "unassigned", authType };
        const publishIdentity = () => { if (collector.requestAccounts.size > 10000)
            collector.requestAccounts.clear(); collector.requestAccounts.set(`${context.sessionId}:${context.messageId}:${context.data.provider}:${context.data.model}`, { account: data.account ?? null, credential: data.credential ?? null, authType: data.authType ?? null, accountSource: data.accountSource }); };
        const record = () => {
            try {
                if (data.status === "completed") {
                    publishIdentity();
                }
                collector.record("attempt", id, data, context.sessionId, context.messageId, false, Date.now(), start);
            }
            catch { /* collection never interrupts the provider stream */ }
        };
        record();
        let response;
        try {
            response = await original(input, forwarded);
        }
        catch (error) {
            Object.assign(data, safeError(error), { status: error?.name === "AbortError" ? "cancelled" : "failed", endedAt: Date.now(), durationMs: performance.now() - clock });
            record();
            throw error;
        }
        data.headerMs = performance.now() - clock;
        data.httpStatus = response.status;
        data.requestId = (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 512) ?? null;
        if (!response.ok)
            Object.assign(data, safeError({ status: response.status }), { status: "failed", endedAt: Date.now(), durationMs: performance.now() - clock });
        else
            publishIdentity(); // Available before SDK step-finish events consume the stream.
        record();
        // Some OAuth/proxy responses advertise text/plain or application/json even
        // though the body is SSE. Detect framing from bytes as well as the header.
        let sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
        let buffer = "", json = "", eventData = [], eventBytes = 0, eventOverflow = false, overflow = false, ended = false;
        const decoder = new TextDecoder();
        const observeEvent = () => { if (eventData.length && !eventOverflow) {
            try {
                observe(JSON.parse(eventData.join("\n")), data, performance.now() - clock);
            }
            catch { }
        } eventData = []; eventBytes = 0; eventOverflow = false; };
        const line = (text) => { const value = text.trim(); if (value.startsWith("data:")) {
            sse = true;
            eventBytes += value.length;
            if (eventBytes > 1024 * 1024) {
                eventOverflow = true;
                eventData = [];
            }
            if (!eventOverflow)
                eventData.push(value.slice(5).trimStart());
        }
        else if (!value)
            observeEvent(); };
        const consume = (text) => {
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
            let end;
            while ((end = buffer.indexOf("\n")) !== -1) {
                line(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
            }
            if (sse)
                json = "";
        };
        const finish = (status) => {
            if (ended)
                return;
            ended = true;
            consume(decoder.decode());
            if (buffer) {
                line(buffer);
                buffer = "";
            }
            observeEvent();
            if (!sse && json && !overflow) {
                try {
                    observe(JSON.parse(json), data, performance.now() - clock);
                }
                catch { }
            }
            data.status = status ?? (data.status === "failed" ? "failed" : "completed");
            data.endedAt = Date.now();
            data.durationMs = performance.now() - clock;
            record();
        };
        if (!response.body) {
            finish();
            return response;
        }
        const reader = response.body.getReader();
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (next.done) {
                        finish();
                        controller.close();
                        return;
                    }
                    data.responseBytes = (data.responseBytes ?? 0) + next.value.byteLength;
                    consume(decoder.decode(next.value, { stream: true }));
                    controller.enqueue(next.value);
                }
                catch (error) {
                    Object.assign(data, safeError(error));
                    finish("failed");
                    controller.error(error);
                }
            },
            async cancel(reason) { finish(data.status === "failed" ? "failed" : "cancelled"); await reader.cancel(reason); },
        }, { highWaterMark: 0 });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
    // Bun's fetch has extra properties (e.g. preconnect). Preserve them for other plugins.
    Object.assign(registry.wrapper, original);
    globalThis.fetch = registry.wrapper;
    globalState[KEY] = registry;
    return registry;
}
export function registerContext(registry, context) {
    const now = Date.now();
    for (const [key, c] of registry.contexts)
        if (now - c.createdAt > 24 * 60 * 60 * 1000)
            registry.contexts.delete(key);
    const id = randomUUID();
    registry.contexts.set(id, { ...context, createdAt: now });
    return { [MARKER]: id };
}
export function uninstallTransport(registry, collector) {
    if (collector)
        for (const [key, c] of registry.contexts)
            if (c.collector === collector)
                registry.contexts.delete(key);
    if (--registry.refs === 0) {
        if (globalThis.fetch === registry.wrapper)
            globalThis.fetch = registry.original;
        delete globalState[KEY];
        delete globalState[ACCOUNT_BRIDGE];
    }
}
function count(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null; }
export function observe(chunk, data, elapsed) {
    const value = chunk.response ?? chunk;
    const usage = value.usage ?? value.usageMetadata ?? value.message?.usage;
    if (typeof value.model === "string")
        data.responseModel = value.model.slice(0, 512);
    if (usage) {
        const priorInput = data.inputTokens, priorCacheRead = data.cacheReadTokens, priorCacheWrite = data.cacheWriteTokens, priorReasoning = data.reasoningTokens, priorOutput = data.outputTokens;
        data.usageSource = "provider";
        if (usage.prompt_tokens !== undefined || usage.input_tokens !== undefined) {
            data.inputTokens = count(usage.prompt_tokens ?? usage.input_tokens);
            data.outputTokens = count(usage.completion_tokens ?? usage.output_tokens);
            data.cacheReadTokens = count(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
            data.cacheWriteTokens = count(usage.cache_creation_input_tokens);
            data.reasoningTokens = count(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens);
            data.totalTokens = count(usage.total_tokens);
            if (usage.cache_read_input_tokens !== undefined) {
                data.usageSemantics = "opencode-exclusive-input";
                data.outputSemantics = "inclusive-reasoning";
            }
            else if (usage.prompt_tokens !== undefined || usage.input_tokens !== undefined) {
                data.usageSemantics = "provider-inclusive-input";
                data.outputSemantics = "inclusive-reasoning";
                data.cacheWriteTokens = 0;
            }
        }
        else if (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined || usage.totalTokenCount !== undefined) {
            data.inputTokens = count(usage.promptTokenCount);
            data.outputTokens = count(usage.candidatesTokenCount);
            data.cacheReadTokens = count(usage.cachedContentTokenCount);
            data.reasoningTokens = count(usage.thoughtsTokenCount);
            data.cacheWriteTokens = 0;
            data.totalTokens = count(usage.totalTokenCount);
            data.usageSemantics = "provider-inclusive-input";
            data.outputSemantics = "exclusive-reasoning";
        }
        // Anthropic message_delta only contains output usage; do not erase input usage from message_start.
        if (data.inputTokens === null)
            data.inputTokens = priorInput;
        if (data.cacheReadTokens === null)
            data.cacheReadTokens = priorCacheRead;
        if (data.cacheWriteTokens === null)
            data.cacheWriteTokens = priorCacheWrite;
        if (data.reasoningTokens === null)
            data.reasoningTokens = priorReasoning;
        if (data.outputTokens === null)
            data.outputTokens = priorOutput;
    }
    if (value.type === "message_delta" && value.usage?.output_tokens !== undefined)
        data.outputTokens = count(value.usage.output_tokens);
    const output = value.delta?.text ?? value.delta?.toolCall?.args ?? (typeof value.delta === "string" ? value.delta : undefined) ?? value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? value.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
    if (typeof output === "string" && output.length && data.firstOutputMs == null)
        data.firstOutputMs = elapsed;
    const finish = value.choices?.[0]?.finish_reason ?? value.delta?.stop_reason ?? value.candidates?.[0]?.finishReason ?? (value.type === "response.completed" ? value.status : null);
    if (finish)
        data.finishReason = String(finish).slice(0, 512);
    if (value.type === "error" || value.type === "response.failed" || value.error) {
        Object.assign(data, safeError({ status: data.httpStatus ?? (value.error?.code === 429 ? 429 : undefined), code: value.error?.code, message: value.error?.message }), { status: "failed" });
    }
    // Allowlisted provider billed amount only; arbitrary provider metadata is never persisted.
    if (typeof value.usage?.cost === "number" && value.usage.cost >= 0) {
        data.cost = value.usage.cost;
        data.costSource = "provider";
    }
}
//# sourceMappingURL=transport.js.map