import { type Filters } from "@observatory/contracts";
import { normalizeUsage, number, tokenCost, resolveMarket, type UsageRecord, type Rates } from "./metrics.js";

export function where(f: Filters, base = "e", start = 2, identity = true) {
  const values: unknown[] = [], conditions: string[] = [];
  const add = (column: string, value: unknown, op = "=") => { values.push(value); conditions.push(`${column} ${op} $${start + values.length - 1}`); };
  if (f.from !== undefined) add(`${base}.observed_at`, f.from, ">=");
  if (f.to !== undefined) add(`${base}.observed_at`, f.to, "<");
  if (f.provider === "antigravity") conditions.push(`(${base}.data->>'provider'='antigravity' OR (${base}.data->>'provider'='google' AND ${base}.data->>'model' LIKE 'antigravity-%'))`);
  else if (f.provider) {
    add(`${base}.data->>'provider'`, f.provider);
    if (f.provider === "google") conditions.push(`COALESCE(${base}.data->>'model','') NOT LIKE 'antigravity-%'`);
  }
  for (const key of ["model", "status"] as const) if (f[key]) add(`${base}.data->>'${key}'`, f[key]);
  if (identity) for (const key of ["account", "credential"] as const) if (f[key]) add(`${base}.data->>'${key}'`, f[key]);
  if (f.machine) add(`${base}.machine`, f.machine);
  if (f.sessionId) add(`${base}.session_id`, f.sessionId);
  if (f.projectId) add(`${base}.project_id`, f.projectId);
  if (f.installationId) add(`${base}.installation_id`, f.installationId);
  return { sql: conditions.length ? " AND " + conditions.join(" AND ") : "", values };
}
export const columns = "e.kind,e.entity_id,e.installation_id,e.project_id,e.session_id,e.message_id,e.machine,e.observed_at,e.revision,e.historical,e.data";
export function usageSQL(w: {sql:string}) {
  return `SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='step' AND COALESCE(e.data->>'status','unknown')<>'running' ${w.sql}
    UNION ALL SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='message' AND e.data ? 'inputTokens' AND COALESCE(e.data->>'status','unknown')<>'running' ${w.sql}
      AND NOT EXISTS (SELECT 1 FROM entities s WHERE s.user_id=$1 AND s.installation_id=e.installation_id AND s.kind='step' AND s.message_id=e.entity_id AND COALESCE(s.data->>'status','unknown')<>'running')
    UNION ALL SELECT ${columns} FROM entities e WHERE e.user_id=$1 AND e.kind='attempt' AND e.data->>'purpose'='auxiliary' ${w.sql}
      AND NOT EXISTS (SELECT 1 FROM entities s WHERE s.user_id=$1 AND s.installation_id=e.installation_id AND s.kind='message'
        AND s.parent_message_id=e.message_id AND s.data->>'provider'=e.data->>'provider' AND s.data->>'model'=e.data->>'model')`;
}
type Assignment = { id: string; provider: string; installation_id: string | null; from_time: string; to_time: string | null; account: string; label: string };
type Price = Rates & { id: string; provider: string; model: string; account: string | null; effective_at: string };
export type Lookup = { aliases: Map<string, string>; assignments: Assignment[]; prices: Price[]; catalog: Array<Rates & { model_pattern: string }> };
export async function lookups(db: any, userId: string): Promise<Lookup> {
  const aliases = (await db.query("SELECT fingerprint,alias FROM account_aliases WHERE user_id=$1", [userId])).rows;
  const assignments = (await db.query("SELECT * FROM account_assignments WHERE user_id=$1 ORDER BY (installation_id IS NOT NULL) DESC,from_time DESC,id", [userId])).rows;
  const prices = (await db.query("SELECT * FROM prices WHERE user_id=$1 ORDER BY (account IS NOT NULL) DESC,effective_at DESC,id", [userId])).rows;
  const catalog = (await db.query("SELECT * FROM market_rates ORDER BY model_pattern")).rows;
  const rates = (r: any) => ({ ...r, input: Number(r.input), output: Number(r.output), cache_read: Number(r.cache_read), cache_write: Number(r.cache_write) });
  return { aliases: new Map(aliases.map((a: any) => [a.fingerprint, a.alias])), assignments, prices: prices.map(rates), catalog: catalog.map(rates) };
}
export function records(rows: any[], lookup: Lookup): UsageRecord[] {
  const markets = new Map<string, Rates | null>();
  return rows.map(row => {
    const data = row.data, provider = data.provider ?? "Unknown", model = data.model ?? "Unknown", time = Number(row.observed_at);
    const u = normalizeUsage(data);
    const assignment = !data.account ? lookup.assignments.find(a => a.provider === provider && (!a.installation_id || a.installation_id === row.installation_id) && time >= Number(a.from_time) && (a.to_time === null || time < Number(a.to_time))) : undefined;
    const account = data.account ?? assignment?.account ?? null, credential = data.credential ?? null;
    const attribution = assignment ? "assigned" : account ? data.accountSource ?? (String(account).startsWith("hmac:") ? "observed" : "configured") : "unassigned";
    const price = lookup.prices.find(p => p.provider === provider && p.model === model && (!p.account || p.account === account || p.account === credential) && Number(p.effective_at) <= time);
    if (!markets.has(model)) markets.set(model, resolveMarket(model, lookup.catalog));
    const rates = price ?? markets.get(model) ?? null;
    const marketCost = rates ? tokenCost(u, rates) : null;
    const cacheSavings = rates && u.cache_known && u.cache_read_tokens !== null ? u.cache_read_tokens * (rates.input - rates.cache_read) / 1000000 : null;
    return { ...u, id: row.entity_id, installation: row.installation_id, session: row.session_id, provider, model, model_id: `${provider}/${model}`,
      machine: row.machine, agent: data.agent ?? "Unknown", time, status: data.status ?? "unknown", duration: number(data.durationMs),
      cost: number(data.cost), market_cost: marketCost, cache_savings: cacheSavings, historical: row.historical === true,
      account_id: `${provider}/${account ?? "unassigned"}`, account_label: account ? lookup.aliases.get(account) ?? assignment?.label ?? (String(account).startsWith("hmac:") ? `Account ${String(account).slice(5, 13)}` : account) : "Account unassigned",
      credential_id: `${provider}/${credential ?? (data.authType === "oauth" ? "oauth" : "unassigned")}`, credential_label: credential ? lookup.aliases.get(credential) ?? `Key ${String(credential).replace("hmac:", "").slice(0, 8)}` : data.authType === "oauth" ? "OAuth (no API key)" : "Key unavailable", credential_kind: credential ? "api-key" : data.authType === "oauth" ? "oauth" : "unavailable", attribution };
  });
}
export function identityMatches(r: UsageRecord, f: Filters) {
  return (!f.account || r.account_id === f.account || r.account_id === `${r.provider}/${f.account}`) && (!f.credential || r.credential_id === f.credential || r.credential_id === `${r.provider}/${f.credential}`);
}
