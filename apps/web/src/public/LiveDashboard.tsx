import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, Filter, LockKeyhole, RefreshCw, RotateCcw, ShieldCheck, WifiOff } from "lucide-react";
import { AnalyticsSkeleton, AnalyticsView, bucketLabel, publicMetrics } from "./AnalyticsView";
import { fetchPublicAnalytics, PublicApiError } from "./api";
import type { Grouping, PublicAnalytics, PublicMetric } from "./types";

const WEEK = 7 * 86400000;
const MARGIN = 120000;
const AUTO_REFRESH_MS = 60000;
type RangeKey = "24h" | "48h" | "7d" | "custom";
type Window = { from: number; to: number };
type ModelOption = { label: string; providers: string[] };
type ApiError = { status: number; message: string; retryAfter: number | null };

const inputValue = (ms: number) => {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
};
const rolling = (key: Exclude<RangeKey, "custom">): Window => {
  const to = Date.now();
  const span = key === "24h" ? 86400000 : key === "48h" ? 2 * 86400000 : WEEK;
  return { from: to - span + MARGIN, to };
};
const rangeText = (range: RangeKey) =>
  range === "24h" ? "Last 24 hours" : range === "48h" ? "Last 48 hours" : range === "7d" ? "Last 7 days" : "Custom range";
const amount = (value: number | null) => (value == null ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`);

const validRanges = new Set<RangeKey>(["24h", "48h", "7d", "custom"]);
const validMetrics = new Set<PublicMetric>(publicMetrics.map(([key]) => key));
function parseLiveUrl() {
  const p = new URLSearchParams(location.search);
  const rawRange = p.get("range") as RangeKey | null;
  let range: RangeKey = rawRange && validRanges.has(rawRange) ? rawRange : "7d";
  let window = rolling(range === "custom" ? "7d" : range);
  if (range === "custom") {
    const from = Number(p.get("from")), to = Number(p.get("to")), now = Date.now();
    if (Number.isFinite(from) && Number.isFinite(to) && to > from && from >= now - WEEK && to <= now + 60000) {
      window = { from, to };
    } else {
      range = "7d";
    }
  }
  const grouping: Grouping = p.get("groupBy") === "provider" ? "provider" : "model";
  const m = p.get("metric") as PublicMetric | null;
  const metric: PublicMetric = m && validMetrics.has(m) ? m : "total_tokens";
  const provider = p.get("provider") ?? "";
  const model = p.get("model") ?? "";
  const sortBy = p.get("sortBy") || "calls";
  const sortDir: "asc" | "desc" = p.get("sortDir") === "asc" ? "asc" : "desc";
  return { range, window, customFrom: inputValue(window.from), customTo: inputValue(window.to), grouping, metric, provider, model, sort: { key: sortBy, dir: sortDir } };
}
function buildLiveUrl(s: { range: RangeKey; window: Window; grouping: Grouping; metric: PublicMetric; provider: string; model: string; sort: { key: string; dir: "asc" | "desc" } }) {
  const p = new URLSearchParams();
  if (s.range !== "7d") p.set("range", s.range);
  if (s.range === "custom") {
    p.set("from", String(s.window.from));
    p.set("to", String(s.window.to));
  }
  if (s.grouping !== "model") p.set("groupBy", s.grouping);
  if (s.metric !== "total_tokens") p.set("metric", s.metric);
  if (s.provider) p.set("provider", s.provider);
  if (s.model) p.set("model", s.model);
  if (s.sort.key !== "calls" || s.sort.dir !== "desc") {
    p.set("sortBy", s.sort.key);
    p.set("sortDir", s.sort.dir);
  }
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

export function LiveDashboard({ onOpenSample }: { onOpenSample: () => void }) {
  const initial = useMemo(() => parseLiveUrl(), []);
  const [range, setRange] = useState<RangeKey>(initial.range);
  const [window, setWindow] = useState<Window>(initial.window);
  const [customFrom, setCustomFrom] = useState(initial.customFrom);
  const [customTo, setCustomTo] = useState(initial.customTo);
  const [rangeError, setRangeError] = useState("");
  const [grouping, setGrouping] = useState<Grouping>(initial.grouping);
  const [metric, setMetric] = useState<PublicMetric>(initial.metric);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>(initial.sort);
  const [stats, setStats] = useState<PublicAnalytics | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const fromPop = useRef(false);

  useEffect(() => {
    if (fromPop.current) { fromPop.current = false; return; }
    const next = buildLiveUrl({ range, window, grouping, metric, provider, model, sort });
    if (next !== location.pathname + location.search) history.replaceState(null, "", next);
  }, [range, window.from, window.to, grouping, metric, provider, model, sort]);

  useEffect(() => {
    const onPop = () => {
      fromPop.current = true;
      const next = parseLiveUrl();
      setRange(next.range);
      setWindow(next.window);
      setCustomFrom(next.customFrom);
      setCustomTo(next.customTo);
      setGrouping(next.grouping);
      setMetric(next.metric);
      setProvider(next.provider);
      setModel(next.model);
      setSort(next.sort);
      setRangeError("");
    };
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);

  const applyCatalog = useCallback((value: PublicAnalytics) => {
    setProviders([...new Set(value.providerGroups.map(group => group.id))].sort());
    const byLabel = new Map<string, Set<string>>();
    for (const group of value.modelGroups) {
      const label = group.label?.trim();
      if (!label) continue;
      if (!byLabel.has(label)) byLabel.set(label, new Set());
      const providerLabel = typeof group.provider === "string" ? group.provider.trim() : "";
      if (providerLabel) byLabel.get(label)!.add(providerLabel);
    }
    setModels(
      [...byLabel]
        .map(([label, providers]) => ({ label, providers: [...providers].sort() }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    );
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      from: String(window.from),
      to: String(window.to),
      groupBy: grouping,
    });
    if (provider) query.set("provider", provider);
    if (model) query.set("model", model);
    fetchPublicAnalytics(query, abort.signal)
      .then(value => {
        setStats(value);
        setUpdatedAt(Date.now());
        if (!provider && !model) {
          applyCatalog(value);
        } else if (!providers.length) {
          fetchPublicAnalytics(new URLSearchParams({ from: String(window.from), to: String(window.to), groupBy: "model" }), abort.signal)
            .then(applyCatalog)
            .catch(() => {});
        }
      })
      .catch(value => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        const api = value instanceof PublicApiError ? value : new PublicApiError("Public analytics could not be loaded.");
        setError({ status: api.status, message: api.message, retryAfter: api.retryAfter });
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [window.from, window.to, grouping, provider, model, tick]);

  useEffect(() => {
    if (range === "custom") return;
    const updateRollingWindow = () => {
      if (document.visibilityState === "visible") setWindow(rolling(range));
    };
    const timer = globalThis.setInterval(updateRollingWindow, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", updateRollingWindow);
    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateRollingWindow);
    };
  }, [range]);

  const modelChoices = useMemo(
    () => models.filter(option => !provider || option.providers.includes(provider)),
    [models, provider],
  );
  const chooseProvider = (value: string) => {
    setProvider(value);
    if (model) {
      const selected = models.find(option => option.label === model);
      if (selected && value && !selected.providers.includes(value)) setModel("");
    }
  };
  const resetFilters = () => {
    setProvider("");
    setModel("");
  };
  const chooseRange = (value: RangeKey) => {
    setRange(value);
    setRangeError("");
    if (value === "custom") {
      setCustomFrom(inputValue(window.from));
      setCustomTo(inputValue(window.to));
      return;
    }
    setWindow(rolling(value));
  };
  const applyCustom = () => {
    const from = new Date(customFrom).getTime(),
      to = new Date(customTo).getTime(),
      now = Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to)) return setRangeError("Enter both a start and an end time.");
    if (to <= from) return setRangeError("The end must be later than the start.");
    if (Math.floor(to / 3600000) <= Math.ceil(from / 3600000)) return setRangeError("Choose a range containing at least one completed hour.");
    if (to > now + 60000) return setRangeError("The end cannot be in the future.");
    if (from < now - WEEK + MARGIN)
      return setRangeError("Public analytics only cover the last rolling seven days. Choose a later start.");
    if (to - from > WEEK - MARGIN)
      return setRangeError("Choose a window of seven days or less.");
    setRangeError("");
    setRange("custom");
    setWindow({ from, to });
    setTick(value => value + 1);
  };
  const refresh = useCallback(() => {
    if (range !== "custom") setWindow(rolling(range));
    setTick(value => value + 1);
  }, [range]);

  const disabled = error?.status === 404;
  const temporarilyUnavailable = error?.status === 503;
  const activeGroups = stats ? (grouping === "provider" ? stats.providerGroups : stats.modelGroups) : [];
  const currentWindow = stats?.timeframe ?? { from: window.from, to: window.to, bucket: "hour" };
  const customMin = inputValue(Date.now() - WEEK + MARGIN);
  const customMax = inputValue(Date.now());

  return (
    <div className="public-dashboard">
      <section className="filters public-filterbar" aria-label="Live aggregate filters">
        <Filter size={16} />
        <label className="filter">
          <span>Timeframe</span>
          <select value={range} onChange={event => chooseRange(event.target.value as RangeKey)}>
            <option value="24h">Last 24 hours</option>
            <option value="48h">Last 48 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {range === "custom" && (
          <>
            <label className="filter">
              <span>From (local)</span>
              <input type="datetime-local" value={customFrom} min={customMin} max={customMax} onChange={event => setCustomFrom(event.target.value)} />
            </label>
            <label className="filter">
              <span>To (local)</span>
              <input type="datetime-local" value={customTo} min={customMin} max={customMax} onChange={event => setCustomTo(event.target.value)} />
            </label>
            <button className="button subtle" onClick={applyCustom}>
              <CalendarRange size={14} /> Apply
            </button>
          </>
        )}
        <label className="filter">
          <span>Provider</span>
          <select value={provider} onChange={event => chooseProvider(event.target.value)} disabled={!providers.length}>
            <option value="">All providers</option>
            {providers.map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Model</span>
          <select value={model} onChange={event => setModel(event.target.value)} disabled={!modelChoices.length}>
            <option value="">All models</option>
            {modelChoices.map(option => (
              <option key={option.label} value={option.label}>
                {option.label}
                {option.providers.length > 1 ? " · multiple providers" : option.providers[0] ? ` · ${option.providers[0]}` : ""}
              </option>
            ))}
          </select>
        </label>
        {(provider || model) && (
          <button className="text-button" onClick={resetFilters}>
            Clear filters
          </button>
        )}
        <button className="button subtle public-refresh" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
        </button>
      </section>
      {rangeError && (
        <div className="error" role="alert">
          {rangeError}
        </div>
      )}
      {stats && loading && (
        <div className="public-refresh-state" role="status" aria-live="polite">
          <RefreshCw size={13} className="spin" /> Refreshing live aggregate. Showing the last successful result
          {updatedAt ? ` from ${new Date(updatedAt).toLocaleTimeString()}` : ""} until this request finishes.
        </div>
      )}
      <div className="public-window-note">
        <CalendarRange size={13} />
        <strong>{bucketLabel(currentWindow.bucket)} aggregates</strong>
        <span>
          {new Date(currentWindow.from).toLocaleString()} → {new Date(currentWindow.to).toLocaleString()}
        </span>
        <span>{updatedAt ? `· Last loaded ${new Date(updatedAt).toLocaleTimeString()}` : "· Waiting for the live endpoint"}</span>
        <span>· {range === "custom" ? "Custom ranges refresh on demand" : "Rolling windows refresh automatically every minute"}</span>
        <span>· Times are local; completed hours only.</span>
      </div>

      <div className="analytics-controls">
        <div className="control-group">
          <span>Group by</span>
          <div className="segmented">
            {(["model", "provider"] as const).map(value => (
              <button key={value} aria-pressed={grouping === value} className={grouping === value ? "chosen" : ""} onClick={() => setGrouping(value)}>
                {value === "model" ? "Models" : "Providers"}
              </button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span>Measure</span>
          <div className="segmented">
            {publicMetrics.map(([key, label]) => (
              <button key={key} aria-pressed={metric === key} className={metric === key ? "chosen" : ""} onClick={() => setMetric(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="loading-line" />}

      {!stats && loading && <AnalyticsSkeleton />}

      {!stats && !loading && error && (
        <section className={`panel public-state ${disabled ? "disabled" : ""}`} role="alert">
          <div className="public-state-icon">{disabled ? <LockKeyhole size={26} /> : temporarilyUnavailable ? <WifiOff size={26} /> : <ShieldCheck size={26} />}</div>
          <h2>{disabled ? "Live public analytics are disabled" : temporarilyUnavailable ? "Live analytics are temporarily unavailable" : "Live analytics did not load"}</h2>
          <p>{error.message}</p>
          {!disabled && (
            <button className="button primary" onClick={refresh}>
              <RefreshCw size={14} /> Try again
            </button>
          )}
          <button className="button subtle" onClick={onOpenSample}>
            Explore the synthetic sample workspace
          </button>
          <small>
            The sample workspace is fictional demonstration data. It never calls this endpoint and cannot be mixed with live aggregates.
          </small>
        </section>
      )}

      {stats && error && (
        <div className="error public-stale" role="alert">
          {error.message} {stats && "Showing the last successful aggregate."} <button className="text-button" onClick={refresh}>Retry</button>
        </div>
      )}

      {stats && (
        <AnalyticsView stats={stats} grouping={grouping} metric={metric} kind="live" pending={loading} sort={sort} onSortChange={setSort} />
      )}

      {stats && !loading && !activeGroups.length && (
        <div className="public-empty-note">
          <WifiOff size={15} /> No aggregate calls matched this window or filter. Try a wider range or clear the provider/model filter.
        </div>
      )}

      {stats && (
        <div className="public-transport-note">
          <ShieldCheck size={13} /> Public transport summary: {amount(stats.transport?.first_output_ms ?? null)} median first output ·{" "}
          {stats.transport?.attempts ?? "—"} observed attempts · {stats.summary.failures ?? "—"} failed calls including retries.{" "}
          <button className="text-button" onClick={onOpenSample}>
            Open the labeled sample workspace
          </button>
        </div>
      )}
    </div>
  );
}
