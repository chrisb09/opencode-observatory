import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { EventSchema } from "@observatory/contracts";
import { api, stateDir } from "./config.js";
export class Outbox {
    config;
    fetcher;
    db;
    inflight = null;
    timer;
    backoff = 1000;
    stopped = false;
    lastError = null;
    constructor(config, path = join(stateDir(), "outbox.db"), fetcher = fetch) {
        this.config = config;
        this.fetcher = fetcher;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        chmodSync(dirname(path), 0o700);
        this.db = new Database(path, { create: true });
        chmodSync(path, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(acknowledged_at,created_at);
      CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,session_id TEXT NOT NULL);
    `);
    }
    enqueue(value) {
        const event = EventSchema.parse(value);
        // Stable identity excludes capture time/runtime for historical replay; live revisions retain their runtime snapshots.
        const digest = createHash("sha256").update(JSON.stringify({ installation: event.installationId, kind: event.kind, id: event.entityId, revision: event.revision, data: event.data, historical: event.historical, ...(!event.historical ? { runtime: event.runtime } : {}) })).digest("hex");
        this.db.query("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,NULL)").run(event.eventId, digest, JSON.stringify(event), Date.now());
    }
    health() { return { pending: this.db.query("SELECT count(*) AS n FROM outbox WHERE acknowledged_at IS NULL").get().n, acknowledged: this.db.query("SELECT count(*) AS n FROM outbox WHERE acknowledged_at IS NOT NULL").get().n, lastError: this.lastError }; }
    flush() {
        if (this.inflight)
            return this.inflight;
        this.inflight = this.send().finally(() => { this.inflight = null; });
        return this.inflight;
    }
    async send() {
        try {
            const rows = this.db.query("SELECT event_id,payload FROM outbox WHERE acknowledged_at IS NULL ORDER BY created_at,event_id LIMIT 100").all();
            if (!rows.length)
                return 0;
            const result = await api(this.config, "/api/ingest", { events: rows.map(r => JSON.parse(r.payload)) }, this.fetcher);
            if (!Array.isArray(result.acknowledged) || !result.acknowledged.every(v => typeof v === "string"))
                throw new Error("Invalid server acknowledgement");
            const expected = new Set(rows.map(r => r.event_id));
            let count = 0;
            this.db.transaction(() => { for (const id of result.acknowledged)
                if (expected.has(id)) {
                    this.db.query("UPDATE outbox SET acknowledged_at=? WHERE event_id=? AND acknowledged_at IS NULL").run(Date.now(), id);
                    count++;
                } })();
            if (!count)
                throw new Error("Server acknowledged no queued events");
            this.lastError = null;
            this.backoff = 1000;
            return count;
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : "Upload failed";
            this.backoff = Math.min(this.backoff * 2, 60000);
            throw error;
        }
    }
    start() {
        if (this.timer)
            return;
        this.stopped = false;
        const tick = async () => { try {
            await this.flush();
        }
        catch { } if (this.stopped)
            return; this.timer = setTimeout(tick, this.lastError ? this.backoff + Math.random() * 1000 : this.health().pending ? 250 : 5000); this.timer.unref?.(); };
        this.timer = setTimeout(tick, 500);
        this.timer.unref?.();
    }
    async drain() { while (this.health().pending) {
        const count = await this.flush();
        if (!count)
            break;
    } return this.health(); }
    replay() { this.db.query("UPDATE outbox SET acknowledged_at=NULL").run(); }
    cursor(source) { return this.db.query("SELECT updated_at,session_id FROM cursors WHERE source=?").get(source); }
    checkpoint(source, updatedAt, sessionId) { this.db.query("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET updated_at=excluded.updated_at,session_id=excluded.session_id").run(source, updatedAt, sessionId); }
    async close() { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); try {
        await this.inflight;
    }
    catch { } this.db.close(); }
}
//# sourceMappingURL=outbox.js.map