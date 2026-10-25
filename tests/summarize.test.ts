import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Outbox } from "../packages/plugin/src/outbox.js";
import { buildPrompt, parseDigest, parseModelSpec, summarizeBatch, summarizeSession, SummaryWorker } from "../packages/plugin/src/summarize.js";
import { config } from "./fixtures.js";

const roots: string[] = [];
const SECRET = "sk-1234567890abcdef12345678";

async function fixture(root: string) {
  const history = join(root, "opencode.db");
  const db = new Database(history);
  db.exec(`CREATE TABLE session_v2(id TEXT,project_id TEXT,parent_id TEXT,directory TEXT,title TEXT,agent TEXT,model TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_updated INTEGER,data TEXT);`);
  db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?,?)").run("ses_root", "prj_test", null, "/project", "Fix the GPU flag", "build", "openai/model", 100, 200);
  db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?,?)").run("ses_child", "prj_test", "ses_root", "/project", "Explore the flag", "explore", "openai/model", 110, 190);
  db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_u", "ses_root", "user", 1, 100, JSON.stringify({ type: "user", text: `Try ${SECRET}`, time: { created: 100 } }));
  db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_a", "ses_root", "assistant", 2, 120, JSON.stringify({
    type: "assistant",
    time: { created: 110 },
    content: [
      { type: "text", text: "The flag is correct." },
      { type: "tool", id: "tool_1", name: "bash", state: { status: "completed", input: { command: "srun --test" }, output: "ok" } },
    ],
  }));
  db.query("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_c", "ses_child", "user", 1, 150, JSON.stringify({ type: "user", text: "Look at the scheduler docs", time: { created: 150 } }));
  db.close();
  return history;
}

function digestText() {
  return JSON.stringify({
    messages: [
      { messageId: "msg_u", kind: "prompt", summaryShort: `Asked about ${SECRET}`, summaryDetailed: "The user wants the flag corrected." },
      { messageId: "msg_a", kind: "response", summaryShort: "Verified the flag", summaryDetailed: "A tool run confirmed the flag." },
    ],
    session: {
      summaryShort: "Fixed the GPU flag",
      summaryDetailed: "The session verified the GPU flag with a test run.",
      keyDecisions: ["Use --gpus-per-task=1"],
      filesTouched: ["src/gpu.ts"],
      concepts: ["hpc/slurm"],
    },
    claims: [
      {
        concept: "hpc/slurm",
        subject: "slurm.gpu.binding",
        statement: `Use --gpus-per-task=1; token ${SECRET}`,
        polarity: "affirm",
        modality: "fact",
        scope: "global",
        scopeValue: null,
        evidenceTier: "tool_verified",
        singleValued: true,
        messageIds: ["msg_a"],
        contradicts: [],
      },
    ],
  });
}

async function deps(root: string, posts: { summaries: any[]; claims: any[]; prompts: string[] }) {
  const history = await fixture(root);
  const box = new Outbox({ ...config, historyDatabase: history, contentMode: "full", summaryMode: "live" }, join(root, "outbox.db"));
  const models: string[] = [];
  const fetcher = (async (input: any, init: any) => {
    const url = String(input);
    const body = JSON.parse(init?.body ?? "{}");
    if (url.endsWith("/api/summaries")) posts.summaries.push(body);
    else if (url.endsWith("/api/vault/claims")) posts.claims.push(body);
    return Response.json({ ok: true });
  }) as typeof fetch;
  const generate = async ({ prompt, model }: any) => {
    models.push(`${model.providerID}/${model.id}`);
    posts.prompts.push(prompt);
    if (model.providerID === "antigravity") throw new Error("quota exhausted");
    return { text: digestText() };
  };
  return {
    history,
    box,
    models,
    dependencies: {
      config: { ...config, historyDatabase: history, contentMode: "full" as const, summaryMode: "live" as const, summaryModels: ["antigravity/antigravity-gemini-3.8-flash#high", "opencode-go/deepseek-v4.1-flash#max"] },
      outbox: box,
      directory: "/project",
      projectId: "prj_test",
      generate,
      fetcher,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("summary model and output handling", () => {
  test("parses model references and tolerates fenced JSON", () => {
    expect(parseModelSpec("antigravity/antigravity-gemini-3.8-flash#high")).toEqual({ providerID: "antigravity", id: "antigravity-gemini-3.8-flash", variant: "high" });
    expect(parseModelSpec("broken")).toBeNull();
    const parsed = parseDigest("```json\n{\"session\":{\"summaryShort\":\"s\",\"summaryDetailed\":\"d\"}}\n```");
    expect(parsed.session.summaryShort).toBe("s");
    expect(parsed.messages).toEqual([]);
    expect(parsed.claims).toEqual([]);
    expect(() => parseDigest("no object here")).toThrow();
  });

  test("builds a redacted prompt with stable message ids", () => {
    const session = { id: "ses_root", project_id: "prj_test", parent_id: null, directory: "/project", title: "GPU", agent: "build", model: "openai/model", time_created: 100, time_updated: 200 };
    const built = buildPrompt(session as any, [
      { id: "msg_u", type: "user", seq: 1, time_updated: 100, data: JSON.stringify({ text: `Try ${SECRET}`, time: { created: 100 } }) },
      { id: "msg_a", type: "assistant", seq: 2, time_updated: 120, data: JSON.stringify({ time: { created: 110 }, content: [{ type: "text", text: "ok" }] }) },
    ], "tester@fixture");
    expect(built.prompt).toContain("msg_u");
    expect(built.prompt).toContain("msg_a");
    expect(built.prompt).toContain("sk-[REDACTED]");
    expect(built.prompt).not.toContain(SECRET);
    expect(built.sourceHash.startsWith("sha256:")).toBe(true);
  });
});

describe("summarizeSession", () => {
  test("falls back from Gemini to DeepSeek, posts redacted summaries and root-only claims", async () => {
    const root = await mkdtemp("/tmp/opencode/summarize-test-");
    roots.push(root);
    const posts = { summaries: [] as any[], claims: [] as any[], prompts: [] as string[] };
    const fixtureData = await deps(root, posts);
    try {
      const result = await summarizeSession(fixtureData.dependencies, "ses_root");
      expect(result.processed).toBe(true);
      expect(result.messageSummaries).toBe(2);
      expect(result.claims).toBe(1);
      expect(fixtureData.models).toEqual(["antigravity/antigravity-gemini-3.8-flash", "opencode-go/deepseek-v4.1-flash"]);
      expect(posts.summaries).toHaveLength(3);
      expect(posts.summaries.map(item => item.targetKind).sort()).toEqual(["message", "message", "session"]);
      for (const summary of posts.summaries) {
        expect(JSON.stringify(summary)).not.toContain(SECRET);
        expect(summary.generatorModel).toBe("opencode-go/deepseek-v4.1-flash#max");
      }
      expect(posts.claims).toHaveLength(1);
      expect(posts.claims[0].source.rootSessionId).toBe("ses_root");
      expect(posts.claims[0].source.evidenceSessionId).toBe("ses_root");
      expect(posts.claims[0].claims[0].statement).toContain("sk-[REDACTED]");
      expect(JSON.stringify(posts.claims)).not.toContain(SECRET);
      expect(fixtureData.box.summaryState("ses_root")?.status).toBe("done");

      const child = await summarizeSession(fixtureData.dependencies, "ses_child");
      expect(child.processed).toBe(true);
      expect(child.claims).toBe(0);
      // The child still gets message/session summaries, but never promotes claims.
      expect(posts.claims).toHaveLength(1);
      expect(posts.summaries.filter(item => item.sessionId === "ses_child").length).toBeGreaterThan(0);

      const batch = await summarizeBatch(fixtureData.dependencies, { limit: 10 });
      expect(batch.processed).toBe(0);
      expect(batch.skipped).toBe(2);
      expect(batch.done).toBe(2);
    } finally {
      await fixtureData.box.close();
    }
  });

  test("does not send a transcript secret to the model", async () => {
    const root = await mkdtemp("/tmp/opencode/summarize-secret-test-");
    roots.push(root);
    const posts = { summaries: [] as any[], claims: [] as any[], prompts: [] as string[] };
    const fixtureData = await deps(root, posts);
    try {
      await summarizeSession(fixtureData.dependencies, "ses_root");
      expect(posts.prompts).toHaveLength(2);
      for (const prompt of posts.prompts) expect(prompt).not.toContain(SECRET);
    } finally {
      await fixtureData.box.close();
    }
  });

  test("SummaryWorker coalesces and drains queued live sessions", async () => {
    const root = await mkdtemp("/tmp/opencode/summarize-worker-test-");
    roots.push(root);
    const posts = { summaries: [] as any[], claims: [] as any[], prompts: [] as string[] };
    const fixtureData = await deps(root, posts);
    const worker = new SummaryWorker(fixtureData.dependencies, 0);
    try {
      worker.enqueue("ses_root");
      worker.enqueue("ses_root");
      await worker.drain();
      expect(posts.summaries).toHaveLength(3);
      expect(fixtureData.box.summaryState("ses_root")?.status).toBe("done");
    } finally {
      worker.close();
      await fixtureData.box.close();
    }
  });
});
