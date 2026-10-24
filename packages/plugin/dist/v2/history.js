import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { historyPath } from "../config.js";
export function collectSession(collector, info, historical = false) {
    collector.session({
        ...info,
        status: info.status ?? (info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "cancelled" : info.time?.idle ? "completed" : "running"),
    }, historical);
}
export function collectMessage(collector, sessionID, message, revision = message.time?.completed ?? message.time?.streamed ?? message.time?.created) {
    if (message.type === "user") {
        const observedAt = message.time?.created ?? revision;
        collector.content({ sessionId: sessionID, messageId: message.id, partId: `${message.id}:prompt`, kind: "prompt", role: "user", text: String(message.text ?? ""), observedAt });
        for (const file of message.files ?? [])
            collector.contentAttachment(sessionID, message.id, file, observedAt, "user");
        return;
    }
    if (message.type !== "assistant" && message.type !== "compaction")
        return;
    collector.message({
        ...message,
        sessionID,
        role: "assistant",
        providerID: message.model?.providerID,
        modelID: message.model?.id,
        time: { ...message.time, completed: message.time?.completed ?? (message.type === "compaction" && message.status !== "running" ? revision : undefined) },
    }, true, revision);
    if (message.type === "compaction") {
        collector.content({ sessionId: sessionID, messageId: message.id, partId: `${message.id}:summary`, kind: "response", role: "assistant", text: String(message.summary ?? message.recent ?? ""), observedAt: message.time?.created ?? revision });
    }
    // Do not manufacture step records from snapshots: existing V1 or live V2 steps
    // already account for the message. The server falls back to message usage when
    // no step exists, so backfill and live capture never count the same call twice.
    for (const [ordinal, content] of (message.content ?? []).entries()) {
        const base = { sessionID, messageID: message.id, id: content.id ?? `${message.id}:${content.type}:${ordinal}` };
        if (content.type === "tool") {
            collector.part({ ...base, type: "tool", tool: content.name, callID: content.id, state: {
                    ...content.state,
                    output: content.state?.content ? JSON.stringify(content.state.content) : undefined,
                    time: { start: content.time?.ran ?? content.time?.created, end: content.time?.completed },
                } }, true, revision);
        }
        else if (content.type === "text" || content.type === "reasoning") {
            collector.part({ ...base, type: content.type, text: content.text, time: {
                    start: content.time?.created ?? message.time?.created, end: content.time?.completed ?? message.time?.streamed,
                } }, true, revision);
        }
    }
    collector.messages.delete(message.id);
}
export async function importV2History(collector, outbox, path = collector.config.historyDatabase ?? historyPath(), options = {}) {
    const db = new Database(path, { readonly: true });
    let sessions = 0;
    try {
        if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get())
            return { sessions, ...outbox.health() };
        const source = `${resolve(path)}:v2:${options.directory ?? "*"}`;
        let cursor = options.all ? null : outbox.cursor(source);
        const query = `SELECT * FROM session_v2 WHERE (time_updated>? OR (time_updated=? AND id>?)) ${options.directory ? "AND directory=?" : ""} ORDER BY time_updated,id LIMIT 25`;
        for (;;) {
            if (options.signal?.aborted)
                break;
            const params = [cursor?.updated_at ?? 0, cursor?.updated_at ?? 0, cursor?.session_id ?? ""];
            if (options.directory)
                params.push(options.directory);
            const rows = db.query(query).all(...params);
            if (!rows.length)
                break;
            for (const row of rows) {
                if (options.signal?.aborted)
                    return { sessions, ...outbox.health() };
                // Keep the snapshot and its receipt atomic. V2's legacy tables are frozen;
                // session_v2 and session_message are its current materialized projections.
                db.transaction(() => outbox.db.transaction(() => {
                    collectSession(collector, { ...row, id: row.id, outcome: row.idle_outcome,
                        time: { created: row.time_created, updated: row.time_updated, idle: row.time_idle },
                    }, true);
                    const messages = db.query("SELECT id,type,data,time_updated FROM session_message WHERE session_id=? ORDER BY seq,id").all(row.id);
                    for (const message of messages)
                        collectMessage(collector, row.id, {
                            ...JSON.parse(message.data), id: message.id, type: message.type,
                        }, message.time_updated);
                    outbox.checkpoint(source, row.time_updated, row.id);
                })())();
                cursor = { updated_at: row.time_updated, session_id: row.id };
                sessions++;
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return { sessions, ...outbox.health() };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=history.js.map