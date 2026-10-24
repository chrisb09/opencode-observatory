import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { foldClaims, type ClaimInput } from "../apps/server/src/vault-model.js";
import { conceptPath, VaultGit } from "../apps/server/src/vault-git.js";
import { renderConcept } from "../apps/server/src/vault-render.js";

const installationId = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/opencode/vault-git-test-");
  roots.push(root);
  return root;
}

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  const validFrom = overrides.validFrom ?? 1_000;
  return {
    concept: "projects/observatory/vault",
    subject: "observatory.vault.storage",
    statement: "The knowledge vault is stored as one Git repository per tenant.",
    polarity: "affirm",
    modality: "fact",
    scope: "global",
    evidenceTier: "tool_verified",
    singleValued: true,
    evidence: [
      {
        installationId,
        sessionId: `ses_${validFrom}`,
        messageId: `msg_${validFrom}`,
        partId: null,
        tool: null,
        url: null,
        observedAt: validFrom,
      },
    ],
    contradicts: [],
    validFrom,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Git vault", () => {
  test("renders identically regardless of claim order", () => {
    const folded = foldClaims([
      claim({ validFrom: 1_000 }),
      claim({ validFrom: 2_000, subject: "observatory.vault.commit", statement: "The server is the only writer.", polarity: "affirm" }),
      claim({ validFrom: 3_000, statement: "The vault uses plain Git.", polarity: "affirm" }),
    ]);
    const forward = renderConcept({ concept: "projects/observatory/vault", claims: folded.claims });
    const reverse = renderConcept({ concept: "projects/observatory/vault", claims: [...folded.claims].reverse() });
    expect(reverse).toBe(forward);
    expect(forward).toContain("<!-- claim:clm_");
    expect(forward).toContain("The knowledge vault is stored");
  });

  test("commits provenance trailers, is idempotent, and preserves curated prose", async () => {
    const root = await temporaryRoot();
    const userId = randomUUID();
    const vault = new VaultGit(root);
    const documents = [
      {
        concept: "projects/observatory/vault",
        title: "Knowledge Vault",
        claims: foldClaims([claim()]).claims,
      },
    ];

    const first = await vault.commitConcepts(userId, documents, "vault(observatory): record storage model", {
      authorName: "Christian",
      authorEmail: "christian@example.test",
      installationId,
      machine: "xiaomi-notebook-pro",
      rootSessionId: "ses_root",
      evidenceSessionId: "ses_child",
      messageIds: ["msg_1", "msg_2"],
      agent: "build",
      model: "openai/gpt-test",
      promptVersion: "v1",
      evidenceTier: "tool_verified",
    });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.paths).toEqual(["concepts/projects/observatory/vault.md"]);

    const markdown = await vault.read(userId, first.paths[0]!);
    expect(markdown).toContain("## Active claims");
    expect(markdown).toContain("### Scope `global`");
    expect(markdown).toContain("The knowledge vault is stored");

    const log = await vault.log(userId);
    expect(log).toHaveLength(1);
    expect(log[0]!.author).toBe("Christian");
    expect(log[0]!.email).toBe("christian@example.test");
    expect(log[0]!.trailers["X-Observatory-Installation"]).toBe(installationId);
    expect(log[0]!.trailers["X-Observatory-Machine"]).toBe("xiaomi-notebook-pro");
    expect(log[0]!.trailers["X-Observatory-Root-Session"]).toBe("ses_root");
    expect(log[0]!.trailers["X-Observatory-Evidence-Session"]).toBe("ses_child");
    expect(log[0]!.trailers["X-Observatory-Messages"]).toBe("msg_1, msg_2");
    expect(log[0]!.trailers["X-Observatory-Model"]).toBe("openai/gpt-test");

    const replay = await vault.commitConcepts(userId, documents, "vault(observatory): replay");
    expect(replay.commit).toBeNull();

    const absolute = join(vault.repository(userId), first.paths[0]!);
    const edited = markdown.replace(
      "<!-- Prose between these markers is preserved by the renderer. Generated claims are updated below. -->",
      "Curated by a human: the vault is the semantic layer.",
    );
    await writeFile(absolute, edited);

    const updated = await vault.commitConcepts(
      userId,
      [{ ...documents[0]!, claims: foldClaims([claim(), claim({ validFrom: 2_000, subject: "observatory.vault.scope", statement: "Claims are scoped globally, per project, or per machine." })]).claims }],
      "vault(observatory): add scoping note",
    );
    expect(updated.commit).toMatch(/^[0-9a-f]{40}$/);
    const after = await vault.read(userId, first.paths[0]!);
    expect(after).toContain("Curated by a human: the vault is the semantic layer.");
    expect(after).toContain("Claims are scoped globally");

    const blame = await vault.blame(userId, first.paths[0]!);
    expect(blame.length).toBeGreaterThan(0);
    expect(blame.some(line => line.content.includes("Curated by a human"))).toBe(true);
    expect(blame.every(line => /^[0-9a-f]{40}$/.test(line.commit))).toBe(true);

    const latest = (await vault.log(userId))[0]!;
    const trailers = await vault.commitTrailers(userId, latest.commit);
    expect(trailers["X-Observatory-Machine"]).toBeUndefined();
    expect(trailers["X-Observatory-Root-Session"]).toBeUndefined();

    await expect(vault.read(userId, "../escape.md")).rejects.toThrow("invalid vault path");
    expect(() => conceptPath("../escape")).toThrow("invalid concept");
    expect(() => vault.repository("not-a-uuid")).toThrow("invalid user id");
  });

  test("writes only explicit paths and leaves unrelated worktree edits alone", async () => {
    const root = await temporaryRoot();
    const userId = randomUUID();
    const vault = new VaultGit(root);
    const first = await vault.commitConcepts(
      userId,
      [{ concept: "one", claims: foldClaims([claim({ concept: "one" })]).claims }],
      "vault: one",
    );
    expect(first.commit).not.toBeNull();

    const dir = vault.repository(userId);
    const dirty = join(dir, "notes.txt");
    await writeFile(dirty, "uncommitted");
    const second = await vault.commitConcepts(
      userId,
      [{ concept: "two", claims: foldClaims([claim({ concept: "two" })]).claims }],
      "vault: two",
    );
    expect(second.commit).not.toBeNull();
    expect(await readFile(dirty, "utf8")).toBe("uncommitted");

    const listed = await vault.list(userId);
    expect(listed).toEqual(["concepts/one.md", "concepts/two.md"]);
  });
});
