import { createHash } from "node:crypto";
import type { ClaimCandidate, ClaimModality, ClaimPolarity, EvidenceTier } from "@observatory/contracts";

/**
 * Vault claims are folded, never mutated in place. The fold is a pure function of
 * the complete claim set, so importing a March session after an October session
 * produces the same result as importing them chronologically. Callers persist the
 * result and may replay the fold at any time.
 */

export interface EvidenceRef {
  installationId: string;
  sessionId: string;
  messageId: string | null;
  partId: string | null;
  tool: string | null;
  url: string | null;
  observedAt: number;
}

export type EvidenceInput = Omit<EvidenceRef, "messageId" | "partId" | "tool" | "url"> & {
  messageId?: string | null;
  partId?: string | null;
  tool?: string | null;
  url?: string | null;
};

export interface ClaimInput {
  concept: string;
  subject: string;
  statement: string;
  polarity: ClaimPolarity;
  modality: ClaimModality;
  /** Normalized scope: `global`, `project:<id>`, or `machine:<host>`. */
  scope: string;
  evidenceTier: EvidenceTier;
  singleValued: boolean;
  evidence: EvidenceRef[];
  contradicts: string[];
  /** Source-session time. Never the ingestion time. */
  validFrom: number;
}

export type ClaimStatus = "active" | "superseded" | "disputed" | "hypothesis";

export interface FoldedClaim extends ClaimInput {
  key: string;
  validTo: number | null;
  status: ClaimStatus;
  supersededBy: string | null;
  supportCount: number;
}

export type ConflictClass = "logical" | "value" | "evidence_asymmetry" | "explicit";

export interface VaultConflict {
  id: string;
  class: ConflictClass;
  concept: string;
  scope: string;
  subject: string;
  claimA: string;
  claimB: string;
  at: number;
}

export interface ClaimEdge {
  from: string;
  to: string;
  kind: "supersedes" | "contradicts";
}

export interface FoldResult {
  claims: FoldedClaim[];
  conflicts: VaultConflict[];
  edges: ClaimEdge[];
}

const TIER_RANK: Record<EvidenceTier, number> = {
  tool_verified: 3,
  user_stated: 2,
  external_reference: 1,
  assistant_assertion: 0,
};

const MODALITY_RANK: Record<ClaimModality, number> = { fact: 3, decision: 2, hypothesis: 1 };

export function normalizeScope(kind: "global" | "project" | "machine", value: string | null): string {
  if (kind === "global") return "global";
  if (!value) throw new Error(`scopeValue is required for ${kind} scope`);
  return `${kind}:${value}`;
}

export function normalizeStatement(statement: string): string {
  return statement.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable identity for an assertion. Modality is excluded so a hypothesis can be upgraded in place. */
export function claimKey(claim: Pick<ClaimInput, "concept" | "scope" | "subject" | "polarity" | "statement">): string {
  const digest = createHash("sha256")
    .update([claim.concept, claim.scope, claim.subject, claim.polarity, normalizeStatement(claim.statement)].join("\u0000"))
    .digest("hex");
  return `clm_${digest.slice(0, 32)}`;
}

function conflictId(kind: ConflictClass, claimA: string, claimB: string): string {
  const [first, second] = [claimA, claimB].sort();
  return `cfl_${createHash("sha256").update([kind, first, second].join("\u0000")).digest("hex").slice(0, 32)}`;
}

function evidenceKey(value: EvidenceRef): string {
  return JSON.stringify([
    value.installationId,
    value.sessionId,
    value.messageId,
    value.partId,
    value.tool,
    value.url,
    value.observedAt,
  ]);
}

export function normalizeEvidence(value: EvidenceInput): EvidenceRef {
  return {
    installationId: value.installationId,
    sessionId: value.sessionId,
    messageId: value.messageId ?? null,
    partId: value.partId ?? null,
    tool: value.tool ?? null,
    url: value.url ?? null,
    observedAt: value.observedAt,
  };
}

function compareEvidence(a: EvidenceRef, b: EvidenceRef): number {
  return evidenceKey(a).localeCompare(evidenceKey(b));
}

export function mergeEvidence(left: EvidenceInput[], right: EvidenceInput[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const value of [...left, ...right]) {
    const normalized = normalizeEvidence(value);
    unique.set(evidenceKey(normalized), normalized);
  }
  return [...unique.values()].sort(compareEvidence);
}

/** Convert extractor output to the exact shape the fold consumes. */
export function claimFromCandidate(candidate: ClaimCandidate): ClaimInput {
  const scope = normalizeScope(candidate.scope, candidate.scopeValue);
  const base = {
    concept: candidate.concept,
    subject: candidate.subject,
    statement: candidate.statement,
    polarity: candidate.polarity,
    modality: candidate.modality,
    scope,
    evidenceTier: candidate.evidenceTier,
    singleValued: candidate.singleValued,
    evidence: candidate.evidence.map(normalizeEvidence),
    contradicts: [...new Set(candidate.contradicts)].sort(),
    validFrom: Math.min(...candidate.evidence.map(value => value.observedAt)),
  };
  return base;
}

function normalizeClaim(input: ClaimInput): ClaimInput & { key: string } {
  const evidence = mergeEvidence(input.evidence, []);
  if (!evidence.length) throw new Error("a vault claim requires at least one evidence reference");
  const base: ClaimInput = {
    concept: input.concept,
    subject: input.subject,
    statement: input.statement,
    polarity: input.polarity,
    modality: input.modality,
    scope: input.scope,
    evidenceTier: input.evidenceTier,
    singleValued: input.singleValued,
    evidence,
    contradicts: [...new Set(input.contradicts)].sort(),
    validFrom: input.validFrom,
  };
  return { ...base, key: claimKey(base) };
}

function mergeClaims(left: ClaimInput & { key: string }, right: ClaimInput & { key: string }): ClaimInput & { key: string } {
  return {
    ...left,
    // Same normalized statement, but pick lexicographically so replay order cannot matter.
    statement: [left.statement, right.statement].sort()[0]!,
    modality: MODALITY_RANK[right.modality] > MODALITY_RANK[left.modality] ? right.modality : left.modality,
    evidenceTier: TIER_RANK[right.evidenceTier] > TIER_RANK[left.evidenceTier] ? right.evidenceTier : left.evidenceTier,
    singleValued: left.singleValued && right.singleValued,
    validFrom: Math.min(left.validFrom, right.validFrom),
    evidence: mergeEvidence(left.evidence, right.evidence),
    contradicts: [...new Set([...left.contradicts, ...right.contradicts])].sort(),
  };
}

function compareClaims(a: ClaimInput & { key: string }, b: ClaimInput & { key: string }): number {
  return a.validFrom - b.validFrom || TIER_RANK[b.evidenceTier] - TIER_RANK[a.evidenceTier] || a.key.localeCompare(b.key);
}

function claimsConflict(a: ClaimInput, b: ClaimInput): ConflictClass | null {
  if (a.modality === "hypothesis" || b.modality === "hypothesis") return null;
  if (a.polarity !== b.polarity) return "logical";
  if (a.singleValued && b.singleValued && normalizeStatement(a.statement) !== normalizeStatement(b.statement)) return "value";
  return null;
}

interface FoldState {
  folded: Map<string, FoldedClaim>;
  conflicts: Map<string, VaultConflict>;
  edges: Map<string, ClaimEdge>;
}

function addConflict(state: FoldState, kind: ConflictClass, older: FoldedClaim, newer: FoldedClaim): VaultConflict {
  const id = conflictId(kind, older.key, newer.key);
  const existing = state.conflicts.get(id);
  if (existing) return existing;
  const conflict: VaultConflict = {
    id,
    class: kind,
    concept: older.concept,
    scope: older.scope,
    subject: older.subject,
    claimA: older.key,
    claimB: newer.key,
    at: Math.max(older.validFrom, newer.validFrom),
  };
  state.conflicts.set(id, conflict);
  return conflict;
}

function addEdge(state: FoldState, from: string, to: string, kind: ClaimEdge["kind"]): void {
  const key = `${from}\u0000${to}\u0000${kind}`;
  if (!state.edges.has(key)) state.edges.set(key, { from, to, kind });
}

/**
 * Compare one ordered pair. The older claim is closed only when the newer claim
 * has at least as much evidence. An assistant assertion never silently erases a
 * tool-verified observation; it becomes a visible dispute instead.
 */
function applyPair(state: FoldState, older: FoldedClaim, newer: FoldedClaim, explicit: boolean): void {
  if (older.key === newer.key) return;
  if (older.status === "superseded" || newer.status === "superseded") return;
  if (older.status === "disputed" && newer.status === "disputed") return;
  if (older.modality === "hypothesis" || newer.modality === "hypothesis") {
    if (explicit) addEdge(state, newer.key, older.key, "contradicts");
    return;
  }
  // Scope is an isolation boundary: claims in different scopes may both be true
  // (e.g. a global default and a machine-specific override). An explicit
  // contradiction across scopes is recorded as tension, never as a status change.
  if (explicit && older.scope !== newer.scope) {
    addEdge(state, newer.key, older.key, "contradicts");
    return;
  }
  const kind = explicit ? "explicit" : claimsConflict(older, newer);
  if (!kind) return;

  if (newer.validFrom > older.validFrom && TIER_RANK[newer.evidenceTier] >= TIER_RANK[older.evidenceTier]) {
    older.status = "superseded";
    older.validTo = newer.validFrom;
    older.supersededBy = newer.key;
    addEdge(state, newer.key, older.key, "supersedes");
    return;
  }

  if (newer.validFrom > older.validFrom) {
    newer.status = "disputed";
    addEdge(state, newer.key, older.key, "contradicts");
    addConflict(state, "evidence_asymmetry", older, newer);
    return;
  }

  older.status = "disputed";
  newer.status = "disputed";
  addEdge(state, newer.key, older.key, "contradicts");
  addConflict(state, kind === "explicit" ? "explicit" : kind, older, newer);
}

/**
 * Fold every claim in a tenant. Input order is irrelevant: claims are grouped by
 * concept/scope/subject and sorted by source time before any comparison.
 */
export function foldClaims(input: ClaimInput[]): FoldResult {
  const merged = new Map<string, ClaimInput & { key: string }>();
  for (const raw of input) {
    const claim = normalizeClaim(raw);
    const existing = merged.get(claim.key);
    merged.set(claim.key, existing ? mergeClaims(existing, claim) : claim);
  }

  const groups = new Map<string, (ClaimInput & { key: string })[]>();
  for (const claim of merged.values()) {
    const group = [claim.concept, claim.scope, claim.subject].join("\u0000");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(claim);
  }

  const state: FoldState = { folded: new Map(), conflicts: new Map(), edges: new Map() };

  for (const claims of groups.values()) {
    claims.sort(compareClaims);
    for (const claim of claims) {
      state.folded.set(claim.key, {
        ...claim,
        validTo: null,
        status: claim.modality === "hypothesis" ? "hypothesis" : "active",
        supersededBy: null,
        supportCount: claim.evidence.length,
      });
    }
    for (let index = 0; index < claims.length; index++) {
      const newer = state.folded.get(claims[index]!.key)!;
      for (let previous = 0; previous < index; previous++) {
        const older = state.folded.get(claims[previous]!.key)!;
        if (older.status !== "active") continue;
        applyPair(state, older, newer, false);
      }
    }
  }

  // Explicit contradictions may cross subject groups; they are applied in a
  // deterministic order and obey the same evidence rules as inferred pairs.
  const explicitPairs = new Set<string>();
  for (const claim of merged.values()) {
    for (const target of claim.contradicts) {
      if (!merged.has(target)) continue;
      const [first, second] = [claim.key, target].sort();
      if (first === second) continue;
      explicitPairs.add(`${first}\u0000${second}`);
    }
  }
  const orderedPairs = [...explicitPairs]
    .map(key => key.split("\u0000") as [string, string])
    .map(([first, second]) => {
      const a = state.folded.get(first)!;
      const b = state.folded.get(second)!;
      return a.validFrom <= b.validFrom ? [a, b] as const : [b, a] as const;
    })
    .sort((a, b) => a[0].validFrom - b[0].validFrom || a[0].key.localeCompare(b[0].key) || a[1].key.localeCompare(b[1].key));
  for (const [older, newer] of orderedPairs) applyPair(state, older, newer, true);

  const claims = [...state.folded.values()].sort(
    (a, b) =>
      a.concept.localeCompare(b.concept) ||
      a.scope.localeCompare(b.scope) ||
      a.subject.localeCompare(b.subject) ||
      a.validFrom - b.validFrom ||
      a.key.localeCompare(b.key),
  );
  const conflicts = [...state.conflicts.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...state.edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
  return { claims, conflicts, edges };
}
