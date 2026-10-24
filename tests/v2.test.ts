import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { EventSchema } from "@observatory/contracts";
import { Collector } from "../packages/plugin/src/metadata.js";
import { Outbox } from "../packages/plugin/src/outbox.js";
import { observeEvent } from "../packages/plugin/src/v2/events.js";
import { collectMessage, importV2History } from "../packages/plugin/src/v2/history.js";
import { config, runtime } from "./fixtures.js";

const tokens = { input: 10, output: 4, reasoning: 2, cache: { read: 8, write: 0 } };
function fixture() {
  const records: any[] = [];
  const collector = new Collector(config, runtime, event => { EventSchema.parse(event); records.push(event); });
  const send = (type: string, data: any, created: number) => observeEvent({ type, data: { sessionID: "ses_v2", assistantMessageID: "msg_v2", ...data }, created }, collector);
  return { records, collector, send };
}

describe("V2 event contracts", () => {
  test("session.created uses sessionID rather than a V1 info.id", () => {
    const { send, records } = fixture();
    send("session.created", { projectID: "prj_v2", title: "Session", version: "2.1.4" }, 100);
    expect(records[0]).toMatchObject({ kind: "session", entityId: "ses_v2", projectId: "prj_v2", data: { title: "Session", startedAt: 100 } });
  });
  test("step start and end share one stable entity across plugin instances", () => {
    const { send, records } = fixture();
    send("session.step.started", { started: 100, model: { providerID: "openai", id: "model" }, agent: "build" }, 101);
    send("session.step.ended", { tokens, cost: 0.1, finish: "tool-calls" }, 150);
    expect(records.map(record => record.entityId)).toEqual(["msg_v2:step", "msg_v2:step"]);
    expect(records[1].data).toMatchObject({ model: "model", status: "completed", durationMs: 50, inputTokens: 10, cacheReadTokens: 8 });
    const other = fixture();
    other.send("session.step.ended", { tokens }, 150);
    expect(other.records[0].entityId).toBe(records[1].entityId);
  });
  test("tool input.started supplies the name; terminal events supply content, not output", () => {
    const { send, records } = fixture();
    send("session.tool.input.started", { id: "call_v2", name: "read" }, 100);
    send("session.tool.called", { id: "call_v2", input: { path: "PRIVATE_PATH" } }, 105);
    send("session.tool.success", { id: "call_v2", content: [{ type: "text", text: "PRIVATE_OUTPUT" }] }, 150);
    expect(records[1].data).toMatchObject({ tool: "read", status: "completed", durationMs: 45 });
    expect(records[1].data.argumentBytes).toBeGreaterThan(2);
    expect(records[1].data.outputBytes).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });
  test("text identities use message and ordinal, not observation time", () => {
    const { send, records } = fixture();
    send("session.text.ended", { ordinal: 0, text: "PRIVATE_RESPONSE" }, 100);
    send("session.text.ended", { ordinal: 1, text: "next" }, 110);
    expect(records.map(record => record.entityId)).toEqual(["msg_v2:text:0", "msg_v2:text:1"]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_RESPONSE");
  });
  test("historical V2 usage has no invented account attribution or duplicate steps", () => {
    const { collector, records } = fixture();
    collector.accounts.set("ses_v2", { account: "CURRENT_ACCOUNT", credential: "CURRENT_KEY", authType: "oauth" });
    collectMessage(collector, "ses_v2", { id: "msg_old", type: "assistant", agent: "build", model: { id: "model", providerID: "openai" }, tokens, cost: 0.1, time: { created: 100, completed: 200 }, content: [
      { type: "text", text: "PRIVATE_RESPONSE" },
      { type: "tool", id: "call_old", name: "read", time: { created: 110, ran: 120, completed: 150 }, state: { status: "completed", input: { path: "PRIVATE_PATH" }, content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } },
    ] });
    expect(records.filter(record => record.kind === "step")).toHaveLength(0);
    expect(records[0]).toMatchObject({ kind: "message", entityId: "msg_old", historical: true, data: { provider: "openai", model: "model", inputTokens: 10 } });
    const serialized = JSON.stringify(records);
    for (const secret of ["CURRENT_ACCOUNT", "CURRENT_KEY", "PRIVATE_"]) expect(serialized).not.toContain(secret);
  });
});

test("V2 recovery reads current projections, scopes directories, checkpoints and replays idempotently", async () => {
  const dir = await mkdtemp("/tmp/opencode/v2-history-test-");
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,time_idle INTEGER,idle_outcome TEXT);
    CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_updated INTEGER,data TEXT);`);
  db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)").run("ses_v2", "prj_v2", "/project", 100, 200, 200, "succeeded");
  db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)").run("ses_other", "prj_other", "/other", 100, 200, 200, "succeeded");
  const message = { agent: "build", model: { providerID: "openai", id: "model" }, tokens, cost: 0.1, time: { created: 110, completed: 150 }, content: [] };
  db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_v2", "ses_v2", "assistant", 1, 150, JSON.stringify(message));
  const box = new Outbox(config, join(dir, "outbox.db"));
  const collector = new Collector(config, runtime, event => box.enqueue(event));
  try {
    expect((await importV2History(collector, box, path, { directory: "/project" })).sessions).toBe(1);
    expect(box.health().pending).toBe(2);
    expect((await importV2History(collector, box, path, { directory: "/project" })).sessions).toBe(0);
    await importV2History(collector, box, path, { directory: "/project", all: true });
    expect(box.health().pending).toBe(2);
    db.query("UPDATE session_v2 SET time_updated=300 WHERE id='ses_v2'").run();
    db.query("UPDATE session_message SET time_updated=300,data=? WHERE id='msg_v2'").run(JSON.stringify({ ...message, tokens: { ...tokens, input: 20 } }));
    expect((await importV2History(collector, box, path, { directory: "/project" })).sessions).toBe(1);
    const events = box.db.query("SELECT payload FROM outbox").all() as any[];
    expect(events.map(row => JSON.parse(row.payload)).some(event => event.sessionId === "ses_other")).toBe(false);
    expect(JSON.parse(events.at(-1).payload).data.inputTokens).toBe(20);
    expect((await importV2History(collector, box, path, { signal: AbortSignal.abort(), all: true })).sessions).toBe(0);
  } finally {
    db.close(); await box.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("V2 plugin hydrates an existing session and ignores events from other locations", async () => {
  const dir = await mkdtemp("/tmp/opencode/v2-plugin-test-");
  const oldConfig = process.env.XDG_CONFIG_HOME, oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = dir; process.env.XDG_DATA_HOME = dir;
  let cleanup: any;
  try {
    const { saveConfig } = await import("../packages/plugin/src/config.js");
    await saveConfig({ ...config, url: "http://127.0.0.1:1", autoImport: false });
    const tools = new Map<string, any>(), hooks = new Map<string, any>();
    const plugin = (await import("../packages/plugin/src/v2/index.js")).default;
    const info = { id: "ses_existing", projectID: "prj_actual", title: "Existing session", location: { directory: dir }, model: { id: "model", providerID: "openai" }, time: { created: 100, updated: 200 } };
    const input: any = {
      app: { version: "2.1.4" }, location: { directory: dir, project: { id: "prj_actual" } },
      plugin: { list: async () => [] },
      integration: { connection: { active: async () => undefined } },
      aisdk: { hook: async () => ({ dispose: async () => {} }) },
      session: { get: async ({ sessionID }: any) => ({ ...info, id: sessionID, location: { directory: sessionID === "ses_other" ? "/other" : dir } }), hook: async (name: string, hook: any) => { hooks.set(name, hook); } },
      event: { subscribe: async function* () {
        yield { type: "session.step.started", created: 300, data: { sessionID: "ses_existing", assistantMessageID: "msg_existing", started: 300 } };
        yield { type: "session.step.started", created: 300, data: { sessionID: "ses_other", assistantMessageID: "msg_other", started: 300 } };
      } },
      tool: { transform: async (fn: any) => fn({ add: (tool: any) => tools.set(tool.name, tool) }) },
    };
    cleanup = await plugin.setup(input);
    await hooks.get("model.request")({ sessionID: "ses_existing", model: info.model, agent: "build" });
    const db = new Database(join(dir, "opencode-observatory/outbox.db"), { readonly: true });
    try {
      const records = (db.query("SELECT payload FROM outbox").all() as any[]).map(row => JSON.parse(row.payload));
      expect(records.some(record => record.kind === "session" && record.entityId === "ses_existing")).toBe(true);
      expect(records.some(record => record.sessionId === "ses_other")).toBe(false);
      expect(tools.has("observatory_import")).toBe(true);
    } finally { db.close(); }
  } finally {
    await cleanup?.();
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
    if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});
