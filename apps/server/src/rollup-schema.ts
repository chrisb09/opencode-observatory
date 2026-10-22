import type { PoolClient } from "pg";

export async function migrateRollups(db: PoolClient) {
  await db.query(`
    -- The encoding is fixed; unlike a text-to-bytea cast this also hashes JSON
    -- containing escaped quotes, control characters, and backslashes safely.
    CREATE OR REPLACE FUNCTION usage_dimension_key(d jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT
      AS $$ SELECT sha256(convert_to(d::text,'UTF8')) $$;
    CREATE TABLE IF NOT EXISTS usage_catalog_version (id boolean PRIMARY KEY DEFAULT true CHECK(id), revision bigint NOT NULL);
    INSERT INTO usage_catalog_version VALUES(true,1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS usage_rollup_state (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ready boolean NOT NULL DEFAULT false, catalog_revision bigint NOT NULL DEFAULT 0, format_version integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE usage_rollup_state ADD COLUMN IF NOT EXISTS format_version integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS usage_dirty (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, installation_id uuid NOT NULL,
      kind text NOT NULL, entity_id text NOT NULL, PRIMARY KEY(user_id,installation_id,kind,entity_id)
    );
    CREATE TABLE IF NOT EXISTS usage_facts (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, installation_id uuid NOT NULL,
      kind text NOT NULL, entity_id text NOT NULL, session_id text, observed_at bigint NOT NULL,
      dimensions jsonb NOT NULL, dimension_key bytea GENERATED ALWAYS AS (usage_dimension_key(dimensions)) STORED,
      metrics numeric[] NOT NULL CHECK(cardinality(metrics)=34), duration double precision, output double precision,
      PRIMARY KEY(user_id,installation_id,kind,entity_id)
    );
    CREATE INDEX IF NOT EXISTS usage_facts_time ON usage_facts(user_id,observed_at);
    CREATE INDEX IF NOT EXISTS usage_facts_session ON usage_facts(user_id,installation_id,session_id,observed_at);
    DO $$ BEGIN
      IF (SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d JOIN pg_attribute a
        ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='usage_facts'::regclass AND a.attname='dimension_key') <> 'usage_dimension_key(dimensions)' THEN
        ALTER TABLE usage_facts ALTER COLUMN dimension_key SET EXPRESSION AS (usage_dimension_key(dimensions));
        UPDATE usage_catalog_version SET revision=revision+1;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS usage_hourly (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, hour bigint NOT NULL,
      dimension_key bytea NOT NULL, dimensions jsonb NOT NULL, metrics numeric[] NOT NULL,
      histogram jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,hour,dimension_key)
    );
    CREATE INDEX IF NOT EXISTS entities_attempt_message ON entities(user_id,installation_id,message_id) WHERE kind='attempt';

    CREATE OR REPLACE FUNCTION usage_metrics_add(a numeric[],b numeric[]) RETURNS numeric[]
    LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT ARRAY(SELECT a[i]+b[i] FROM generate_series(1,34) AS i)
    $$;
    CREATE OR REPLACE FUNCTION usage_histogram_add(a jsonb,b jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT COALESCE(jsonb_object_agg(key,n),'{}') FROM (
        SELECT key,sum(value::numeric) AS n FROM (
          SELECT * FROM jsonb_each_text(a) UNION ALL SELECT * FROM jsonb_each_text(b)
        ) v GROUP BY key HAVING sum(value::numeric)<>0
      ) s
    $$;
    CREATE OR REPLACE FUNCTION usage_apply_hourly() RETURNS trigger LANGUAGE plpgsql SET jit=off AS $$
    DECLARE source text;
    BEGIN
      source := CASE TG_OP
        WHEN 'INSERT' THEN 'SELECT *,1::numeric AS sign FROM added'
        WHEN 'DELETE' THEN 'SELECT *,-1::numeric AS sign FROM removed'
        ELSE 'SELECT *,1::numeric AS sign FROM added UNION ALL SELECT *,-1::numeric AS sign FROM removed' END;
      EXECUTE 'WITH changes AS MATERIALIZED (
        SELECT c.*,floor(c.observed_at::numeric/3600000)::bigint*3600000 AS hour
        FROM ('||source||') c WHERE EXISTS(SELECT 1 FROM users u WHERE u.id=c.user_id)
      ), dimensions AS (
        SELECT DISTINCT ON(user_id,hour,dimension_key) user_id,hour,dimension_key,dimensions FROM changes
      ), numbers AS (
        SELECT user_id,hour,dimension_key,array_agg(n ORDER BY ordinal) AS metrics FROM (
          SELECT user_id,hour,dimension_key,v.ordinal,sum(v.value*c.sign) AS n
          FROM changes c CROSS JOIN LATERAL unnest(c.metrics) WITH ORDINALITY v(value,ordinal)
          GROUP BY user_id,hour,dimension_key,v.ordinal
        ) s GROUP BY user_id,hour,dimension_key
      ), histograms AS (
        SELECT user_id,hour,dimension_key,jsonb_object_agg(label,n) AS histogram FROM (
          SELECT user_id,hour,dimension_key,v.label,sum(c.sign) AS n FROM changes c
          CROSS JOIN LATERAL (VALUES
            (CASE WHEN c.duration IS NOT NULL THEN ''d:''||c.duration::text END),
            (CASE WHEN c.output IS NOT NULL THEN ''o:''||c.output::text END)
          ) v(label) WHERE v.label IS NOT NULL
          GROUP BY user_id,hour,dimension_key,v.label HAVING sum(c.sign)<>0
        ) s GROUP BY user_id,hour,dimension_key
      ) INSERT INTO usage_hourly AS h(user_id,hour,dimension_key,dimensions,metrics,histogram)
      SELECT d.user_id,d.hour,d.dimension_key,d.dimensions,n.metrics,COALESCE(g.histogram,''{}'')
      FROM dimensions d JOIN numbers n USING(user_id,hour,dimension_key)
      LEFT JOIN histograms g USING(user_id,hour,dimension_key)
      ORDER BY d.user_id,d.hour,d.dimension_key
      ON CONFLICT(user_id,hour,dimension_key) DO UPDATE SET
        metrics=usage_metrics_add(h.metrics,EXCLUDED.metrics),
        histogram=usage_histogram_add(h.histogram,EXCLUDED.histogram)';
      EXECUTE 'DELETE FROM usage_hourly h USING (
        SELECT DISTINCT user_id,floor(observed_at::numeric/3600000)::bigint*3600000 AS hour,dimension_key FROM ('||source||') c
      ) changed WHERE h.user_id=changed.user_id AND h.hour=changed.hour AND h.dimension_key=changed.dimension_key AND h.metrics[1]=0';
      RETURN NULL;
    END $$;
    CREATE OR REPLACE FUNCTION usage_mark_identity(uid uuid,iid uuid,k text,eid text,mid text,parent text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF k NOT IN ('step','message','attempt') OR NOT EXISTS(SELECT 1 FROM users WHERE id=uid) THEN RETURN; END IF;
      INSERT INTO usage_dirty VALUES(uid,iid,k,eid) ON CONFLICT DO NOTHING;
      IF k='step' AND mid IS NOT NULL THEN
        INSERT INTO usage_dirty VALUES(uid,iid,'message',mid) ON CONFLICT DO NOTHING;
      END IF;
      IF k='message' AND parent IS NOT NULL THEN
        INSERT INTO usage_dirty SELECT user_id,installation_id,kind,entity_id FROM entities
        WHERE user_id=uid AND installation_id=iid AND kind='attempt' AND message_id=parent
        ON CONFLICT DO NOTHING;
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION usage_mark_entity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP<>'INSERT' THEN PERFORM usage_mark_identity(OLD.user_id,OLD.installation_id,OLD.kind,OLD.entity_id,OLD.message_id,OLD.parent_message_id); END IF;
      IF TG_OP<>'DELETE' THEN PERFORM usage_mark_identity(NEW.user_id,NEW.installation_id,NEW.kind,NEW.entity_id,NEW.message_id,NEW.parent_message_id); END IF;
      RETURN NULL;
    END $$;
    CREATE OR REPLACE FUNCTION usage_invalidate_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE uid uuid;
    BEGIN
      uid := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
      IF EXISTS(SELECT 1 FROM users WHERE id=uid) THEN
        INSERT INTO usage_rollup_state(user_id,ready) VALUES(uid,false)
        ON CONFLICT(user_id) DO UPDATE SET ready=false;
      END IF;
      RETURN NULL;
    END $$;
    CREATE OR REPLACE FUNCTION usage_invalidate_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE usage_catalog_version SET revision=revision+1; RETURN NULL; END $$;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='usage_facts'::regclass AND tgname='usage_insert_hourly') THEN
        CREATE TRIGGER usage_insert_hourly AFTER INSERT ON usage_facts REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION usage_apply_hourly();
        CREATE TRIGGER usage_update_hourly AFTER UPDATE ON usage_facts REFERENCING OLD TABLE AS removed NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION usage_apply_hourly();
        CREATE TRIGGER usage_delete_hourly AFTER DELETE ON usage_facts REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION usage_apply_hourly();
        CREATE TRIGGER usage_entity_dirty AFTER INSERT OR UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION usage_mark_entity();
        CREATE TRIGGER usage_alias_rules AFTER INSERT OR UPDATE OR DELETE ON account_aliases FOR EACH ROW EXECUTE FUNCTION usage_invalidate_rules();
        CREATE TRIGGER usage_price_rules AFTER INSERT OR UPDATE OR DELETE ON prices FOR EACH ROW EXECUTE FUNCTION usage_invalidate_rules();
        CREATE TRIGGER usage_account_rules AFTER INSERT OR UPDATE OR DELETE ON account_assignments FOR EACH ROW EXECUTE FUNCTION usage_invalidate_rules();
        CREATE TRIGGER usage_catalog_rules AFTER INSERT OR UPDATE OR DELETE ON market_rates FOR EACH ROW EXECUTE FUNCTION usage_invalidate_catalog();
      END IF;
    END $$;
  `);
}
