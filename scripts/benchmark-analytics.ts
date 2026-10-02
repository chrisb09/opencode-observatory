import { pool } from "../apps/server/src/db.js";
import { analytics, listEntities } from "../apps/server/src/analytics.js";
// Read-only diagnostic: no credentials, emails, raw payloads or model lists are printed.
try {
  const { rows } = await pool.query("SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1");
  if (!rows[0]) throw new Error("No user available to benchmark");
  const userId = rows[0].id, to = Date.now();
  for (const days of [1, 7, 30, 0]) {
    const f = { ...(days ? { from: to - days * 86400000 } : {}), to };
    const start = performance.now(); const result = await analytics(userId, f);
    const uncachedMs = performance.now() - start, repeat = performance.now(); await analytics(userId, f);
    console.log(JSON.stringify({ span: days ? `${days} days` : "all history", coldMs: +uncachedMs.toFixed(1), repeatMs: +(performance.now() - repeat).toFixed(1), calls: result.summary.calls, intervals: result.series.length, bucket: result.timeframe.bucket }));
  }
  const start = performance.now(); const result = await listEntities(userId, "session", { sortBy: "marketCost", sortDir: "desc", limit: 50 });
  console.log(JSON.stringify({ operation: "sorted sessions", ms: +(performance.now() - start).toFixed(1), rows: result.items.length, total: result.total }));
} finally { await pool.end(); }
