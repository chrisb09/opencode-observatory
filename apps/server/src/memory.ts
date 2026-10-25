import { ContentBatchSchema, SummarySchema } from "@observatory/contracts";
import { z } from "zod";
import { tenant } from "./db.js";

/**
 * Episodic ingest. Text arrives already scrubbed by the client; the server only
 * validates shape and stores latest-known revisions. Media bytes never arrive,
 * only a content hash and an optional descriptor.
 */
export async function storeContent(userId: string, payload: unknown) {
  const batch = ContentBatchSchema.parse(payload);
  return tenant(userId, async db => {
    const mediaHashes = new Set<string>();
    for (const part of batch.parts) {
      await db.query(
        `INSERT INTO session_contents(
           user_id,installation_id,session_id,message_id,part_id,kind,role,content_text,content_hash,
           truncated,original_bytes,observed_at,revision
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(user_id,installation_id,session_id,message_id,part_id,kind) DO UPDATE SET
           role=EXCLUDED.role, content_text=EXCLUDED.content_text, content_hash=EXCLUDED.content_hash,
           truncated=EXCLUDED.truncated, original_bytes=EXCLUDED.original_bytes,
           observed_at=LEAST(session_contents.observed_at,EXCLUDED.observed_at),
           revision=EXCLUDED.revision, received_at=now()
         WHERE EXCLUDED.revision >= session_contents.revision`,
        [
          userId,
          part.installationId,
          part.sessionId,
          part.messageId,
          part.partId,
          part.kind,
          part.role ?? null,
          part.text,
          part.contentHash,
          part.truncated,
          part.originalBytes ?? null,
          part.observedAt,
          part.observedAt,
        ],
      );
      if (!part.media) continue;
      mediaHashes.add(part.media.contentHash);
      await db.query(
        `INSERT INTO media_assets(
           user_id,content_hash,mime,bytes,width,height,filename,availability,
           visual_kind,description,extracted_text,descriptor_source,generator_model
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(user_id,content_hash) DO UPDATE SET
           mime=EXCLUDED.mime,
           bytes=COALESCE(EXCLUDED.bytes,media_assets.bytes),
           width=COALESCE(EXCLUDED.width,media_assets.width),
           height=COALESCE(EXCLUDED.height,media_assets.height),
           filename=COALESCE(EXCLUDED.filename,media_assets.filename),
           availability=CASE WHEN media_assets.availability='local_missing' THEN EXCLUDED.availability ELSE media_assets.availability END,
           visual_kind=COALESCE(media_assets.visual_kind,EXCLUDED.visual_kind),
           description=COALESCE(media_assets.description,EXCLUDED.description),
           extracted_text=COALESCE(media_assets.extracted_text,EXCLUDED.extracted_text),
           descriptor_source=CASE WHEN media_assets.descriptor_source='none' THEN EXCLUDED.descriptor_source ELSE media_assets.descriptor_source END,
           generator_model=COALESCE(media_assets.generator_model,EXCLUDED.generator_model),
           updated_at=now()`,
        [
          userId,
          part.media.contentHash,
          part.media.mime,
          part.media.bytes,
          part.media.width ?? null,
          part.media.height ?? null,
          part.media.filename ?? null,
          part.media.availability,
          part.media.visualKind ?? null,
          part.media.description ?? null,
          part.media.extractedText ?? null,
          part.media.descriptorSource ?? "none",
          part.media.generatorModel ?? null,
        ],
      );
    }

    const pending = mediaHashes.size
      ? await db.query(
          `SELECT content_hash FROM media_assets
           WHERE user_id=$1 AND content_hash=ANY($2::text[])
             AND descriptor_source='none' AND availability<>'local_missing'
           ORDER BY content_hash`,
          [userId, [...mediaHashes]],
        )
      : { rows: [] as { content_hash: string }[] };

    return {
      accepted: batch.parts.length,
      mediaPending: pending.rows.map(row => row.content_hash),
    };
  });
}

export async function storeSummary(userId: string, payload: unknown) {
  const summary = SummarySchema.parse(payload);
  return tenant(userId, async db => {
    await db.query(
      `INSERT INTO summaries(
         user_id,installation_id,session_id,target_kind,target_id,summary_short,summary_detailed,
         key_decisions,files_touched,concepts,generator_model,prompt_version,source_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(user_id,installation_id,session_id,target_kind,target_id) DO UPDATE SET
         summary_short=EXCLUDED.summary_short, summary_detailed=EXCLUDED.summary_detailed,
         key_decisions=EXCLUDED.key_decisions, files_touched=EXCLUDED.files_touched,
         concepts=EXCLUDED.concepts, generator_model=EXCLUDED.generator_model,
         prompt_version=EXCLUDED.prompt_version, source_hash=EXCLUDED.source_hash, updated_at=now()
       WHERE summaries.source_hash<>EXCLUDED.source_hash
          OR summaries.prompt_version<>EXCLUDED.prompt_version
          OR summaries.generator_model<>EXCLUDED.generator_model`,
      [
        userId,
        summary.installationId,
        summary.sessionId,
        summary.targetKind,
        summary.targetId,
        summary.summaryShort,
        summary.summaryDetailed,
        JSON.stringify(summary.keyDecisions),
        JSON.stringify(summary.filesTouched),
        JSON.stringify(summary.concepts),
        summary.generatorModel,
        summary.promptVersion,
        summary.sourceHash,
      ],
    );
    return { ok: true };
  });
}

const ContentSearchSchema = z
  .object({
    query: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(256).optional(),
    installationId: z.string().uuid().optional(),
    kind: z.enum(["prompt", "response", "reasoning", "tool_input", "tool_output", "media"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export async function searchContent(userId: string, query: unknown) {
  const filters = ContentSearchSchema.parse(query);
  return tenant(userId, async db => {
    const conditions = ["user_id=$1", "tsv @@ plainto_tsquery('simple',$2)"];
    const values: unknown[] = [userId, filters.query];
    if (filters.sessionId) {
      values.push(filters.sessionId);
      conditions.push(`session_id=$${values.length}`);
    }
    if (filters.installationId) {
      values.push(filters.installationId);
      conditions.push(`installation_id=$${values.length}`);
    }
    if (filters.kind) {
      values.push(filters.kind);
      conditions.push(`kind=$${values.length}`);
    }
    const where = conditions.join(" AND ");
    const items = await db.query(
      `SELECT installation_id,session_id,message_id,part_id,kind,role,
              left(content_text,2000) AS preview,truncated,
              ts_rank(tsv,plainto_tsquery('simple',$2)) AS rank
       FROM session_contents WHERE ${where}
       ORDER BY rank DESC,observed_at DESC,message_id,part_id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, filters.offset],
    );
    const total = await db.query(`SELECT count(*)::int AS count FROM session_contents WHERE ${where}`, values);
    return { items: items.rows, total: total.rows[0].count, limit: filters.limit, offset: filters.offset };
  });
}

const TranscriptSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    installationId: z.string().uuid().optional(),
    kinds: z
      .array(z.enum(["prompt", "response", "reasoning", "tool_input", "tool_output", "media"]))
      .max(6)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export async function getSessionTranscript(userId: string, query: unknown) {
  const filters = TranscriptSchema.parse(query);
  return tenant(userId, async db => {
    const conditions = ["user_id=$1", "session_id=$2"];
    const values: unknown[] = [userId, filters.sessionId];
    if (filters.installationId) {
      values.push(filters.installationId);
      conditions.push(`installation_id=$${values.length}`);
    }
    if (filters.kinds?.length) {
      values.push(filters.kinds);
      conditions.push(`kind=ANY($${values.length}::text[])`);
    }
    const where = conditions.join(" AND ");
    const items = await db.query(
      `SELECT installation_id,session_id,message_id,part_id,kind,role,content_text,truncated,
              original_bytes,observed_at
       FROM session_contents WHERE ${where}
       ORDER BY observed_at,message_id,part_id,kind
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, filters.offset],
    );
    const total = await db.query(`SELECT count(*)::int AS count FROM session_contents WHERE ${where}`, values);
    return { items: items.rows, total: total.rows[0].count, limit: filters.limit, offset: filters.offset };
  });
}

export async function getSessionSummaries(userId: string, query: unknown) {
  const { sessionId } = z.object({ sessionId: z.string().min(1).max(256) }).strict().parse(query);
  return tenant(userId, async db => {
    const rows = await db.query(
      `SELECT installation_id,session_id,target_kind,target_id,summary_short,summary_detailed,
              key_decisions,files_touched,concepts,generator_model,prompt_version,updated_at
       FROM summaries WHERE user_id=$1 AND session_id=$2
       ORDER BY target_kind,target_id`,
      [userId, sessionId],
    );
    return rows.rows;
  });
}

/**
 * Dashboard coverage: how much of the session corpus has raw text, summaries,
 * and vault material, plus the stored size. Counts are tenant-scoped by RLS.
 */
export async function memoryCoverage(userId: string) {
  return tenant(userId, async db => {
    const totalSessions = Number(
      (await db.query(`SELECT count(*)::int AS n FROM entities WHERE user_id=$1 AND kind='session'`, [userId])).rows[0]?.n ?? 0,
    );
    const contentSessions = Number(
      (await db.query(`SELECT count(DISTINCT (installation_id,session_id))::int AS n FROM session_contents WHERE user_id=$1`, [userId])).rows[0]?.n ?? 0,
    );
    const summarySessions = Number(
      (await db.query(`SELECT count(DISTINCT (installation_id,session_id))::int AS n FROM summaries WHERE user_id=$1 AND target_kind='session'`, [userId])).rows[0]?.n ?? 0,
    );
    const content = (await db.query(
      `SELECT count(*)::int AS parts,
              coalesce(sum(octet_length(content_text)),0)::bigint AS stored_bytes,
              coalesce(sum(coalesce(original_bytes,octet_length(content_text))),0)::bigint AS original_bytes,
              count(*) FILTER (WHERE truncated)::int AS truncated_parts
       FROM session_contents WHERE user_id=$1`,
      [userId],
    )).rows[0];
    const media = (await db.query(
      `SELECT count(*)::int AS assets,
              coalesce(sum(bytes),0)::bigint AS referenced_bytes,
              count(*) FILTER (WHERE descriptor_source='none')::int AS pending_descriptions
       FROM media_assets WHERE user_id=$1`,
      [userId],
    )).rows[0];
    const summaries = (await db.query(
      `SELECT count(*)::int AS total,
              count(DISTINCT (installation_id,session_id))::int AS sessions,
              count(*) FILTER (WHERE target_kind='session')::int AS session_summaries,
              count(*) FILTER (WHERE target_kind='message')::int AS message_summaries,
              coalesce(sum(octet_length(summary_short)+octet_length(summary_detailed)
                +octet_length(key_decisions::text)+octet_length(files_touched::text)+octet_length(concepts::text)),0)::bigint AS stored_bytes
       FROM summaries WHERE user_id=$1`,
      [userId],
    )).rows[0];
    const vaultConcepts = Number(
      (await db.query(`SELECT count(*)::int AS n FROM vault_concepts WHERE user_id=$1`, [userId])).rows[0]?.n ?? 0,
    );
    const vaultClaims = (await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status='active')::int AS active,
              count(*) FILTER (WHERE status='disputed')::int AS disputed
       FROM vault_claims WHERE user_id=$1`,
      [userId],
    )).rows[0];
    const openConflicts = Number(
      (await db.query(`SELECT count(*)::int AS n FROM vault_conflicts WHERE user_id=$1 AND status='open'`, [userId])).rows[0]?.n ?? 0,
    );
    return {
      sessions: { total: totalSessions, withContent: contentSessions, withSummary: summarySessions },
      content: {
        parts: Number(content?.parts ?? 0),
        sessions: contentSessions,
        storedBytes: Number(content?.stored_bytes ?? 0),
        originalBytes: Number(content?.original_bytes ?? 0),
        truncatedParts: Number(content?.truncated_parts ?? 0),
      },
      media: {
        assets: Number(media?.assets ?? 0),
        referencedBytes: Number(media?.referenced_bytes ?? 0),
        pendingDescriptions: Number(media?.pending_descriptions ?? 0),
      },
      summaries: {
        total: Number(summaries?.total ?? 0),
        sessions: Number(summaries?.sessions ?? 0),
        sessionSummaries: Number(summaries?.session_summaries ?? 0),
        messageSummaries: Number(summaries?.message_summaries ?? 0),
        storedBytes: Number(summaries?.stored_bytes ?? 0),
      },
      vault: {
        concepts: vaultConcepts,
        claims: Number(vaultClaims?.total ?? 0),
        activeClaims: Number(vaultClaims?.active ?? 0),
        disputedClaims: Number(vaultClaims?.disputed ?? 0),
        openConflicts,
      },
      generatedAt: Date.now(),
    };
  });
}

/** Full memory detail for one session, used by the session inspector. */
export async function sessionMemory(userId: string, query: unknown) {
  const { sessionId, installationId } = z
    .object({ sessionId: z.string().min(1).max(256), installationId: z.string().uuid() })
    .strict()
    .parse(query);
  return tenant(userId, async db => {
    const summaries = await db.query(
      `SELECT target_kind,target_id,summary_short,summary_detailed,key_decisions,files_touched,concepts,
              generator_model,prompt_version,updated_at
       FROM summaries WHERE user_id=$1 AND installation_id=$2 AND session_id=$3
       ORDER BY target_kind,target_id`,
      [userId, installationId, sessionId],
    );
    const content = await db.query(
      `SELECT kind,count(*)::int AS parts,
              coalesce(sum(octet_length(content_text)),0)::bigint AS stored_bytes,
              coalesce(sum(coalesce(original_bytes,octet_length(content_text))),0)::bigint AS original_bytes,
              count(*) FILTER (WHERE truncated)::int AS truncated_parts,
              min(observed_at) AS first_observed,max(observed_at) AS last_observed
       FROM session_contents WHERE user_id=$1 AND installation_id=$2 AND session_id=$3
       GROUP BY kind ORDER BY kind`,
      [userId, installationId, sessionId],
    );
    const totals = content.rows.reduce(
      (value, row) => ({
        parts: value.parts + Number(row.parts),
        storedBytes: value.storedBytes + Number(row.stored_bytes),
        originalBytes: value.originalBytes + Number(row.original_bytes),
        truncatedParts: value.truncatedParts + Number(row.truncated_parts),
      }),
      { parts: 0, storedBytes: 0, originalBytes: 0, truncatedParts: 0 },
    );
    return {
      sessionId,
      installationId,
      summaries: summaries.rows,
      content: content.rows,
      totals,
      media: { parts: Number(content.rows.find(row => row.kind === "media")?.parts ?? 0) },
      generatedAt: Date.now(),
    };
  });
}
