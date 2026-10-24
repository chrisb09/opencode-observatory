import { describe, expect, test } from "bun:test";
import { Collector } from "../packages/plugin/src/metadata.js";
import { setModelContext, wrapLanguageModel } from "../packages/plugin/src/v2/wrap.js";
import { accountData } from "../packages/plugin/src/v2/transport.js";
import { observeEvent } from "../packages/plugin/src/v2/events.js";
import { config, runtime } from "./fixtures.js";

describe("quota-router request attribution", () => {
  test("concurrent pinned accounts use their own session headers, not the last model context", async () => {
    const events: any[] = [];
    const collector = new Collector(config, runtime, event => events.push(event));
    collector.accounts.set("ses_a", { account: "GLOBAL_ACTIVE", credential: "WRONG_KEY", authType: "oauth" });
    setModelContext(collector, "antigravity:model", { sessionID: "ses_b", messageID: "msg_b", agent: "research", variant: "high" });
    const inner: any = { specificationVersion: "v3", provider: "google", modelId: "model", supportedUrls: {}, doGenerate: async () => ({ usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0 }, outputTokens: { total: 5 } }, finishReason: { unified: "stop" } }) };
    const wrapped = wrapLanguageModel(inner, "antigravity", "model", collector, "antigravity:model");
    await Promise.all(["a", "b"].map(name => wrapped.doGenerate({ prompt: [], headers: { "x-opencode-session-id": `ses_${name}`, "x-opencode-router-account": `${name}@example.com`, "x-opencode-router-agent": "explore", "x-opencode-router-model": "antigravity/model#medium" } })));
    const completed = events.filter(e => e.data.status === "completed");
    expect(completed).toHaveLength(2);
    for (const name of ["a", "b"]) expect(completed.find(e => e.sessionId === `ses_${name}`).data).toMatchObject({ account: `${name}@example.com`, credential: null, agent: "explore", variant: "medium" });
    expect(JSON.stringify(events)).not.toContain("WRONG_KEY");
    observeEvent({ type: "session.step.ended", created: 100, data: { sessionID: "ses_a", assistantMessageID: "msg_a", tokens: { input: 10, output: 5 } } }, collector);
    expect(events.at(-1).data.account).toBe("a@example.com");
  });
  test("Go attribution follows its actual Console integration", async () => {
    const seen: string[] = [];
    const ctx: any = { provider: { get: async () => ({ data: { integrationID: "opencode" } }) }, integration: { connection: { active: async (id: string) => { seen.push(id); return { type: "credential", id: "console" }; }, resolve: async () => ({ type: "oauth", access: "TEST_ACCESS_NOT_LOGGED", metadata: { email: "user@example.com" } }) } } };
    const collector = new Collector(config, runtime, () => {});
    const data = await accountData(ctx, collector, config, "opencode-go");
    expect(seen).toEqual(["opencode"]);
    expect(data.account).toBe("user@example.com");
    expect(JSON.stringify(data)).not.toContain("TEST_ACCESS_NOT_LOGGED");
  });
});
