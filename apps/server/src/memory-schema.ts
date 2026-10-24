import type { PoolClient } from "pg";

/**
 * Episodic and semantic memory tables. They are deliberately separate from
 * `entities`, which stays a metadata-only analytics projection: transcript text
 * must never widen the hot path used by `list_sessions`.
 *
 * Every table carries `user_id` and is covered by the tenant RLS policy applied
 * in db.ts. No table here is readable across tenants, including through joins.
 */
export async function migrateMemory(db: PoolClient) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS session_contents (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id uuid NOT NULL,
      session_id text NOT NULL,
      message_id text NOT NULL,
      part_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('prompt','response','reasoning','tool_input','tool_output','media')),
      role text,
      content_text text NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
      truncated boolean NOT NULL DEFAULT false,
      original_bytes bigint,
      observed_at bigint NOT NULL,
      revision bigint NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(content_text, 1000000))) STORED,
      PRIMARY KEY (user_id, installation_id, session_id, message_id, part_id, kind)
    );
    CREATE INDEX IF NOT EXISTS session_contents_session ON session_contents(user_id, installation_id, session_id, observed_at);
    CREATE INDEX IF NOT EXISTS session_contents_time ON session_contents(user_id, observed_at);
    CREATE INDEX IF NOT EXISTS session_contents_fts ON session_contents USING gin(tsv);

    CREATE TABLE IF NOT EXISTS media_assets (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
      mime text NOT NULL,
      bytes bigint,
      width integer,
      height integer,
      filename text,
      availability text NOT NULL CHECK (availability IN ('inline','local','remote','tool','local_missing')),
      visual_kind text CHECK (visual_kind IS NULL OR visual_kind IN ('ui_screenshot','terminal','chart','diagram','document','photo','other')),
      description text,
      extracted_text text,
      descriptor_source text NOT NULL DEFAULT 'none' CHECK (descriptor_source IN ('vision','context_inferred','none')),
      generator_model text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(extracted_text, '') || ' ' || coalesce(filename, ''))
      ) STORED,
      PRIMARY KEY (user_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS media_assets_fts ON media_assets USING gin(tsv);

    CREATE TABLE IF NOT EXISTS summaries (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id uuid NOT NULL,
      session_id text NOT NULL,
      target_kind text NOT NULL CHECK (target_kind IN ('part','message','turn','session')),
      target_id text NOT NULL,
      summary_short text NOT NULL,
      summary_detailed text NOT NULL DEFAULT '',
      key_decisions jsonb NOT NULL DEFAULT '[]',
      files_touched jsonb NOT NULL DEFAULT '[]',
      concepts jsonb NOT NULL DEFAULT '[]',
      generator_model text NOT NULL,
      prompt_version text NOT NULL,
      source_hash text NOT NULL CHECK (source_hash ~ '^sha256:[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', left(summary_short || ' ' || summary_detailed, 1000000))
      ) STORED,
      PRIMARY KEY (user_id, installation_id, session_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS summaries_session ON summaries(user_id, installation_id, session_id, target_kind);
    CREATE INDEX IF NOT EXISTS summaries_fts ON summaries USING gin(tsv);

    CREATE TABLE IF NOT EXISTS vault_concepts (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      concept text NOT NULL,
      title text NOT NULL,
      path text NOT NULL,
      summary text NOT NULL DEFAULT '',
      blob_sha text,
      git_commit text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))) STORED,
      PRIMARY KEY (user_id, concept)
    );
    CREATE INDEX IF NOT EXISTS vault_concepts_fts ON vault_concepts USING gin(tsv);

    CREATE TABLE IF NOT EXISTS vault_claims (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claim_id text NOT NULL,
      concept text NOT NULL,
      subject text NOT NULL,
      statement text NOT NULL,
      polarity text NOT NULL CHECK (polarity IN ('affirm','deny')),
      modality text NOT NULL CHECK (modality IN ('fact','decision','hypothesis')),
      scope text NOT NULL,
      evidence_tier text NOT NULL CHECK (evidence_tier IN ('tool_verified','user_stated','external_reference','assistant_assertion')),
      valid_from bigint NOT NULL,
      valid_to bigint,
      status text NOT NULL CHECK (status IN ('active','superseded','disputed','hypothesis')),
      superseded_by text,
      support_count integer NOT NULL DEFAULT 1,
      evidence_refs jsonb NOT NULL DEFAULT '[]',
      single_valued boolean NOT NULL DEFAULT true,
      contradicts jsonb NOT NULL DEFAULT '[]',
      git_path text,
      git_commit text,
      recorded_at bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(statement, 1000000))) STORED,
      PRIMARY KEY (user_id, claim_id)
    );
    CREATE INDEX IF NOT EXISTS vault_claims_lookup ON vault_claims(user_id, concept, scope, status);
    CREATE INDEX IF NOT EXISTS vault_claims_time ON vault_claims(user_id, concept, valid_from);
    CREATE INDEX IF NOT EXISTS vault_claims_fts ON vault_claims USING gin(tsv);

    CREATE TABLE IF NOT EXISTS vault_edges (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_id text NOT NULL,
      to_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('supersedes','contradicts','depends_on','refines','verified_by','mentions')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, from_id, to_id, kind)
    );
    CREATE INDEX IF NOT EXISTS vault_edges_from ON vault_edges(user_id, from_id);
    CREATE INDEX IF NOT EXISTS vault_edges_to ON vault_edges(user_id, to_id);

    CREATE TABLE IF NOT EXISTS vault_conflicts (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conflict_id text NOT NULL,
      class text NOT NULL CHECK (class IN ('logical','value','evidence_asymmetry','explicit')),
      concept text NOT NULL,
      scope text NOT NULL,
      subject text NOT NULL,
      claim_a text NOT NULL,
      claim_b text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
      detected_at bigint NOT NULL,
      resolved_at bigint,
      resolution text,
      PRIMARY KEY (user_id, conflict_id)
    );
    CREATE INDEX IF NOT EXISTS vault_conflicts_status ON vault_conflicts(user_id, status, detected_at);

    CREATE TABLE IF NOT EXISTS vault_jobs (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL,
      target text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
      attempts integer NOT NULL DEFAULT 0,
      lease_until bigint,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind, target)
    );
    CREATE INDEX IF NOT EXISTS vault_jobs_claim ON vault_jobs(user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS librarian_decisions (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      model text,
      prompt_version text,
      input jsonb NOT NULL DEFAULT '{}',
      decision jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS librarian_decisions_kind ON librarian_decisions(user_id, kind, created_at);
    -- Columns introduced after the first vault prototype.
    ALTER TABLE vault_concepts ADD COLUMN IF NOT EXISTS git_commit text;
    ALTER TABLE vault_claims ADD COLUMN IF NOT EXISTS single_valued boolean NOT NULL DEFAULT true;
    ALTER TABLE vault_claims ADD COLUMN IF NOT EXISTS contradicts jsonb NOT NULL DEFAULT '[]';
  `);
}
