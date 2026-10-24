import { describe, expect, test } from "bun:test";
import { claimKey, foldClaims, type ClaimInput, type EvidenceRef } from "../apps/server/src/vault-model.js";

const installationId = "00000000-0000-4000-8000-000000000001";

function evidence(sessionId: string, observedAt: number): EvidenceRef {
  return {
    installationId,
    sessionId,
    messageId: `${sessionId}:msg`,
    partId: null,
    tool: null,
    url: null,
    observedAt,
  };
}

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  const validFrom = overrides.validFrom ?? 1_000;
  return {
    concept: "hpc/slurm",
    subject: "slurm.gpu.binding",
    statement: "SLURM requires --gpus-per-task=1 on this cluster.",
    polarity: "affirm",
    modality: "fact",
    scope: "global",
    evidenceTier: "tool_verified",
    singleValued: true,
    evidence: [evidence(`ses_${validFrom}`, validFrom)],
    contradicts: [],
    validFrom,
    ...overrides,
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(rest => [value, ...rest]),
  );
}

describe("bitemporal claim fold", () => {
  test("is invariant under every input permutation", () => {
    const claims = [
      claim({ validFrom: 1_000, statement: "SLURM requires --gpus-per-task=1.", polarity: "affirm" }),
      claim({ validFrom: 2_000, statement: "SLURM no longer requires --gpus-per-task=1.", polarity: "deny" }),
      claim({
        validFrom: 3_000,
        subject: "slurm.partition",
        statement: "The gpu partition has 8 nodes.",
        polarity: "affirm",
      }),
      claim({
        validFrom: 4_000,
        scope: "machine:rwth",
        subject: "slurm.gpu.binding",
        statement: "SLURM requires --gpus-per-task=1.",
        polarity: "affirm",
        evidenceTier: "user_stated",
      }),
    ];
    const expected = JSON.stringify(foldClaims(claims));
    for (const variant of permutations(claims)) expect(JSON.stringify(foldClaims(variant))).toBe(expected);
  });

  test("late import of an older session does not overwrite newer truth", () => {
    const october = claim({
      validFrom: 2_000,
      polarity: "deny",
      statement: "SLURM no longer requires --gpus-per-task=1.",
    });
    const march = claim({ validFrom: 1_000, polarity: "affirm" });

    // October first, then a March session arrives from another machine.
    const folded = foldClaims([october, march]);
    const older = folded.claims.find(value => value.key === claimKey(march))!;
    const newer = folded.claims.find(value => value.key === claimKey(october))!;

    expect(older.status).toBe("superseded");
    expect(older.validTo).toBe(2_000);
    expect(older.supersededBy).toBe(newer.key);
    expect(newer.status).toBe("active");
    expect(folded.edges).toContainEqual({ from: newer.key, to: older.key, kind: "supersedes" });
  });

  test("machine and project scopes do not conflict with each other", () => {
    const linux = claim({ scope: "machine:rwth", statement: "CUDA lives in /usr/local/cuda." });
    const windows = claim({
      scope: "machine:desktop",
      polarity: "deny",
      statement: "CUDA lives in /usr/local/cuda.",
    });
    const folded = foldClaims([linux, windows]);
    expect(folded.conflicts).toHaveLength(0);
    expect(folded.claims.map(value => value.status)).toEqual(["active", "active"]);
  });

  test("an assistant assertion never erases a tool-verified observation", () => {
    const verified = claim({ validFrom: 1_000, evidenceTier: "tool_verified" });
    const assertion = claim({
      validFrom: 2_000,
      polarity: "deny",
      evidenceTier: "assistant_assertion",
    });
    const folded = foldClaims([verified, assertion]);
    expect(folded.claims.find(value => value.key === claimKey(verified))!.status).toBe("active");
    expect(folded.claims.find(value => value.key === claimKey(assertion))!.status).toBe("disputed");
    expect(folded.conflicts).toHaveLength(1);
    expect(folded.conflicts[0]!.class).toBe("evidence_asymmetry");
  });

  test("simultaneous opposing claims become an explicit dispute", () => {
    const denied = claim({ validFrom: 1_000, polarity: "deny" });
    const folded = foldClaims([claim({ validFrom: 1_000 }), denied]);
    expect(folded.claims.every(value => value.status === "disputed")).toBe(true);
    expect(folded.conflicts).toHaveLength(1);
    expect(folded.conflicts[0]!.class).toBe("logical");
  });

  test("hypotheses are first class but never supersede facts", () => {
    const hypothesis = claim({
      validFrom: 2_000,
      polarity: "deny",
      modality: "hypothesis",
      statement: "Maybe the GPU flag is unnecessary.",
    });
    const folded = foldClaims([claim({ validFrom: 1_000 }), hypothesis]);
    expect(folded.claims.find(value => value.key === claimKey(claim({ validFrom: 1_000 })))!.status).toBe("active");
    expect(folded.claims.find(value => value.key === claimKey(hypothesis))!.status).toBe("hypothesis");
    expect(folded.conflicts).toHaveLength(0);
  });

  test("conflicting single-valued values are flagged", () => {
    const first = claim({ validFrom: 1_000, statement: "The flag is --gpus=1." });
    const second = claim({ validFrom: 1_000, statement: "The flag is --gpus-per-task=1." });
    const folded = foldClaims([first, second]);
    expect(folded.claims.every(value => value.status === "disputed")).toBe(true);
    expect(folded.conflicts[0]!.class).toBe("value");
  });

  test("duplicate assertions merge evidence instead of duplicating rows", () => {
    const first = claim({ validFrom: 1_000, evidence: [evidence("ses_a", 1_000)] });
    const second = claim({ validFrom: 1_500, evidence: [evidence("ses_b", 1_500)] });
    const folded = foldClaims([first, second]);
    expect(folded.claims).toHaveLength(1);
    expect(folded.claims[0]!.supportCount).toBe(2);
    expect(folded.claims[0]!.validFrom).toBe(1_000);
    expect(folded.claims[0]!.evidence.map(value => value.sessionId)).toEqual(["ses_a", "ses_b"]);
  });

  test("explicit cross-subject contradictions are honored", () => {
    const secondSubject = claim({
      validFrom: 1_000,
      subject: "slurm.gpu.count",
      statement: "The cluster has 16 GPUs.",
    });
    const target = claimKey(secondSubject);
    const first = claim({ validFrom: 1_000, contradicts: [target] });
    const folded = foldClaims([first, secondSubject]);
    expect(folded.claims.every(value => value.status === "disputed")).toBe(true);
    expect(folded.conflicts).toHaveLength(1);
    expect(folded.conflicts[0]!.class).toBe("explicit");
    expect(folded.edges.some(edge => edge.kind === "contradicts")).toBe(true);
  });

  test("explicit contradictions do not cross machine scope boundaries", () => {
    const linux = claim({ scope: "machine:rwth", subject: "slurm.scope.one", validFrom: 1_000 });
    const windows = claim({ scope: "machine:desktop", subject: "slurm.scope.two", validFrom: 1_000 });
    const folded = foldClaims([{ ...linux, contradicts: [claimKey(windows)] }, windows]);
    expect(folded.claims.every(value => value.status === "active")).toBe(true);
    expect(folded.conflicts).toHaveLength(0);
    expect(folded.edges.some(edge => edge.kind === "contradicts")).toBe(true);
  });

  test("global claims are not superseded by machine-scoped overrides", () => {
    const global = claim({ scope: "global", subject: "slurm.cuda.path", statement: "CUDA lives in /usr/local/cuda.", validFrom: 1_000 });
    const machine = claim({ scope: "machine:rwth", subject: "slurm.cuda.path", statement: "CUDA lives in /opt/cuda.", validFrom: 2_000 });
    const folded = foldClaims([{ ...machine, contradicts: [claimKey(global)] }, global]);
    expect(folded.claims.every(value => value.status === "active")).toBe(true);
    expect(folded.conflicts).toHaveLength(0);
    expect(folded.edges.some(edge => edge.kind === "contradicts")).toBe(true);
  });
});
