import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { extractCurated, renderConcept, type ConceptDocument } from "./vault-render.js";
import type { FoldedClaim } from "./vault-model.js";

/**
 * Server-side Git vault. One repository per tenant. Only the server writes;
 * clients never push, so `main` has a single linear history.
 */

export interface CommitTrailers {
  authorName?: string;
  authorEmail?: string;
  installationId?: string;
  machine?: string;
  rootSessionId?: string;
  evidenceSessionId?: string;
  messageIds?: string[];
  agent?: string;
  model?: string;
  promptVersion?: string;
  evidenceTier?: string;
}

export interface VaultCommit {
  commit: string | null;
  paths: string[];
}

export interface VaultLogEntry {
  commit: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
}

export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  summary: string;
  content: string;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONCEPT = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? "/tmp",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Observatory",
  GIT_AUTHOR_EMAIL: "observatory@localhost",
  GIT_COMMITTER_NAME: "Observatory",
  GIT_COMMITTER_EMAIL: "observatory@localhost",
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...BASE_ENV, ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(`git ${args[0]} failed: ${stderr || error.message}`), { stderr }));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function safeRelative(directory: string, path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`invalid vault path: ${path}`);
  }
  const absolute = resolve(directory, path);
  if (absolute !== directory && !absolute.startsWith(`${directory}${sep}`)) {
    throw new Error(`vault path escapes repository: ${path}`);
  }
  return path;
}

export function conceptPath(concept: string): string {
  if (!CONCEPT.test(concept) || concept.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`invalid concept: ${concept}`);
  }
  return `concepts/${concept}.md`;
}

function trailerLines(trailers: CommitTrailers): [string, string][] {
  const values: [string, string | undefined][] = [
    ["X-Observatory-Installation", trailers.installationId],
    ["X-Observatory-Machine", trailers.machine],
    ["X-Observatory-Root-Session", trailers.rootSessionId],
    ["X-Observatory-Evidence-Session", trailers.evidenceSessionId],
    ["X-Observatory-Messages", trailers.messageIds?.join(", ")],
    ["X-Observatory-Agent", trailers.agent],
    ["X-Observatory-Model", trailers.model],
    ["X-Observatory-Prompt-Version", trailers.promptVersion],
    ["X-Observatory-Evidence-Tier", trailers.evidenceTier],
  ];
  return values
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([key, value]) => [key, value.replace(/[\r\n]+/g, " ").trim()]);
}

export function formatCommitMessage(message: string, trailers: CommitTrailers = {}): string {
  const subject = message.replace(/[\r\n]+/g, " ").trim() || "chore(vault): update";
  const lines = trailerLines(trailers);
  return lines.length ? `${subject}\n\n${lines.map(([key, value]) => `${key}: ${value}`).join("\n")}` : subject;
}

export function parseTrailers(body: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
    if (match) trailers[match[1]!] = match[2]!.trim();
  }
  return trailers;
}

export class VaultGit {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly root: string = process.env.VAULT_ROOT ?? "/data/vault") {}

  repository(userId: string): string {
    if (!USER_ID.test(userId)) throw new Error("invalid user id");
    return join(this.root, userId);
  }

  private async serialized<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const current = previous.then(run, run);
    this.locks.set(userId, current.then(() => undefined, () => undefined));
    return current;
  }

  async ensure(userId: string): Promise<string> {
    const directory = this.repository(userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await stat(join(directory, ".git"));
    } catch {
      await git(directory, ["init", "-q", "-b", "main"]);
      await git(directory, ["config", "user.name", "Observatory"]);
      await git(directory, ["config", "user.email", "observatory@localhost"]);
      await git(directory, ["config", "commit.gpgsign", "false"]);
      await git(directory, ["config", "core.autocrlf", "false"]);
    }
    return directory;
  }

  /**
   * Render and commit a batch of concept documents. Identical content produces
   * no commit, so replaying the fold is idempotent.
   */
  async commitConcepts(
    userId: string,
    documents: ConceptDocument[],
    message: string,
    trailers: CommitTrailers = {},
  ): Promise<VaultCommit> {
    return this.serialized(userId, async () => {
      const directory = await this.ensure(userId);
      const paths: string[] = [];
      const unique = new Map<string, ConceptDocument>();
      for (const document of documents) unique.set(conceptPath(document.concept), document);

      for (const [path, document] of unique) {
        const absolute = join(directory, safeRelative(directory, path));
        const previous = await readFile(absolute, "utf8").catch(() => null);
        const rendered = renderConcept({ ...document, curated: previous ? extractCurated(previous) : null });
        if (rendered === previous) continue;
        await mkdir(dirname(absolute), { recursive: true });
        const temporary = `${absolute}.${randomUUID()}.tmp`;
        await writeFile(temporary, rendered, { mode: 0o600 });
        await rename(temporary, absolute);
        paths.push(path);
      }

      if (!paths.length) return { commit: null, paths };
      await git(directory, ["add", "--", ...paths]);
      const status = await git(directory, ["status", "--porcelain", "--", ...paths]);
      if (!status.stdout.trim()) return { commit: null, paths };

      const name = trailers.authorName?.trim() || "Observatory";
      const email = trailers.authorEmail?.trim() || "observatory@localhost";
      const staged = await git(directory, ["diff", "--cached", "--name-only", "--", ...paths]);
      if (!staged.stdout.trim()) return { commit: null, paths };
      await git(directory, ["commit", "-q", "--no-verify", "--cleanup=verbatim", "--only", "-m", formatCommitMessage(message, trailers), "--", ...paths], {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      });
      const commit = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
      return { commit, paths };
    });
  }

  async read(userId: string, path: string): Promise<string> {
    const directory = await this.ensure(userId);
    return readFile(join(directory, safeRelative(directory, path)), "utf8");
  }

  async list(userId: string): Promise<string[]> {
    const directory = await this.ensure(userId);
    const result = await git(directory, ["ls-files", "--", "*.md"]);
    return result.stdout.split("\n").filter(Boolean).sort();
  }

  async log(userId: string, options: { path?: string; limit?: number } = {}): Promise<VaultLogEntry[]> {
    return this.serialized(userId, async () => {
      const directory = await this.ensure(userId);
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
      const args = ["log", `-n${limit}`, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"];
      if (options.path) args.push("--", safeRelative(directory, options.path));
      const result = await git(directory, args);
      return result.stdout
        .split("\x1e")
        .map(record => record.replace(/^\n+/, ""))
        .filter(Boolean)
        .map(record => {
          const [commit = "", author = "", email = "", date = "", subject = "", ...rest] = record.split("\x1f");
          const body = rest.join("\x1f").trim();
          return { commit, author, email, date, subject, body, trailers: parseTrailers(body) };
        })
        .filter(entry => COMMIT.test(entry.commit));
    });
  }

  async blame(userId: string, path: string): Promise<BlameLine[]> {
    return this.serialized(userId, async () => {
      const directory = await this.ensure(userId);
      const result = await git(directory, ["blame", "--line-porcelain", "--", safeRelative(directory, path)]);
      const entries: BlameLine[] = [];
      let commit = "";
      let author = "";
      let summary = "";
      let line = 0;
      for (const value of result.stdout.split("\n")) {
        const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(value);
        if (header) {
          commit = header[1]!;
          author = "";
          summary = "";
          line += 1;
          continue;
        }
        if (value.startsWith("author ")) author = value.slice(7);
        else if (value.startsWith("summary ")) summary = value.slice(8);
        else if (value.startsWith("\t")) {
          entries.push({ line, commit, author, summary, content: value.slice(1) });
          commit = "";
        }
      }
      return entries;
    });
  }

  async commitTrailers(userId: string, commit: string): Promise<Record<string, string>> {
    if (!COMMIT.test(commit)) throw new Error("invalid commit hash");
    return this.serialized(userId, async () => {
      const directory = await this.ensure(userId);
      const result = await git(directory, ["show", "-s", "--format=%B", commit]);
      return parseTrailers(result.stdout);
    });
  }
}

export function conceptDocument(concept: string, claims: FoldedClaim[], title?: string | null): ConceptDocument {
  return { concept, claims, title };
}
