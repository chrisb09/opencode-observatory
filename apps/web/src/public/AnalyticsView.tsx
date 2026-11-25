import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, ArrowUpRight, Coins, DollarSign, Layers, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { UsageChart } from "../UsageChart";
import { ActivityChart } from "../ActivityChart";
import { DistributionChart } from "../DistributionChart";
import { groupColors } from "../colors";
import { metricLabel } from "../chartMetrics";
import { money, chartTooltipStyle } from "../format";
import type { AnalyticsNumbers, Grouping, PublicAnalytics, PublicGroup, PublicMetric } from "./types";

export const publicMetrics: [PublicMetric, string][] = [
  ["total_tokens", "Tokens"],
  ["calls", "Calls"],
  ["cost", "Recorded cost"],
  ["market_cost", "Market value"],
  ["cache_read_tokens", "Cache reads"],
];

export const metricName = (metric: PublicMetric) => metricLabel(metric);
export const count = (value: unknown) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? "—"
    : Intl.NumberFormat("en", {
        notation: Number(value) > 10000 ? "compact" : "standard",
        maximumFractionDigits: 1,
      }).format(Number(value));
export const percent = (value: unknown) =>
  value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
export const duration = (value: unknown) =>
  value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value) >= 1000
      ? `${(Number(value) / 1000).toFixed(1)}s`
      : `${Math.round(Number(value))}ms`;
export const emptyLabel = (value: unknown) => (value == null ? "—" : String(value));
export const publicFormatMetric = (metric: PublicMetric, value: unknown) => {
  if (value == null) return "Unavailable";
  if (metric === "cost" || metric === "market_cost") return money(value);
  return count(value);
};
export const bucketLabel = (bucket: string) =>
  bucket === "hour" ? "Hourly" : bucket === "six-hour" ? "6-hour" : bucket === "day" ? "Daily" : bucket === "week" ? "Weekly" : "Monthly";
export const chartTick = (bucket: string, value: number) => {
  const date = new Date(value);
  if (bucket === "hour" || bucket === "six-hour")
    return date.toLocaleString(undefined, {
      ...(bucket === "six-hour" ? { month: "short", day: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    });
  return date.toLocaleDateString(undefined, {
    month: "short",
    ...(bucket === "month" ? { year: "numeric" } : { day: "numeric" }),
  });
};

function empty(value: unknown) {
  return value == null ? "—" : count(value);
}

function Tiles({ summary, transport, kind }: { summary: AnalyticsNumbers; transport?: AnalyticsNumbers; kind: "live" | "sample" }) {
  const source = kind === "live" ? "public aggregate" : "sample data";
  return (
    <div className="stats-grid">
      <Tile label="Model calls" value={count(summary.calls)} hint={`${count(transport?.attempts)} observed attempts · ${source}`} icon={Zap} />
      <Tile label="Input tokens" value={count(summary.input_tokens)} hint={`${count(summary.cache_read_tokens)} cache-read tokens`} icon={ArrowUpRight} />
      <Tile label="Output tokens" value={count(summary.output_tokens)} hint={`${count(summary.reasoning_tokens)} reasoning tokens (separate)`} icon={Layers} />
      <Tile label="Total tokens" value={count(summary.total_tokens)} hint={`${count(summary.unknown_usage_calls)} calls with incomplete usage`} icon={Activity} />
      <Tile label="Recorded cost" value={money(summary.cost)} hint={`${count(summary.unknown_cost_calls)} calls unavailable`} icon={Coins} />
      <Tile label="Market value (pseudo-cost)" value={money(summary.market_cost)} hint={`${count(summary.unknown_market_calls)} unpriced calls`} icon={DollarSign} />
    </div>
  );
}

function Tile({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: any }) {
  return (
    <section className="stat">
      <div className="stat-label">
        {label}
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <p>{hint}</p>
    </section>
  );
}

function ReusePanel({ stats }: { stats: PublicAnalytics }) {
  const s = stats.summary;
  return (
    <section className="panel reuse-panel">
      <div className="panel-title">
        <div>
          <h2>Context reuse</h2>
          <p>Provider-reported prompt caching · token-weighted, separate from context-window use</p>
        </div>
        <RefreshCw size={18} />
      </div>
      <div className="reuse-metrics">
        <Mini label="Cached share of measured prompt tokens" value={percent(s.cache_reuse_ratio)} />
        <Mini label="Measured calls with cache hits" value={percent(s.cache_hit_ratio)} />
        <Mini label="Cache read / write tokens" value={`${count(s.cache_read_tokens)} / ${count(s.cache_write_tokens)}`} />
        <Mini label="Estimated cache-read API reduction" value={money(s.cache_savings)} />
      </div>
      <div className="chart">
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={stats.series}>
            <XAxis dataKey="time" type="number" scale="time" domain={[stats.timeframe.from, stats.timeframe.to]} hide />
            <YAxis tickFormatter={count} width={60} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={chartTooltipStyle}
              labelStyle={{ color: "var(--text)" }}
              labelFormatter={value => new Date(Number(value)).toLocaleString()}
              formatter={(value: any) => count(value)}
            />
            <Bar dataKey="input_tokens" name="Uncached input" stackId="prompt" fill="var(--purple)" isAnimationActive={false} />
            <Bar dataKey="cache_read_tokens" name="Cache reads" stackId="prompt" fill="var(--cache-read)" isAnimationActive={false} />
            <Bar dataKey="cache_write_tokens" name="Cache writes" stackId="prompt" fill="var(--cache-write)" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-caption">
        Cache information is available for {count(s.known_cache_calls)} of {count(s.calls)} calls. Estimated reductions use matching API rates, never
        subscription invoices.
      </p>
    </section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="mini">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function sortGroups(groups: PublicGroup[], key: string, dir: "asc" | "desc") {
  return [...groups].sort((a, b) => {
    if (key === "label") return dir === "asc" ? a.label.localeCompare(b.label) : b.label.localeCompare(a.label);
    const av = Number(a[key]),
      bv = Number(b[key]);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
}

const columns: [string, string][] = [
  ["label", "Model / provider"],
  ["calls", "Calls"],
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
  ["cache_read_tokens", "Cache read"],
  ["reasoning_tokens", "Reasoning"],
  ["total_tokens", "Total"],
  ["cache_reuse_ratio", "Reuse"],
  ["cost", "Cost"],
  ["market_cost", "Market rate"],
];

function Breakdown({
  stats,
  grouping,
  sort: controlledSort,
  onSortChange,
}: {
  stats: PublicAnalytics;
  grouping: Grouping;
  sort?: { key: string; dir: "asc" | "desc" };
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" }) => void;
}) {
  const groups = grouping === "provider" ? stats.providerGroups : stats.modelGroups;
  const [localSort, setLocalSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "calls", dir: "desc" });
  const sort = controlledSort ?? localSort;
  const sorted = useMemo(() => sortGroups(groups, sort.key, sort.dir), [groups, sort]);
  const toggle = (key: string) => {
    const next = { key, dir: (sort.key === key && sort.dir === "desc" ? "asc" : "desc") as "asc" | "desc" };
    if (onSortChange) onSortChange(next);
    else setLocalSort(next);
  };
  return (
    <section className="panel public-breakdown">
      <div className="panel-title">
        <div>
          <h2>{grouping === "provider" ? "Provider breakdown" : "Model breakdown"}</h2>
          <p>Aggregate only · click a header to sort locally · no account, machine, or session drill-down</p>
        </div>
        <span className="badge neutral">{groups.length} groups</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} tabIndex={0} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => toggle(key)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(key); } }}>
                  {label}
                  <span className="sort-mark">{sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((group, index) => (
              <tr key={`${group.id}-${index}`}>
                <td>
                  <strong>{group.label}</strong>
                  {group.provider && <small>{group.provider}</small>}
                </td>
                <td className="numeric">{empty(group.calls)}</td>
                <td className="numeric">{empty(group.input_tokens)}</td>
                <td className="numeric">{empty(group.output_tokens)}</td>
                <td className="numeric">{empty(group.cache_read_tokens)}</td>
                <td className="numeric">{empty(group.reasoning_tokens)}</td>
                <td className="numeric">{empty(group.total_tokens)}</td>
                <td className="numeric">{percent(group.cache_reuse_ratio)}</td>
                <td className="numeric">{money(group.cost)}</td>
                <td className="numeric">{money(group.market_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sorted.length && <Empty text="No aggregate groups were returned for this window." />}
      </div>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="empty compact">
      <Activity size={26} />
      <p>{text}</p>
    </div>
  );
}

export function AnalyticsView({
  stats,
  grouping,
  metric,
  kind,
  pending = false,
  sort,
  onSortChange,
}: {
  stats: PublicAnalytics;
  grouping: Grouping;
  metric: PublicMetric;
  kind: "live" | "sample";
  pending?: boolean;
  sort?: { key: string; dir: "asc" | "desc" };
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" }) => void;
}) {
  const groups = grouping === "provider" ? stats.providerGroups : stats.modelGroups;
  const colors = useMemo(() => groupColors(groups, grouping, kind === "sample" ? stats.modelGroups : stats.modelGroups), [groups, grouping, stats.modelGroups]);
  const context = stats.contextDistribution;
  const transport = stats.transport;
  const chartPending = pending || (stats.groupBy != null && stats.groupBy !== grouping);
  return (
    <>
      <Tiles summary={stats.summary} transport={transport} kind={kind} />
      <div className={`charts-grid primary-charts${chartPending ? " charts-pending" : ""}`} aria-busy={chartPending} aria-label={chartPending ? "Loading charts" : undefined}>
        <UsageChart
          key={`${kind}/${grouping}`}
          stats={stats}
          metric={metric}
          groups={groups}
          colors={colors}
          grouped
          groupLabel={grouping === "provider" ? "providers" : "models"}
        />
        <ActivityChart groups={groups} metric={metric} colors={colors} title={grouping === "provider" ? "Provider activity" : "Model activity"} />
      </div>
      <ReusePanel stats={stats} />
      <div className="charts-grid distribution-grid">
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Generated output lengths</h2>
              <p>Adaptive token ranges · explicit outlier tail when needed</p>
            </div>
            <Layers size={18} />
          </div>
          {stats.outputDistribution?.length ? (
            <div className="chart">
              <DistributionChart data={stats.outputDistribution} />
            </div>
          ) : (
            <Empty text="No output-length distribution was returned." />
          )}
        </section>
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Context utilization</h2>
              <p>Observed provider attempts · cached tokens included where measurable</p>
            </div>
            <Activity size={18} />
          </div>
          {context?.length ? (
            <div className="chart">
              <DistributionChart data={context} valueKey="attempts" name="HTTP attempts" color="var(--purple)" />
              <p className="chart-caption">
                Median utilization {percent(stats.contextPercentiles?.p50_ratio)} · p95 {percent(stats.contextPercentiles?.p95_ratio)}. Values use each
                request model's configured context limit.
              </p>
            </div>
          ) : (
            <Empty text="No context-utilization distribution is published for this window." />
          )}
        </section>
      </div>
      <div className="health-grid">
        <Mini label="Median / p95 lifecycle duration" value={`${duration(stats.summary.p50_ms)} / ${duration(stats.summary.p95_ms)}`} />
        <Mini label="Median / p95 output tokens" value={`${count(stats.summary.p50_output_tokens)} / ${count(stats.summary.p95_output_tokens)}`} />
        <Mini label="Median first streamed output" value={duration(transport?.first_output_ms)} />
        <Mini
          label="Context p50 / p95"
          value={`${stats.contextPercentiles?.p50_ratio == null ? "—" : `${(Number(stats.contextPercentiles.p50_ratio) * 100).toFixed(0)}%`} / ${
            stats.contextPercentiles?.p95_ratio == null ? "—" : `${(Number(stats.contextPercentiles.p95_ratio) * 100).toFixed(0)}%`
          }`}
        />
        <Mini label="Failed / cancelled attempts" value={`${count(transport?.failed)} / ${count(transport?.cancelled)}`} />
        <Mini label="Observed HTTP attempts" value={count(transport?.attempts)} />
      </div>
      <Breakdown stats={stats} grouping={grouping} sort={sort} onSortChange={onSortChange} />
      <p className="footnote">
        Total tokens include cached prompt tokens and completion including reasoning, without adding overlapping categories twice. Unknown pricing stays
        unavailable. Market value excludes subscription fees and is not an invoice. {kind === "live" ? "Aggregates are allowlisted; account, credential, machine, and session identities are never exposed." : "Synthetic sample values are fictional and unrelated to any live workspace."}
      </p>
      {kind === "live" && (
        <p className="public-privacy-note">
          <ShieldCheck size={13} /> Transport figures are derived from observed attempts. Raw prompts, responses, credentials, accounts, and machines
          are not part of this public response.
        </p>
      )}
    </>
  );
}

export function AnalyticsSkeleton() {
  return (
    <>
      <div className="stats-grid" aria-busy="true" role="status" aria-label="Loading public analytics">
        {["Model calls", "Input tokens", "Output tokens", "Total tokens", "Recorded cost", "Market value"].map(label => (
          <section className="stat" key={label}>
            <div className="stat-label">
              {label}
              <Activity size={17} />
            </div>
            <strong>—</strong>
            <p>Loading aggregate stats…</p>
          </section>
        ))}
      </div>
      <div className="charts-grid primary-charts" aria-busy="true" role="status" aria-label="Loading charts">
        <section className="panel chart-loading">
          <div className="panel-title">
            <div>
              <h2>Usage over time</h2>
              <p>Loading chart data…</p>
            </div>
          </div>
          <div className="chart-placeholder" aria-hidden="true" />
        </section>
        <section className="panel chart-loading">
          <div className="panel-title">
            <div>
              <h2>Activity</h2>
              <p>Loading chart data…</p>
            </div>
          </div>
          <div className="chart-placeholder" aria-hidden="true" />
        </section>
      </div>
    </>
  );
}
