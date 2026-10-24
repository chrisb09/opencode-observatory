import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Collector } from "../packages/plugin/src/metadata.js";
import { Outbox } from "../packages/plugin/src/outbox.js";
import { importHistory } from "../packages/plugin/src/history.js";
import { importV2History } from "../packages/plugin/src/v2/history.js";
import { observeEvent } from "../packages/plugin/src/v2/events.js";
import { config, runtime } from "./fixtures.js";
import type { ContentPart } from "@observatory/contracts";

const roots: string[] = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/opencode/content-paths-test-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function contentCollector(parts: ContentPart[], mode: "off" | "text" | "full" = "full") {
  const collector = new Collector({ ...config, contentMode: mode }, runtime, () => {});
  if (mode !== "off") collector.contentSink = part => parts.push(part);
  return collector;
}

describe("V2 transcript capture", () => {
  test("historical import captures user prompt, assistant text/reasoning, tool I/O, media, and compaction", async () => {
    const root = await temporaryRoot();
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,time_idle INTEGER,idle_outcome TEXT);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_updated INTEGER,data TEXT);`);
    db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)").run("ses_content", "prj_content", "/project", 100, 200, 200, "succeeded");
    db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_user", "ses_content", "user", 1, 100, JSON.stringify({
      id: "msg_user", type: "user", time: { created: 100 }, text: "question with sk-1234567890abcdef12345678",
      files: [{ uri: `data:image/png;base64,${png}`, mime: "image/png", name: "shot.png" }],
    }));
    db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_assistant", "ses_content", "assistant", 2, 150, JSON.stringify({
      id: "msg_assistant", type: "assistant", agent: "build", model: { providerID: "openai", id: "model" },
      time: { created: 110, completed: 150 },
      content: [
        { type: "text", id: "text_1", text: "answer" },
        { type: "reasoning", id: "reason_1", text: "thought", time: { created: 111, completed: 112 } },
        { type: "tool", id: "tool_1", name: "bash", time: { created: 120, ran: 121, completed: 130 }, state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] } },
      ],
    }));
    db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_comp", "ses_content", "compaction", 3, 160, JSON.stringify({
      id: "msg_comp", type: "compaction", summary: "compacted summary", time: { created: 160 },
    }));
    const parts: ContentPart[] = [];
    const collector = contentCollector(parts);
    const box = new Outbox({ ...config, contentMode: "full" }, join(root, "outbox.db"));
    try {
      expect((await importV2History(collector, box, path, { directory: "/project" })).sessions).toBe(1);
      const kinds = new Set(parts.map(part => part.kind));
      expect(kinds).toEqual(new Set(["prompt", "response", "reasoning", "tool_input", "tool_output", "media"]));
      expect(parts.find(part => part.kind === "prompt")!.text).not.toContain("sk-1234567890abcdef12345678");
      expect(parts.find(part => part.kind === "prompt")!.text).toContain("sk-[REDACTED]");
      const media = parts.find(part => part.kind === "media")!;
      expect(media.media?.availability).toBe("inline");
      expect(media.media?.width).toBe(1);
      expect(parts.some(part => part.kind === "response" && part.text === "compacted summary")).toBe(true);
    } finally {
      db.close(); await box.close();
    }
  });

  test("live session.next events normalize and capture, while off mode captures nothing", () => {
    const parts: ContentPart[] = [];
    const collector = contentCollector(parts);
    const send = (type: string, properties: any, created = 100) => observeEvent({ type, properties, created } as any, collector);
    send("session.next.prompted", { sessionID: "ses_live", messageID: "msg_user", prompt: { text: "live question" } });
    send("session.next.text.ended", { sessionID: "ses_live", assistantMessageID: "msg_a", textID: "text_a", text: "live answer" }, 110);
    send("session.next.reasoning.ended", { sessionID: "ses_live", assistantMessageID: "msg_a", reasoningID: "reason_a", text: "live thought" }, 111);
    send("session.next.tool.called", { sessionID: "ses_live", assistantMessageID: "msg_a", callID: "call_a", tool: "bash", input: { command: "echo hi" } }, 120);
    send("session.next.tool.success", { sessionID: "ses_live", assistantMessageID: "msg_a", callID: "call_a", content: [{ type: "text", text: "hi" }] }, 121);
    expect(parts.map(part => part.kind)).toEqual(["prompt", "response", "reasoning", "tool_input", "tool_output"]);
    expect(parts.find(part => part.kind === "prompt")!.text).toBe("live question");
    expect(parts.find(part => part.kind === "tool_output")!.text).toBe("hi");

    const off: ContentPart[] = [];
    const disabled = contentCollector(off, "off");
    observeEvent({ type: "session.next.text.ended", properties: { sessionID: "ses_off", assistantMessageID: "msg_off", textID: "t", text: "must not leave" } } as any, disabled);
    expect(off).toHaveLength(0);
  });
});

describe("V1 transcript capture", () => {
  test("historical import captures user text, assistant text/reasoning/tool, and media", async () => {
    const root = await temporaryRoot();
    const path = join(root, "history.db");
    const db = new Database(path);
    db.exec("CREATE TABLE session(id TEXT,project_id TEXT,parent_id TEXT,version TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);");
    db.query("INSERT INTO session VALUES(?,?,?,?,?,?)").run("ses_v1", "prj_v1", null, "1.18.0", 100, 300);
    db.query("INSERT INTO message VALUES(?,?,?,?,?)").run("msg_u", "ses_v1", JSON.stringify({ role: "user", time: { created: 100 } }), 100, 100);
    db.query("INSERT INTO message VALUES(?,?,?,?,?)").run("msg_a", "ses_v1", JSON.stringify({ role: "assistant", providerID: "openai", modelID: "model", time: { created: 110, completed: 200 } }), 110, 200);
    db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_prompt", "msg_u", "ses_v1", JSON.stringify({ type: "text", text: "v1 question" }), 100, 100);
    db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_text", "msg_a", "ses_v1", JSON.stringify({ type: "text", text: "v1 answer" }), 110, 110);
    db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_reason", "msg_a", "ses_v1", JSON.stringify({ type: "reasoning", text: "v1 thought" }), 111, 111);
    db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_tool", "msg_a", "ses_v1", JSON.stringify({ type: "tool", tool: "bash", callID: "call_v1", state: { status: "completed", input: { command: "echo hi" }, output: "hi", time: { start: 120, end: 130 } } }), 120, 130);
    db.query("INSERT INTO part VALUES(?,?,?,?,?,?)").run("part_file", "msg_a", "ses_v1", JSON.stringify({ type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${png}` }), 140, 140);
    const parts: ContentPart[] = [];
    const collector = contentCollector(parts);
    const box = new Outbox({ ...config, contentMode: "full" }, join(root, "outbox.db"));
    try {
      expect((await importHistory(collector, box, path)).sessions).toBe(1);
      expect(parts.map(part => part.kind)).toEqual(["prompt", "response", "reasoning", "tool_input", "tool_output", "media"]);
      expect(parts.find(part => part.kind === "prompt")!.text).toBe("v1 question");
      expect(parts.find(part => part.kind === "response")!.text).toBe("v1 answer");
      expect(parts.find(part => part.kind === "tool_output")!.text).toBe("hi");
      expect(parts.find(part => part.kind === "media")!.media?.width).toBe(1);
    } finally {
      db.close(); await box.close();
    }
  });
});
