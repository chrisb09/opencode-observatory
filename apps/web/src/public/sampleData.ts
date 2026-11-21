// Synthetic data only. Every name, model, machine, account, and measurement
// below is fictional. The sample workspace never fetches or mutates data.
export const SAMPLE_FROM = Date.UTC(2025, 8, 8);
export const SAMPLE_TO = Date.UTC(2025, 8, 15);
export const SAMPLE_LABEL = "Sep 8–14, 2025 · fixed demonstration week";

export type SampleRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SampleModel = {
  id: string;
  name: string;
  provider: string;
  contextLimit: number;
  rates: SampleRates;
};
export type SampleAccount = { id: string; label: string; provider: string; kind: "OAuth" | "API key"; note: string };
export type SampleMachine = { id: string; label: string; os: string; install: string; runtimes: { opencode: string; collector: string } };
export type SampleStep = {
  id: string;
  provider: string;
  model: string;
  modelId: string;
  accountId: string;
  status: "completed" | "failed" | "cancelled";
  httpStatus: number | null;
  startedAt: number;
  durationMs: number;
  firstOutputMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  marketCost: number;
  cacheSavings: number;
};
export type SampleSession = {
  id: string;
  title: string;
  agent: "build" | "plan" | "review";
  machineId: string;
  machine: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  marketCost: number;
  cacheSavings: number;
  summary: string;
  detailedSummary: string;
  decisions: string[];
  files: string[];
  steps: SampleStep[];
};
export type SampleAttempt = {
  id: string;
  sessionId: string;
  stepId: string | null;
  provider: string;
  model: string;
  modelId: string;
  machine: string;
  accountId: string;
  status: "completed" | "failed" | "cancelled";
  httpStatus: number | null;
  startedAt: number;
  durationMs: number;
  firstOutputMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  marketCost: number | null;
  usageSource: "provider" | "OpenCode";
  error: string | null;
  retry: boolean;
};
export type SampleTool = {
  id: string;
  tool: string;
  sessionId: string;
  machine: string;
  status: "completed" | "failed";
  startedAt: number;
  durationMs: number;
  argumentBytes: number;
  outputBytes: number;
  invocation: string;
};
export type SampleAttachment = {
  id: string;
  mime: string;
  name: string;
  sessionId: string;
  machine: string;
  bytes: number;
  hash: string;
  createdAt: number;
  note: string;
};
export type SampleSessionError = {
  id: string;
  error_type: string;
  error_code: string;
  provider: string;
  model: string;
  http_status: number | null;
  source: string;
  occurrences: number;
  sessions: number;
  retryable: number;
  last_seen: number;
  explanation: string;
};

export const sampleModels: SampleModel[] = [
  {
    id: "Aster Labs/Aster Forge 2",
    name: "Aster Forge 2",
    provider: "Aster Labs",
    contextLimit: 200000,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "Aster Labs/Aster Lite",
    name: "Aster Lite",
    provider: "Aster Labs",
    contextLimit: 128000,
    rates: { input: 0.35, output: 1.05, cacheRead: 0.035, cacheWrite: 0.44 },
  },
  {
    id: "Boreal AI/Boreal Voyager",
    name: "Boreal Voyager",
    provider: "Boreal AI",
    contextLimit: 200000,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "Boreal AI/Boreal Swift",
    name: "Boreal Swift",
    provider: "Boreal AI",
    contextLimit: 96000,
    rates: { input: 0.8, output: 2.4, cacheRead: 0.08, cacheWrite: 1 },
  },
];
export const sampleProviders = [...new Set(sampleModels.map(model => model.provider))];
export const sampleAccounts: SampleAccount[] = [
  {
    id: "sample-account-aster-studio",
    label: "Studio subscription",
    provider: "Aster Labs",
    kind: "OAuth",
    note: "Fictional OAuth subscription used by the studio machine. No token is shown or stored.",
  },
  {
    id: "sample-account-aster-sandbox",
    label: "Sandbox API key",
    provider: "Aster Labs",
    kind: "API key",
    note: "Fictional metered key used for experiments. Only an opaque sample fingerprint would be displayed.",
  },
  {
    id: "sample-account-boreal-team",
    label: "Research team key",
    provider: "Boreal AI",
    kind: "API key",
    note: "Fictional shared research key. No secret material exists in this demonstration.",
  },
];
export const sampleMachines: SampleMachine[] = [
  {
    id: "machine-studio",
    label: "studio-macbook",
    os: "macOS 15 · arm64",
    install: "sample-install-7f2a",
    runtimes: { opencode: "1.18.34", collector: "0.2.0" },
  },
  {
    id: "machine-ci",
    label: "ci-runner-01",
    os: "Ubuntu 24.04 · x64",
    install: "sample-install-c91b",
    runtimes: { opencode: "1.18.34", collector: "0.2.0" },
  },
  {
    id: "machine-home",
    label: "home-workstation",
    os: "Windows 11 · x64",
    install: "sample-install-40de",
    runtimes: { opencode: "1.17.9", collector: "0.2.0" },
  },
];

const scenarios = [
  {
    title: "Add CSV export to billing",
    summary: "Traced the billing report builder and added a streamed CSV export with a typed column map.",
    detailed: "The export reuses the existing report query, streams rows instead of buffering, and includes an explicit escaping helper. Validation covered headers, quoted commas, and an empty result set.",
    decisions: ["Keep export server-side to avoid duplicating report rules", "Escape every cell, including headers"],
    files: ["src/billing/export.ts", "src/billing/report.ts", "tests/billing-export.test.ts"],
  },
  {
    title: "Investigate flaky auth integration test",
    summary: "Reproduced a timing-sensitive login test and isolated a stale cookie fixture between cases.",
    detailed: "The suite reused a signed cookie across clock-sensitive cases. The fix clears the fixture store between tests and uses an injected clock for expiry assertions.",
    decisions: ["Inject time instead of sleeping", "Reset cookie fixtures after each case"],
    files: ["tests/auth.integration.test.ts", "tests/support/cookies.ts"],
  },
  {
    title: "Refactor provider adapter selection",
    summary: "Split adapter selection into a pure resolver and added coverage for renamed model identifiers.",
    detailed: "The resolver now normalizes provider aliases before matching configured routes. Unknown providers fall back to the default adapter without retrying forever.",
    decisions: ["Keep resolution pure and unit-tested", "Preserve existing fallback behavior"],
    files: ["src/providers/resolver.ts", "src/providers/registry.ts", "tests/resolver.test.ts"],
  },
  {
    title: "Harden webhook signature checks",
    summary: "Added constant-time comparison and a replay window to the sample webhook receiver.",
    detailed: "Signatures are verified against the raw body before JSON parsing. Timestamps outside the configured window are rejected, and failures produce a bounded audit event.",
    decisions: ["Verify before parsing", "Use a five-minute replay window"],
    files: ["src/webhooks/signature.ts", "src/webhooks/receiver.ts"],
  },
  {
    title: "Speed up session search",
    summary: "Replaced an N+1 lookup with a batched query and added a covering index migration.",
    detailed: "The search endpoint now resolves installation metadata in one query. Measurements on the sample fixture improved without changing the response contract.",
    decisions: ["Batch by installation", "Add an index before changing the query"],
    files: ["src/search/sessions.ts", "migrations/0042_search_index.sql"],
  },
  {
    title: "Normalize cache token accounting",
    summary: "Documented overlapping cache and prompt counters and corrected the normalized total.",
    detailed: "The change keeps provider measurements intact while computing a display total that does not double-count cached prompt tokens. Unknown values remain unavailable.",
    decisions: ["Never invent missing measurements", "Keep cache ratios token-weighted"],
    files: ["src/usage/normalize.ts", "src/usage/types.ts", "tests/normalize.test.ts"],
  },
  {
    title: "Add retry budget to upload worker",
    summary: "Introduced a bounded retry budget with jitter and a clear terminal failure state.",
    detailed: "Uploads now stop after the configured attempt budget and surface a retryable classification. The worker records one final failure instead of an unbounded chain.",
    decisions: ["Bound total attempts, not only delays", "Persist the terminal state"],
    files: ["src/upload/worker.ts", "src/upload/state.ts"],
  },
  {
    title: "Tidy dashboard metric formatting",
    summary: "Unified compact number and currency formatting across sample analytics panels.",
    detailed: "Formatting helpers now treat null as unavailable instead of zero. Tooltip and axis values share the same formatter to avoid contradictory labels.",
    decisions: ["Unavailable is not zero", "Keep chart labels compact"],
    files: ["src/ui/format.ts", "src/ui/charts/UsageChart.tsx"],
  },
  {
    title: "Review attachment metadata pipeline",
    summary: "Audited attachment descriptors and confirmed only hashes and byte counts are retained.",
    detailed: "The review traced the descriptor from ingestion to the attachment view. Original file bytes are never stored; MIME type, size, and a hash are sufficient for the demo.",
    decisions: ["Store descriptors, not files", "Reject unbounded MIME labels"],
    files: ["src/attachments/descriptor.ts", "tests/attachment-descriptor.test.ts"],
  },
  {
    title: "Fix race in settings save",
    summary: "Serialized settings writes and added an optimistic revision check.",
    detailed: "Two rapid saves could overwrite each other. The form now sends the revision it read and surfaces a conflict instead of silently replacing newer values.",
    decisions: ["Use optimistic concurrency", "Keep the form's unsaved values on conflict"],
    files: ["src/settings/save.ts", "src/settings/form.tsx"],
  },
  {
    title: "Document local model routing",
    summary: "Wrote a concise routing guide with two providers and a fallback path.",
    detailed: "The guide explains how the demo chooses a model, how recorded cost differs from market value, and why unknown pricing is displayed as unavailable.",
    decisions: ["Use fictional providers in examples", "Separate recorded cost from market value"],
    files: ["docs/routing.md", "examples/routing.ts"],
  },
  {
    title: "Bound tool output capture",
    summary: "Capped stored tool output and preserved a truncation marker for the inspector.",
    detailed: "Large command output is now stored up to the documented limit. The tool row reports captured bytes and a clear truncation flag without changing the execution result.",
    decisions: ["Cap at the ingestion boundary", "Expose truncation explicitly"],
    files: ["src/tools/capture.ts", "tests/tool-capture.test.ts"],
  },
];

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const roundCost = (value: number) => Math.round(value * 1000000) / 1000000;
const weightedModel = (random: () => number) => {
  const roll = random();
  return sampleModels[roll < 0.44 ? 0 : roll < 0.68 ? 1 : roll < 0.88 ? 2 : 3]!;
};
const machineFor = (index: number) => sampleMachines[index % sampleMachines.length]!;
const accountFor = (model: SampleModel, random: () => number) =>
  model.provider === "Boreal AI" ? sampleAccounts[2]! : random() < 0.68 ? sampleAccounts[0]! : sampleAccounts[1]!;
const failureFor = (roll: number) =>
  roll < 0.055 ? { status: "failed" as const, httpStatus: roll < 0.02 ? 500 : 429, error: roll < 0.02 ? "upstream_5xx" : "rate_limit" } : roll < 0.075 ? { status: "cancelled" as const, httpStatus: 499, error: "cancelled" } : null;

type Built = {
  sessions: SampleSession[];
  attempts: SampleAttempt[];
  tools: SampleTool[];
  attachments: SampleAttachment[];
  errors: SampleSessionError[];
};

function build(): Built {
  const random = mulberry32(0x0b5e7a);
  const sessions: SampleSession[] = [];
  const attempts: SampleAttempt[] = [];
  const tools: SampleTool[] = [];
  const attachments: SampleAttachment[] = [];
  let serial = 0;
  const toolNames = ["bash", "read", "edit", "grep", "webfetch", "todowrite", "task"];
  const attachmentTypes = [
    { mime: "image/png", name: "layout-check.png", note: "Screenshot descriptor for a UI review" },
    { mime: "application/pdf", name: "sample-report.pdf", note: "PDF attachment descriptor" },
    { mime: "text/markdown", name: "review-notes.md", note: "Text attachment descriptor" },
    { mime: "audio/mpeg", name: "standup-clip.mp3", note: "Audio attachment descriptor" },
    { mime: "image/jpeg", name: "whiteboard.jpg", note: "Photo attachment descriptor" },
  ];

  for (let day = 0; day < 7; day++) {
    const count = day >= 5 ? 4 : 6;
    for (let slot = 0; slot < count; slot++) {
      serial++;
      const scenario = scenarios[serial % scenarios.length]!;
      const machine = machineFor(serial + day);
      const start = SAMPLE_FROM + day * 86400000 + (8 + Math.floor(random() * 13)) * 3600000 + Math.floor(random() * 60) * 60000;
      const calls = 2 + Math.floor(random() * 5);
      const primary = weightedModel(random);
      const sessionId = `ses_sample_${String(serial).padStart(3, "0")}`;
      const steps: SampleStep[] = [];
      let cursor = start;
      for (let call = 0; call < calls; call++) {
        const model = call > 0 && random() < 0.22 ? sampleModels[(sampleModels.indexOf(primary) + 1) % sampleModels.length]! : primary;
        const account = accountFor(model, random);
        const inputTokens = Math.round(1400 + random() * 17400);
        const cacheReadTokens = random() < 0.76 ? Math.round(inputTokens * (0.24 + random() * 0.58)) : 0;
        const cacheWriteTokens = random() < 0.36 ? Math.round(inputTokens * (0.02 + random() * 0.1)) : 0;
        const outputTokens = Math.round(160 + random() * 2400);
        const reasoningTokens =
          model.name === "Boreal Voyager"
            ? Math.round(outputTokens * (0.16 + random() * 0.48))
            : model.name === "Boreal Swift"
              ? Math.round(outputTokens * 0.04)
              : 0;
        const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens;
        const cost = roundCost(
          ((inputTokens * model.rates.input +
            cacheReadTokens * model.rates.cacheRead +
            cacheWriteTokens * model.rates.cacheWrite +
            (outputTokens + reasoningTokens) * model.rates.output) /
            1000000) *
            (account.kind === "OAuth" ? 0.9 : 1),
        );
        const marketCost = roundCost(
          (inputTokens * model.rates.input +
            cacheReadTokens * model.rates.cacheRead +
            cacheWriteTokens * model.rates.cacheWrite +
            (outputTokens + reasoningTokens) * model.rates.output) /
            1000000,
        );
        const cacheSavings = roundCost((cacheReadTokens * (model.rates.input - model.rates.cacheRead)) / 1000000);
        const failure = failureFor(random());
        const stepDuration = 24000 + Math.floor(random() * 156000);
        const step: SampleStep = {
          id: `step_sample_${String(serial).padStart(3, "0")}_${call + 1}`,
          provider: model.provider,
          model: model.name,
          modelId: model.id,
          accountId: account.id,
          status: failure?.status ?? "completed",
          httpStatus: failure?.httpStatus ?? 200,
          startedAt: cursor,
          durationMs: stepDuration,
          firstOutputMs: 220 + Math.floor(random() * 1200),
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens,
          cost,
          marketCost,
          cacheSavings,
        };
        steps.push(step);
        attempts.push({
          id: `attempt_sample_${String(serial).padStart(3, "0")}_${call + 1}`,
          sessionId,
          stepId: step.id,
          provider: model.provider,
          model: model.name,
          modelId: model.id,
          machine: machine.label,
          accountId: account.id,
          status: step.status,
          httpStatus: step.httpStatus,
          startedAt: step.startedAt,
          durationMs: step.durationMs,
          firstOutputMs: step.firstOutputMs,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          totalTokens: step.totalTokens,
          cost: step.cost,
          marketCost: step.marketCost,
          usageSource: random() < 0.72 ? "provider" : "OpenCode",
          error: failure?.error ?? null,
          retry: false,
        });
        if (failure) {
          attempts.push({
            id: `attempt_sample_retry_${String(serial).padStart(3, "0")}_${call + 1}`,
            sessionId,
            stepId: null,
            provider: model.provider,
            model: model.name,
            modelId: model.id,
            machine: machine.label,
            accountId: account.id,
            status: "completed",
            httpStatus: 200,
            startedAt: step.startedAt + step.durationMs + 1800,
            durationMs: 900 + Math.floor(random() * 3000),
            firstOutputMs: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            cost: null,
            marketCost: null,
            usageSource: "OpenCode",
            error: null,
            retry: true,
          });
        }
        cursor += stepDuration + 2500;
      }
      const status = steps.some(step => step.status === "failed")
        ? "failed"
        : steps.some(step => step.status === "cancelled")
          ? "cancelled"
          : "completed";
      const total = (key: keyof SampleStep) => steps.reduce((sum, step) => sum + Number(step[key] ?? 0), 0);
      const session: SampleSession = {
        id: sessionId,
        title: scenario.title,
        agent: (["build", "plan", "review"] as const)[serial % 3]!,
        machineId: machine.id,
        machine: machine.label,
        status,
        startedAt: start,
        endedAt: cursor,
        durationMs: cursor - start,
        calls: steps.length,
        inputTokens: total("inputTokens"),
        outputTokens: total("outputTokens"),
        reasoningTokens: total("reasoningTokens"),
        cacheReadTokens: total("cacheReadTokens"),
        cacheWriteTokens: total("cacheWriteTokens"),
        totalTokens: total("totalTokens"),
        cost: roundCost(total("cost")),
        marketCost: roundCost(total("marketCost")),
        cacheSavings: roundCost(total("cacheSavings")),
        summary: scenario.summary,
        detailedSummary: scenario.detailed,
        decisions: scenario.decisions,
        files: scenario.files,
        steps,
      };
      sessions.push(session);
      for (let tool = 0; tool < (serial % 4); tool++) {
        const failed = random() < 0.07;
        tools.push({
          id: `tool_sample_${String(serial).padStart(3, "0")}_${tool + 1}`,
          tool: toolNames[(serial + tool) % toolNames.length]!,
          sessionId,
          machine: machine.label,
          status: failed ? "failed" : "completed",
          startedAt: start + 30000 + tool * 42000,
          durationMs: 120 + Math.floor(random() * 2400),
          argumentBytes: 120 + Math.floor(random() * 2400),
          outputBytes: 400 + Math.floor(random() * 18000),
          invocation: `${toolNames[(serial + tool) % toolNames.length]!} · ${scenario.files[0]}`,
        });
      }
      for (let attachment = 0; attachment < (serial % 3 === 0 ? 2 : serial % 4 === 0 ? 1 : 0); attachment++) {
        const kind = attachmentTypes[(serial + attachment) % attachmentTypes.length]!;
        attachments.push({
          id: `att_sample_${String(serial).padStart(3, "0")}_${attachment + 1}`,
          mime: kind.mime,
          name: kind.name,
          sessionId,
          machine: machine.label,
          bytes: 12000 + Math.floor(random() * 4200000),
          hash: `sha256:sample:${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`,
          createdAt: start + 90000 + attachment * 110000,
          note: kind.note,
        });
      }
    }
  }

  return { sessions, attempts, tools, attachments, errors: groupSampleErrors(attempts) };
}

// Error groups are derived from the same attempts as every other sample view.
// Callers can pass a filtered attempt list so category counts and affected
// session counts stay consistent with the active sample filters.
export function groupSampleErrors(attempts: SampleAttempt[]): SampleSessionError[] {
  const groups = new Map<
    string,
    {
      error_type: string;
      error_code: string;
      provider: string;
      model: string;
      http_status: number | null;
      source: string;
      occurrences: number;
      sessions: Set<string>;
      retryable: number;
      last_seen: number;
      explanation: string;
    }
  >();
  for (const attempt of attempts) {
    if (!attempt.error || attempt.retry) continue;
    const key = `${attempt.error}|${attempt.provider}|${attempt.model}|${attempt.httpStatus}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences++;
      existing.sessions.add(attempt.sessionId);
      existing.last_seen = Math.max(existing.last_seen, attempt.startedAt);
      continue;
    }
    groups.set(key, {
      error_type: attempt.error === "cancelled" ? "Cancellation" : attempt.error === "rate_limit" ? "Rate limit" : "Upstream failure",
      error_code: attempt.error,
      provider: attempt.provider,
      model: attempt.model,
      http_status: attempt.httpStatus,
      source: "transport",
      occurrences: 1,
      sessions: new Set([attempt.sessionId]),
      retryable: attempt.error !== "cancelled" ? 1 : 0,
      last_seen: attempt.startedAt,
      explanation:
        attempt.error === "cancelled"
          ? "The sample client cancelled the request before completion."
          : attempt.error === "rate_limit"
            ? "The fictional provider asked the demo client to back off."
            : "A synthetic upstream failure used to demonstrate error grouping.",
    });
  }
  return [...groups.values()]
    .map((error, index) => ({
      ...error,
      id: `err_sample_${index + 1}`,
      sessions: error.sessions.size,
    }))
    .sort((a, b) => b.last_seen - a.last_seen);
}

const built = build();
export const sampleSessions = built.sessions;
export const sampleAttempts = built.attempts;
export const sampleTools = built.tools;
export const sampleAttachments = built.attachments;
export const sampleErrors = built.errors;

export const sampleSessionById = new Map(sampleSessions.map(session => [session.id, session]));
export const sampleMachineById = new Map(sampleMachines.map(machine => [machine.id, machine]));
export const sampleAccountById = new Map(sampleAccounts.map(account => [account.id, account]));

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index),
    upper = Math.ceil(index);
  return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
export const sampleMedian = median;
