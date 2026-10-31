import { pool, tenant } from "../apps/server/src/db.js";
import { resolveMarket } from "../apps/server/src/metrics.js";

// Read-only diagnostic. Model identifiers and aggregate counts are printed;
// credentials, tenant identities, session ids, and telemetry payloads are not.
const unpricedOnly = process.argv.includes("--unpriced");
type ModelUsage = { model: string; facts: number; calls: number; unknownMarketCalls: number; cacheWriteTokens: number };
try {
  const catalog = (await pool.query("SELECT * FROM market_rates ORDER BY model_pattern")).rows.map(row => ({
    ...row,
    input: Number(row.input),
    output: Number(row.output),
    cache_read: Number(row.cache_read),
    cache_write: Number(row.cache_write),
  }));
  const users = (await pool.query("SELECT id FROM users ORDER BY created_at,id")).rows;
  const models = new Map<string, ModelUsage>();
  for (const user of users) {
    const rows = await tenant(user.id, db => db.query(`SELECT
      dimensions->>'model' AS model,
      count(*)::int AS facts,
      sum(metrics[1])::bigint AS calls,
      sum(CASE WHEN metrics[5] > 0 THEN metrics[5] ELSE 0 END)::bigint AS unknown_market_calls,
      sum(CASE WHEN metrics[19] > 0 THEN metrics[19] ELSE 0 END)::numeric AS cache_write_tokens
      FROM usage_facts GROUP BY 1`));
    for (const row of rows.rows) {
      const current = models.get(row.model) ?? { model: row.model, facts: 0, calls: 0, unknownMarketCalls: 0, cacheWriteTokens: 0 };
      current.facts += Number(row.facts);
      current.calls += Number(row.calls);
      current.unknownMarketCalls += Number(row.unknown_market_calls);
      current.cacheWriteTokens += Number(row.cache_write_tokens);
      models.set(row.model, current);
    }
  }
  const result = [...models.values()]
    .map(row => ({ ...row, catalogMatch: resolveMarket(row.model, catalog)?.model_pattern ?? null }))
    .filter(row => !unpricedOnly || row.catalogMatch === null)
    .sort((a, b) => b.unknownMarketCalls - a.unknownMarketCalls || b.calls - a.calls || a.model.localeCompare(b.model));
  console.log(JSON.stringify({ catalogEntries: catalog.length, models: result }, null, 2));
} finally {
  await pool.end();
}
