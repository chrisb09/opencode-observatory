import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export async function tenant<T>(userId: string, run: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('observatory.user_id', $1, true)", [userId]);
    const value = await run(db);
    await db.query("COMMIT");
    return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function migrate() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(7692)");
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
        admin boolean NOT NULL DEFAULT false, fingerprint_secret text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS login_sessions (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        token_hash text PRIMARY KEY, email text NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
        expires_at timestamptz NOT NULL, used_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL, token_hash text UNIQUE NOT NULL, encrypted_token text NOT NULL,
        scopes text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS events (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, event_id uuid NOT NULL,
        installation_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), event jsonb NOT NULL,
        PRIMARY KEY(user_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS entities (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, installation_id uuid NOT NULL,
        kind text NOT NULL, entity_id text NOT NULL, instance_id uuid NOT NULL, machine text NOT NULL,
        project_id text, session_id text, message_id text, observed_at bigint NOT NULL, revision bigint NOT NULL,
        historical boolean NOT NULL, runtime jsonb NOT NULL, data jsonb NOT NULL,
        PRIMARY KEY(user_id, installation_id, kind, entity_id)
      );
      CREATE INDEX IF NOT EXISTS entities_time ON entities(user_id, kind, observed_at);
      CREATE INDEX IF NOT EXISTS entities_session ON entities(user_id, installation_id, session_id, kind);
      CREATE INDEX IF NOT EXISTS entities_model ON entities(user_id, (data->>'provider'), (data->>'model'));
      CREATE INDEX IF NOT EXISTS entities_step_message ON entities(user_id,installation_id,message_id) WHERE kind='step';
      CREATE INDEX IF NOT EXISTS entities_parent_message ON entities(user_id,installation_id,(data->>'parentMessageId')) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS entities_account_time ON entities(user_id,(data->>'account'),observed_at) WHERE kind IN ('step','message','attempt');
      CREATE INDEX IF NOT EXISTS entities_key_time ON entities(user_id,(data->>'credential'),observed_at) WHERE kind IN ('step','message','attempt');
      CREATE INDEX IF NOT EXISTS events_received ON events(user_id, received_at);
      CREATE TABLE IF NOT EXISTS account_aliases (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, fingerprint text NOT NULL, alias text NOT NULL,
        PRIMARY KEY(user_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS prices (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider text NOT NULL, model text NOT NULL, account text, effective_at bigint NOT NULL,
        input numeric NOT NULL CHECK(input >= 0), output numeric NOT NULL CHECK(output >= 0),
        cache_read numeric NOT NULL CHECK(cache_read >= 0), cache_write numeric NOT NULL CHECK(cache_write >= 0),
        currency text NOT NULL DEFAULT 'USD'
      );
      CREATE TABLE IF NOT EXISTS market_rates (
        model_pattern text PRIMARY KEY,
        input numeric NOT NULL CHECK(input >= 0),
        output numeric NOT NULL CHECK(output >= 0),
        cache_read numeric NOT NULL CHECK(cache_read >= 0),
        cache_write numeric NOT NULL CHECK(cache_write >= 0)
      );
      CREATE INDEX IF NOT EXISTS prices_lookup ON prices(user_id,provider,model,effective_at DESC);
      CREATE TABLE IF NOT EXISTS account_assignments (
        id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider text NOT NULL,installation_id uuid,from_time bigint NOT NULL,to_time bigint,
        account text NOT NULL,label text NOT NULL,CHECK(to_time IS NULL OR to_time>from_time)
      );
      INSERT INTO market_rates(model_pattern, input, output, cache_read, cache_write) VALUES
        ('gemini-3.8-flash', 0.75, 3.75, 0.075, 0.75),
        ('gemini-3.7-flash', 0.75, 3.75, 0.075, 0.75),
        ('gemini-3.6-flash', 0.75, 3.75, 0.075, 0.75),
        ('gemini-3.5-flash-lite', 0.30, 2.50, 0.03, 0.30),
        ('gemini-3.5-flash', 1.50, 7.50, 0.15, 1.50),
        ('gemini-3.1-pro', 2.00, 12.00, 0.20, 2.00),
        ('gemini-3.1-flash-lite', 0.30, 2.50, 0.03, 0.30),
        ('gemini-3-flash', 0.50, 3.00, 0.05, 0.50),
        ('claude-sonnet-4-6', 3.00, 15.00, 0.30, 3.75),
        ('claude-opus-4-6', 5.00, 25.00, 0.50, 6.25),
        ('claude-haiku-4-5', 1.00, 5.00, 0.10, 1.25),
        ('claude-sonnet-5', 2.00, 10.00, 0.20, 2.50),
        ('claude-opus-5-5', 4.00, 20.00, 0.20, 5.00),
        ('claude-fable-5-1', 10.00, 50.00, 0.25, 12.50),
        ('claude-fable-5', 10.00, 50.00, 1.00, 12.50),
        ('gpt-5.6-terra', 2.00, 12.00, 0.20, 2.50),
        ('gpt-5.6-sol', 4.00, 20.00, 0.40, 5.00),
        ('gpt-5.6-luna', 0.20, 1.20, 0.02, 0.25),
        ('gpt-6.1-sol', 2.00, 10.00, 0.10, 2.00),
        ('gpt-6-luna', 0.10, 0.50, 0.01, 0.125),
        ('gpt-5.5', 5.00, 30.00, 0.50, 5.00),
        ('gpt-5.4', 2.50, 15.00, 0.25, 2.50),
        ('gpt-5.3-chat-latest', 1.75, 14.00, 0.175, 1.75),
        ('glm-5.3-flash', 0.15, 0.50, 0.03, 0.15),
        ('glm-5.3', 1.40, 4.40, 0.26, 1.40),
        ('glm-5.2', 1.40, 4.40, 0.26, 1.40),
        ('deepseek-v4-pro', 0.66, 1.98, 0.022, 0.66),
        ('deepseek-v4-flash', 0.22, 0.66, 0.007, 0.22),
        ('deepseek-v4.1-flash', 0.15, 0.60, 0.003, 0.15),
        ('minimax-m3', 0.30, 1.20, 0.06, 0.30),
        ('minimax-m2.7', 0.30, 1.20, 0.06, 0.375),
        ('kimi-k3', 3.00, 15.00, 0.30, 3.00),
        ('kimi-k2.7-code', 0.95, 4.00, 0.19, 0.95),
        ('kimi-k2.6', 0.95, 4.00, 0.16, 0.95),
        ('qwen3.8-max', 2.00, 6.00, 0.25, 2.50),
        ('qwen3.8-flash', 0.15, 0.47, 0.016, 0.20),
        ('qwen3.7-plus', 0.40, 1.60, 0.04, 0.50),
        ('hy3', 0.14, 0.58, 0.035, 0.14),
        ('hy4', 0.834, 2.501, 0.042, 0.834),
        ('muse-spark-1.3', 1.25, 4.25, 0.15, 1.25)
      ON CONFLICT(model_pattern) DO UPDATE SET
        input=EXCLUDED.input, output=EXCLUDED.output, cache_read=EXCLUDED.cache_read, cache_write=EXCLUDED.cache_write;
      GRANT SELECT ON market_rates TO PUBLIC;
    `);
    for (const table of ["entities", "events", "account_aliases", "prices", "account_assignments"]) {
      await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await db.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON ${table} USING (user_id::text = current_setting('observatory.user_id', true))
        WITH CHECK (user_id::text = current_setting('observatory.user_id', true)); END IF; END $$`);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
