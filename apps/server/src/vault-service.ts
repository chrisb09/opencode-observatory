import { VaultApplySchema } from "@observatory/contracts";
import { z } from "zod";
import pg from "pg";
import { tenant } from "./db.js";
import { claimFromCandidate, foldClaims, type ClaimInput } from "./vault-model.js";
import { conceptPath, VaultGit, type CommitTrailers } from "./vault-git.js";
import { conceptTitle, type ConceptDocument } from "./vault-render.js";
import { HttpError } from "./security.js";

/**
 * Apply extractor output to the vault:
 *   1. load every existing claim in the affected concepts,
 *   2. fold the complete set (source-time ordered, not ingest ordered),
 *   3. persist the projection and commit the rendered documents.
 *
 * Git is the canonical history. If the commit fails after the projection write,
 * the next fold recomputes the same documents and commits them; no claim is lost.
 */

export interface ApplyClaimsOptions {
  vault?: VaultGit;
  trailers?: CommitTrailers;
  message?: string;
}

export interface ApplyClaimsResult {
  commit: string | null;
  concepts: string[];
  claims: number;
  conflicts: number;
}

const locks = new Map<string, Promise<unknown>>();

function serialized<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const current = previous.then(run, run);
  locks.set(userId, current.then(() => undefined, () => undefined));
  return current;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToClaimInput(row: any): ClaimInput {
  const evidence = parseJson(row.evidence_refs);
  const contradicts = parseJson(row.contradicts);
  return {
    concept: row.concept,
    subject: row.subject,
    statement: row.statement,
    polarity: row.polarity,
    modality: row.modality,
    scope: row.scope,
    evidenceTier: row.evidence_tier,
    singleValued: row.single_valued !== false,
    evidence: Array.isArray(evidence) ? evidence : [],
    contradicts: Array.isArray(contradicts) ? contradicts : [],
    validFrom: Number(row.valid_from),
  };
}

export async function applyClaims(
  userId: string,
  payload: unknown,
  options: ApplyClaimsOptions = {},
): Promise<ApplyClaimsResult> {
  const input = VaultApplySchema.parse(payload);
  const incoming = input.claims.map(claimFromCandidate);
  const requestedConcepts = [...new Set(incoming.map(claim => claim.concept))].sort();
  // Explicit contradictions may point at a concept that is not part of this
  // extraction pass. Load those targets too, otherwise a late cross-concept
  // contradiction silently disappears.
  const targetIds = [...new Set(incoming.flatMap(claim => claim.contradicts))].sort();
  const vault = options.vault ?? new VaultGit();
  const recordedAt = Date.now();
  let affectedConcepts = requestedConcepts;

  return serialized(userId, async () => {
    // Serialize folds across server replicas, not just within this process. Use a
    // dedicated connection so holding the session lock across the Git commit
    // cannot starve the request pool.
    const lock = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let locked = false;
    try {
      await lock.connect();
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`vault:${userId}`]);
      locked = true;
    const documents: ConceptDocument[] = [];
    let conflictCount = 0;

    await tenant(userId, async db => {
      const targetRows = targetIds.length
        ? await db.query(
            `SELECT DISTINCT concept FROM vault_claims WHERE user_id=$1 AND claim_id=ANY($2::text[])`,
            [userId, targetIds],
          )
        : { rows: [] as { concept: string }[] };
      affectedConcepts = [...new Set([...requestedConcepts, ...targetRows.rows.map(row => row.concept)])].sort();
      const existing = await db.query(
        `SELECT claim_id,concept,subject,statement,polarity,modality,scope,evidence_tier,
                valid_from,evidence_refs,single_valued,contradicts
         FROM vault_claims WHERE user_id=$1 AND concept=ANY($2::text[])`,
        [userId, affectedConcepts],
      );
      const folded = foldClaims([...existing.rows.map(rowToClaimInput), ...incoming]);
      const relevant = folded.claims.filter(claim => affectedConcepts.includes(claim.concept));
      const claimIds = relevant.map(claim => claim.key);
      const claimIdSet = new Set(claimIds);

      for (const claim of relevant) {
        await db.query(
          `INSERT INTO vault_claims(
             user_id,claim_id,concept,subject,statement,polarity,modality,scope,evidence_tier,
             valid_from,valid_to,status,superseded_by,support_count,evidence_refs,single_valued,
             contradicts,recorded_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
           ON CONFLICT(user_id,claim_id) DO UPDATE SET
             statement=EXCLUDED.statement, polarity=EXCLUDED.polarity, modality=EXCLUDED.modality,
             scope=EXCLUDED.scope, evidence_tier=EXCLUDED.evidence_tier,
             valid_from=EXCLUDED.valid_from, valid_to=EXCLUDED.valid_to, status=EXCLUDED.status,
             superseded_by=EXCLUDED.superseded_by, support_count=EXCLUDED.support_count,
             evidence_refs=EXCLUDED.evidence_refs, single_valued=EXCLUDED.single_valued,
             contradicts=EXCLUDED.contradicts, updated_at=now()`,
          [
            userId,
            claim.key,
            claim.concept,
            claim.subject,
            claim.statement,
            claim.polarity,
            claim.modality,
            claim.scope,
            claim.evidenceTier,
            claim.validFrom,
            claim.validTo,
            claim.status,
            claim.supersededBy,
            claim.supportCount,
            JSON.stringify(claim.evidence),
            claim.singleValued,
            JSON.stringify(claim.contradicts),
            recordedAt,
          ],
        );
      }

      if (claimIds.length) {
        await db.query(
          `DELETE FROM vault_edges WHERE user_id=$1 AND (from_id=ANY($2::text[]) OR to_id=ANY($2::text[]))`,
          [userId, claimIds],
        );
        for (const edge of folded.edges) {
          if (!claimIdSet.has(edge.from) || !claimIdSet.has(edge.to)) continue;
          await db.query(
            `INSERT INTO vault_edges(user_id,from_id,to_id,kind) VALUES($1,$2,$3,$4)
             ON CONFLICT(user_id,from_id,to_id,kind) DO NOTHING`,
            [userId, edge.from, edge.to, edge.kind],
          );
        }
      }

      for (const conflict of folded.conflicts) {
        if (!affectedConcepts.includes(conflict.concept)) continue;
        conflictCount += 1;
        // Never reopen a human-resolved conflict merely because the fold still sees it.
        await db.query(
          `INSERT INTO vault_conflicts(
             user_id,conflict_id,class,concept,scope,subject,claim_a,claim_b,status,detected_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)
           ON CONFLICT(user_id,conflict_id) DO NOTHING`,
          [
            userId,
            conflict.id,
            conflict.class,
            conflict.concept,
            conflict.scope,
            conflict.subject,
            conflict.claimA,
            conflict.claimB,
            conflict.at,
          ],
        );
      }

      for (const concept of affectedConcepts) {
        const title = conceptTitle(concept);
        await db.query(
          `INSERT INTO vault_concepts(user_id,concept,title,path,updated_at)
           VALUES($1,$2,$3,$4,now())
           ON CONFLICT(user_id,concept) DO UPDATE SET
             title=EXCLUDED.title, path=EXCLUDED.path, updated_at=now()`,
          [userId, concept, title, conceptPath(concept)],
        );
        documents.push({ concept, title, claims: relevant.filter(claim => claim.concept === concept) });
      }
    });

    const commit = await vault.commitConcepts(
      userId,
      documents,
      options.message ?? input.message ?? `vault: update ${affectedConcepts.length} concept${affectedConcepts.length === 1 ? "" : "s"}`,
      {
        installationId: input.source?.installationId,
        machine: input.source?.machine,
        rootSessionId: input.source?.rootSessionId,
        evidenceSessionId: input.source?.evidenceSessionId,
        messageIds: input.source?.messageIds,
        agent: input.source?.agent,
        model: input.source?.model,
        promptVersion: input.source?.promptVersion,
        evidenceTier: input.source?.evidenceTier,
        ...options.trailers,
      },
    );

    if (commit.commit) {
      await tenant(userId, async db => {
        await db.query(
          `UPDATE vault_claims
           SET git_commit=$2, git_path='concepts/' || concept || '.md', updated_at=now()
           WHERE user_id=$1 AND concept=ANY($3::text[])`,
          [userId, commit.commit, affectedConcepts],
        );
        await db.query(
          `UPDATE vault_concepts SET git_commit=$2, updated_at=now()
           WHERE user_id=$1 AND concept=ANY($3::text[])`,
          [userId, commit.commit, affectedConcepts],
        );
      });
    }

    return { commit: commit.commit, concepts: affectedConcepts, claims: incoming.length, conflicts: conflictCount };
    } finally {
      if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`vault:${userId}`]).catch(() => undefined);
      await lock.end().catch(() => undefined);
    }
  });
}

const VaultListSchema = z
  .object({
    concept: z.string().max(200).optional(),
    status: z.enum(["active", "superseded", "disputed", "hypothesis"]).optional(),
    scope: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export async function listVaultConcepts(userId: string) {
  return tenant(userId, async db => {
    const rows = await db.query(
      `SELECT concept,title,path,summary,git_commit,updated_at
       FROM vault_concepts WHERE user_id=$1 ORDER BY concept`,
      [userId],
    );
    return rows.rows;
  });
}

export async function listVaultClaims(userId: string, query: unknown) {
  const filters = VaultListSchema.parse(query);
  return tenant(userId, async db => {
    const conditions = ["user_id=$1"];
    const values: unknown[] = [userId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      conditions.push(`${column}=$${values.length}`);
    };
    if (filters.concept) add("concept", filters.concept);
    if (filters.status) add("status", filters.status);
    if (filters.scope) add("scope", filters.scope);
    const where = conditions.join(" AND ");
    const limit = `$${values.length + 1}`;
    const offset = `$${values.length + 2}`;
    const items = await db.query(
      `SELECT claim_id,concept,subject,statement,polarity,modality,scope,evidence_tier,
              valid_from,valid_to,status,superseded_by,support_count,evidence_refs,
              single_valued,contradicts,git_path,git_commit,updated_at
       FROM vault_claims WHERE ${where}
       ORDER BY valid_from DESC,claim_id LIMIT ${limit} OFFSET ${offset}`,
      [...values, filters.limit, filters.offset],
    );
    const total = await db.query(`SELECT count(*)::int AS count FROM vault_claims WHERE ${where}`, values);
    return { items: items.rows, total: total.rows[0].count, limit: filters.limit, offset: filters.offset };
  });
}

export async function listVaultConflicts(userId: string, query: unknown) {
  const filters = z
    .object({
      concept: z.string().max(200).optional(),
      status: z.enum(["open", "resolved", "dismissed"]).default("open"),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    })
    .strict()
    .parse(query);
  return tenant(userId, async db => {
    const conditions = ["user_id=$1", "status=$2"];
    const values: unknown[] = [userId, filters.status];
    if (filters.concept) {
      values.push(filters.concept);
      conditions.push(`concept=$${values.length}`);
    }
    const where = conditions.join(" AND ");
    const items = await db.query(
      `SELECT conflict_id,class,concept,scope,subject,claim_a,claim_b,status,detected_at,resolved_at,resolution
       FROM vault_conflicts WHERE ${where}
       ORDER BY detected_at DESC,conflict_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, filters.offset],
    );
    const total = await db.query(`SELECT count(*)::int AS count FROM vault_conflicts WHERE ${where}`, values);
    return { items: items.rows, total: total.rows[0].count, limit: filters.limit, offset: filters.offset };
  });
}

export async function readVaultNote(userId: string, query: unknown, vault = new VaultGit()) {
  const { concept } = z.object({ concept: z.string().min(1).max(200) }).strict().parse(query);
  let path: string;
  try {
    path = conceptPath(concept);
    const markdown = await vault.read(userId, path);
    return { concept, path, markdown };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid concept")) throw new HttpError(400, error.message);
    throw new HttpError(404, "Vault note not found");
  }
}

export async function readVaultLog(userId: string, query: unknown, vault = new VaultGit()) {
  const { concept, limit } = z
    .object({ concept: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(20) })
    .strict()
    .parse(query);
  return vault.log(userId, { path: concept ? conceptPath(concept) : undefined, limit });
}

export async function searchVault(userId: string, query: unknown) {
  const filters = z
    .object({
      query: z.string().min(1).max(200),
      concept: z.string().min(1).max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    })
    .strict()
    .parse(query);
  return tenant(userId, async db => {
    const concepts = await db.query(
      `SELECT concept,title,path,ts_rank(tsv,plainto_tsquery('simple',$2)) AS rank
       FROM vault_concepts WHERE user_id=$1 AND tsv @@ plainto_tsquery('simple',$2)
       ORDER BY rank DESC,concept LIMIT $3`,
      [userId, filters.query, filters.limit],
    );
    const values: unknown[] = [userId, filters.query];
    const conceptFilter = filters.concept
      ? (values.push(filters.concept), `AND concept=$${values.length}`)
      : "";
    const claims = await db.query(
      `SELECT claim_id,concept,subject,statement,status,scope,evidence_tier,valid_from,valid_to,
              git_path,ts_rank(tsv,plainto_tsquery('simple',$2)) AS rank
       FROM vault_claims WHERE user_id=$1 AND tsv @@ plainto_tsquery('simple',$2) ${conceptFilter}
       ORDER BY rank DESC,valid_from DESC LIMIT $${values.length + 1}`,
      [...values, filters.limit],
    );
    return { concepts: concepts.rows, claims: claims.rows };
  });
}
