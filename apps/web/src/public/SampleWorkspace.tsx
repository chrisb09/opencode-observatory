import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Filter,
  FlaskConical,
  LayoutDashboard,
  Layers,
  Monitor,
  Paperclip,
  RefreshCw,
  Terminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import { AnalyticsView, count, duration, emptyLabel, metricName, publicMetrics } from "./AnalyticsView";
import { money } from "../format";
import { buildSampleAnalytics, accountRows, machineRows, type SampleAccountRow, type SampleMachineRow } from "./sampleAnalytics";
import {
  SAMPLE_LABEL,
  groupSampleErrors,
  sampleAccounts,
  sampleAttempts,
  sampleAttachments,
  sampleMachines,
  sampleModels,
  sampleSessions,
  sampleTools,
  type SampleAttempt,
  type SampleAttachment,
  type SampleMachine,
  type SampleSession,
  type SampleSessionError,
  type SampleTool,
} from "./sampleData";
import type { Grouping, PublicMetric } from "./types";

type SampleView = "overview" | "accounts" | "machines" | "sessions" | "requests" | "errors" | "tools" | "attachments";
type Selected =
  | { kind: "session"; value: SampleSession }
  | { kind: "account"; value: SampleAccountRow }
  | { kind: "machine"; value: SampleMachineRow }
  | { kind: "request"; value: SampleAttempt }
  | { kind: "error"; value: SampleSessionError }
  | { kind: "tool"; value: SampleTool }
  | { kind: "attachment"; value: SampleAttachment };

const nav: { id: SampleView; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "accounts", label: "Accounts & keys", icon: Users },
  { id: "machines", label: "Machines", icon: Monitor },
  { id: "sessions", label: "Sessions", icon: Layers },
  { id: "requests", label: "Request attempts", icon: Zap },
  { id: "errors", label: "Error breakdown", icon: CircleAlert },
  { id: "tools", label: "Tool executions", icon: Terminal },
  { id: "attachments", label: "Attachments", icon: Paperclip },
];

const date = (value: number | null | undefined) => (value == null ? "—" : new Date(value).toLocaleString());
const short = (value: string) => (value.length > 24 ? `${value.slice(0, 21)}…` : value);
const PAGE = 10;

function Status({ value }: { value: string }) {
  return (
    <span className={`badge ${value}`}>
      <i />
      {value}
    </span>
  );
}

function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="pagination">
      <span>
        {total ? Math.min(page * PAGE + 1, total) : 0}–{Math.min((page + 1) * PAGE, total)} of {total} sample records
      </span>
      <div>
        <button className="icon" aria-label="Previous page" disabled={page === 0} onClick={() => onChange(page - 1)}>
          <ChevronLeft size={18} />
        </button>
        <button className="icon" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="empty compact">
      <Filter size={24} />
      <p>{text}</p>
    </div>
  );
}

function Row({ children, onOpen, className = "" }: { children: React.ReactNode; onOpen: () => void; className?: string }) {
  return (
    <tr className={`clickable ${className}`} tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
      {children}
    </tr>
  );
}

function sampleTableProps(page: number) {
  const start = page * PAGE;
  return { start, end: start + PAGE };
}

export function SampleWorkspace() {
  const [view, setView] = useState<SampleView>("overview");
  const [grouping, setGrouping] = useState<Grouping>("model");
  const [metric, setMetric] = useState<PublicMetric>("total_tokens");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [machine, setMachine] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(null);

  const modelChoices = sampleModels.filter(item => !provider || item.provider === provider);
  const machineLabel = useMemo(() => sampleMachines.find(item => item.id === machine)?.label ?? "", [machine]);
  const selectProvider = (value: string) => {
    setProvider(value);
    setPage(0);
    if (model && !sampleModels.some(item => item.name === model && (!value || item.provider === value))) setModel("");
  };
  const open = (value: Selected) => setSelected(value);
  const close = useCallback(() => setSelected(null), []);
  const go = (id: SampleView) => {
    setView(id);
    setPage(0);
    setSelected(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const reset = () => {
    setProvider("");
    setModel("");
    setMachine("");
    setStatus("");
    setSearch("");
    setPage(0);
  };

  const filteredSessions = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matchesStep = (step: SampleSession["steps"][number]) =>
      (!provider || step.provider === provider) && (!model || step.model === model);
    return sampleSessions.filter(session => {
      if ((provider || model) && !session.steps.some(matchesStep)) return false;
      if (machine && session.machineId !== machine) return false;
      if (status && session.status !== status) return false;
      if (!term) return true;
      return [session.id, session.title, session.agent, session.machine, session.summary, session.detailedSummary, ...session.files]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [provider, model, machine, status, search]);

  // Provider/model filters select whole sessions, but aggregates should only
  // include steps that actually match. Session tables keep the full session.
  const analyticsSessions = useMemo(() => {
    if (!provider && !model) return filteredSessions;
    return filteredSessions.map(session => ({
      ...session,
      steps: session.steps.filter(step => (!provider || step.provider === provider) && (!model || step.model === model)),
    }));
  }, [filteredSessions, provider, model]);
  const sessionIds = useMemo(() => new Set(filteredSessions.map(session => session.id)), [filteredSessions]);
  const analytics = useMemo(() => buildSampleAnalytics(analyticsSessions, grouping), [analyticsSessions, grouping]);
  const accounts = useMemo(() => accountRows(analyticsSessions), [analyticsSessions]);
  const machines = useMemo(() => machineRows(analyticsSessions), [analyticsSessions]);
  const attempts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sampleAttempts.filter(attempt => {
      if (!sessionIds.has(attempt.sessionId) && !provider && !model && !machine && !status && !term) return true;
      if (provider && attempt.provider !== provider) return false;
      if (model && attempt.model !== model) return false;
      if (machine && attempt.machine !== machineLabel) return false;
      if (status && attempt.status !== status) return false;
      if (!term) return true;
      return [attempt.id, attempt.sessionId, attempt.model, attempt.provider, attempt.machine, attempt.usageSource, attempt.error]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [sessionIds, provider, model, machine, machineLabel, status, search]);
  const tools = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sampleTools.filter(tool => {
      if (!sessionIds.has(tool.sessionId)) return false;
      if (machine && tool.machine !== machineLabel) return false;
      if (status && tool.status !== status) return false;
      if (!term) return true;
      return [tool.id, tool.tool, tool.invocation, tool.sessionId, tool.machine].join(" ").toLowerCase().includes(term);
    });
  }, [sessionIds, machine, machineLabel, status, search]);
  const attachments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sampleAttachments.filter(attachment => {
      if (!sessionIds.has(attachment.sessionId)) return false;
      if (machine && attachment.machine !== machineLabel) return false;
      if (!term) return true;
      return [attachment.id, attachment.name, attachment.mime, attachment.sessionId, attachment.machine].join(" ").toLowerCase().includes(term);
    });
  }, [sessionIds, machine, machineLabel, search]);
  const errors = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groupSampleErrors(
      sampleAttempts.filter(attempt => {
        if (!attempt.error || attempt.retry) return false;
        if (provider && attempt.provider !== provider) return false;
        if (model && attempt.model !== model) return false;
        if (machine && attempt.machine !== machineLabel) return false;
        if (status && !sessionIds.has(attempt.sessionId)) return false;
        if (!term) return sessionIds.has(attempt.sessionId);
        const searchable = [attempt.error, attempt.provider, attempt.model, attempt.machine, attempt.usageSource, attempt.status, attempt.httpStatus ?? ""]
          .join(" ")
          .toLowerCase();
        return searchable.includes(term) || sessionIds.has(attempt.sessionId);
      }),
    );
  }, [sessionIds, provider, model, machine, machineLabel, status, search]);

  const paged = <T,>(rows: T[]) => rows.slice(page * PAGE, page * PAGE + PAGE);
  const packageA = sampleTableProps(page);

  return (
    <div className="sample-workspace" role="region" aria-label="Synthetic sample workspace">
      <div className="sample-banner" role="note">
        <FlaskConical size={16} />
        <strong>SYNTHETIC SAMPLE WORKSPACE</strong>
        <span>
          {SAMPLE_LABEL} · fictional providers, accounts, machines, sessions, and costs. Read-only; nothing is sent, saved, or connected to live
          analytics.
        </span>
      </div>

      <section className="public-hero sample-hero">
        <div>
          <div className="eyebrow">DEMONSTRATION MODE · FICTIONAL DATA</div>
          <h1>A complete workspace, clearly not live.</h1>
          <p>
            Explore how detailed accounts, machines, sessions, request attempts, errors, tools, and attachments could be presented. Every row and
            number on this page is generated sample data.
          </p>
        </div>
        <div className="sample-hero-card">
          <FlaskConical size={22} />
          <strong>Sample period</strong>
          <span>{SAMPLE_LABEL}</span>
          <small>{sampleSessions.length} sessions · {sampleAttempts.length} attempts · {sampleTools.length} tools · {sampleAttachments.length} attachments</small>
        </div>
      </section>

      <section className="public-filterbar sample-filterbar" aria-label="Synthetic sample filters">
        <Filter size={16} />
        <strong className="sample-filter-label">Sample filters</strong>
        <label className="filter"><span>Provider</span><select value={provider} onChange={event => selectProvider(event.target.value)}><option value="">All sample providers</option>{[...new Set(sampleModels.map(item => item.provider))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="filter"><span>Model</span><select value={model} onChange={event => { setModel(event.target.value); setPage(0); }}><option value="">All sample models</option>{modelChoices.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <label className="filter"><span>Machine</span><select aria-label="Machine" value={machine} onChange={event => { setMachine(event.target.value); setPage(0); }}><option value="">All sample machines</option>{sampleMachines.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="filter"><span>Status</span><select value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">Any status</option>{["completed", "failed", "cancelled"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="filter sample-search"><span>Search sample</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="session, tool, error…" /></label>
        <button className="text-button" onClick={reset}><RefreshCw size={13} /> Reset sample filters</button>
      </section>

      <div className="sample-layout">
        <nav className="sample-nav" aria-label="Synthetic sample sections">
          <div className="sample-nav-title">SAMPLE VIEWS</div>
          {nav.map(item => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}>
              <item.icon size={16} />
              {item.label}
              {view === item.id && <span className="nav-dot" />}
            </button>
          ))}
          <div className="sample-readonly">Read-only demonstration<br /><small>No export · no settings · no mutations</small></div>
        </nav>

        <div className="sample-content">
          <div className="sample-view-heading">
            <div>
              <div className="eyebrow">SAMPLE · {nav.find(item => item.id === view)?.label.toUpperCase()}</div>
              <h2>{nav.find(item => item.id === view)?.label}</h2>
            </div>
            <span className="sample-chip"><FlaskConical size={12} /> Synthetic</span>
          </div>

          {view === "overview" && (
            <>
              <div className="analytics-controls">
                <div className="control-group"><span>Group by</span><div className="segmented">{(['model', 'provider'] as const).map(value => <button key={value} aria-pressed={grouping === value} className={grouping === value ? "chosen" : ""} onClick={() => setGrouping(value)}>{value === "model" ? "Models" : "Providers"}</button>)}</div></div>
                <div className="control-group"><span>Measure</span><div className="segmented">{publicMetrics.map(([key, label]) => <button key={key} aria-pressed={metric === key} className={metric === key ? "chosen" : ""} onClick={() => setMetric(key)}>{label}</button>)}</div></div>
              </div>
              <div className="sample-summary-strip">
                <span><strong>{filteredSessions.length}</strong> matching sessions</span>
                <span><strong>{analytics.summary.calls}</strong> sample calls</span>
                <span><strong>{metricName(metric)}</strong> selected measure</span>
                <span><strong>No live data</strong> mixed into this view</span>
              </div>
              <AnalyticsView stats={analytics} grouping={grouping} metric={metric} kind="sample" />
            </>
          )}

          {view === "accounts" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Accounts & provider keys</h2><p>Fictional identities · aggregated from the currently filtered sample sessions · no secret material exists</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Account</th><th>Provider</th><th>Kind</th><th>Sessions</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th><th>Cost</th><th>Market</th><th>Last seen</th></tr></thead>
                <tbody>{paged(accounts).map(account => <Row key={account.id} onOpen={() => open({ kind: "account", value: account })}><td><strong>{account.label}</strong><small className="mono">{account.id}</small></td><td>{account.provider}</td><td><span className="badge neutral">{account.kind}</span></td><td>{count(account.sessions)}</td><td>{count(account.calls)}</td><td>{count(account.inputTokens)}</td><td>{count(account.outputTokens)}</td><td>{count(account.totalTokens)}</td><td>{money(account.cost)}</td><td>{money(account.marketCost)}</td><td>{date(account.lastSeen)}</td></Row>)}</tbody></table>{!accounts.length && <EmptyRow text="No sample accounts match these filters." />}</div>
              <Pagination page={page} total={accounts.length} onChange={setPage} />
            </section>
          )}

          {view === "machines" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Machines</h2><p>Fictional installations and runtime inventory · click a machine for details</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Machine</th><th>OS</th><th>Sessions</th><th>Calls</th><th>Total tokens</th><th>Cost</th><th>Market</th><th>Last seen</th></tr></thead>
                <tbody>{paged(machines).map(item => <Row key={item.id} onOpen={() => open({ kind: "machine", value: item })}><td><strong>{item.label}</strong><small className="mono">{item.install}</small></td><td>{item.os}</td><td>{item.sessions}</td><td>{count(item.calls)}</td><td>{count(item.totalTokens)}</td><td>{money(item.cost)}</td><td>{money(item.marketCost)}</td><td>{date(item.lastSeen)}</td></Row>)}</tbody></table>{!machines.length && <EmptyRow text="No sample machines match these filters." />}</div>
              <Pagination page={page} total={machines.length} onChange={setPage} />
            </section>
          )}

          {view === "sessions" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Sessions</h2><p>{filteredSessions.length} fictional sessions · click a row for summaries and model steps</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Session</th><th>Agent</th><th>Models</th><th>Machine</th><th>Status</th><th>Calls</th><th>Total</th><th>Duration</th><th>Cost</th><th>Market</th><th>Started</th></tr></thead>
                <tbody>{paged(filteredSessions).map(session => <Row key={session.id} onOpen={() => open({ kind: "session", value: session })}><td><strong>{session.title}</strong><small className="mono">{session.id}</small><small>{session.summary}</small></td><td><span className="badge neutral">{session.agent}</span></td><td><div className="sample-model-list">{[...new Set(session.steps.map(step => step.model))].map(value => <span key={value} className="badge neutral">{value}</span>)}</div></td><td>{session.machine}</td><td><Status value={session.status} /></td><td>{session.calls}</td><td>{count(session.totalTokens)}</td><td>{duration(session.durationMs)}</td><td>{money(session.cost)}</td><td>{money(session.marketCost)}</td><td>{date(session.startedAt)}</td></Row>)}</tbody></table>{!filteredSessions.length && <EmptyRow text="No sample sessions match these filters." />}</div>
              <Pagination page={page} total={filteredSessions.length} onChange={setPage} />
            </section>
          )}

          {view === "requests" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Request attempts</h2><p>Fictional HTTP attempts, including one retry after a failed call · no prompts, headers, or response bodies</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Attempt</th><th>Model / provider</th><th>Machine</th><th>Status</th><th>HTTP</th><th>Tokens</th><th>Duration</th><th>First output</th><th>Cost</th><th>Source</th><th>Started</th></tr></thead>
                <tbody>{paged(attempts).map(attempt => <Row key={attempt.id} onOpen={() => open({ kind: "request", value: attempt })}><td><strong>{short(attempt.id)}</strong><small className="mono">{attempt.sessionId}</small>{attempt.retry && <span className="badge neutral">Retry · no usage</span>}</td><td>{attempt.model}<small>{attempt.provider}</small></td><td>{attempt.machine}</td><td><Status value={attempt.status} /></td><td>{emptyLabel(attempt.httpStatus)}</td><td>{count(attempt.totalTokens)}</td><td>{duration(attempt.durationMs)}</td><td>{duration(attempt.firstOutputMs)}</td><td>{money(attempt.cost)}</td><td><span className="badge neutral">{attempt.usageSource}</span></td><td>{date(attempt.startedAt)}</td></Row>)}</tbody></table>{!attempts.length && <EmptyRow text="No sample request attempts match these filters." />}</div>
              <Pagination page={page} total={attempts.length} onChange={setPage} />
            </section>
          )}

          {view === "errors" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Error breakdown</h2><p>Fictional failures deduplicated by category, provider, model, and HTTP status</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Error category</th><th>Code</th><th>Provider / model</th><th>HTTP</th><th>Source</th><th>Occurrences</th><th>Sessions</th><th>Retryable</th><th>Last seen</th></tr></thead>
                <tbody>{paged(errors).map(error => <Row key={error.id} onOpen={() => open({ kind: "error", value: error })}><td><strong>{error.error_type}</strong><small>{error.explanation}</small></td><td className="mono">{error.error_code}</td><td>{error.provider}<small>{error.model}</small></td><td>{emptyLabel(error.http_status)}</td><td><span className="badge neutral">{error.source}</span></td><td>{error.occurrences}</td><td>{error.sessions}</td><td>{error.retryable}</td><td>{date(error.last_seen)}</td></Row>)}</tbody></table>{!errors.length && <EmptyRow text="No sample errors match these filters." />}</div>
              <Pagination page={page} total={errors.length} onChange={setPage} />
            </section>
          )}

          {view === "tools" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Tool executions</h2><p>Fictional tool metadata · arguments and output sizes are synthetic byte counts</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Tool</th><th>Invocation</th><th>Session</th><th>Machine</th><th>Status</th><th>Arguments</th><th>Output</th><th>Duration</th><th>Started</th></tr></thead>
                <tbody>{paged(tools).map(tool => <Row key={tool.id} onOpen={() => open({ kind: "tool", value: tool })}><td><strong>{tool.tool}</strong><small className="mono">{tool.id}</small></td><td>{tool.invocation}</td><td className="mono">{short(tool.sessionId)}</td><td>{tool.machine}</td><td><Status value={tool.status} /></td><td>{count(tool.argumentBytes)} B</td><td>{count(tool.outputBytes)} B</td><td>{duration(tool.durationMs)}</td><td>{date(tool.startedAt)}</td></Row>)}</tbody></table>{!tools.length && <EmptyRow text="No sample tools match these filters." />}</div>
              <Pagination page={page} total={tools.length} onChange={setPage} />
            </section>
          )}

          {view === "attachments" && (
            <section className="panel sample-table-panel">
              <div className="panel-title"><div><h2>Attachments</h2><p>Fictional descriptors only · MIME type, byte count, and hash reference; original files do not exist</p></div><span className="badge neutral">SAMPLE · read-only</span></div>
              <div className="table-wrap"><table><thead><tr><th>Name</th><th>MIME type</th><th>Session</th><th>Machine</th><th>Size</th><th>Hash</th><th>Created</th></tr></thead>
                <tbody>{paged(attachments).map(attachment => <Row key={attachment.id} onOpen={() => open({ kind: "attachment", value: attachment })}><td><strong>{attachment.name}</strong><small className="mono">{attachment.id}</small></td><td><span className="badge neutral">{attachment.mime}</span></td><td className="mono">{short(attachment.sessionId)}</td><td>{attachment.machine}</td><td>{count(attachment.bytes)} B</td><td className="mono">{short(attachment.hash)}</td><td>{date(attachment.createdAt)}</td></Row>)}</tbody></table>{!attachments.length && <EmptyRow text="No sample attachments match these filters." />}</div>
              <Pagination page={page} total={attachments.length} onChange={setPage} />
            </section>
          )}

          <div className="sample-footnote">
            <FlaskConical size={13} /> Synthetic sample workspace · fictional names and measurements · fixed period {SAMPLE_LABEL}. No request is sent
            to the public analytics endpoint.
          </div>
        </div>
      </div>

      {selected && <SampleDrawer selected={selected} close={close} />}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function SampleDrawer({ selected, close }: { selected: Selected; close: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [close]);
  return (
    <div className="overlay" onClick={close} role="presentation">
      <section ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label="Synthetic sample detail" tabIndex={-1} onClick={event => event.stopPropagation()}>
        <button ref={closeButton} className="icon close" aria-label="Close sample details" onClick={close}><X size={18} /></button>
        <div className="sample-drawer-label"><FlaskConical size={12} /> SYNTHETIC SAMPLE RECORD · NOT LIVE</div>
        {selected.kind === "session" && <SessionDetail session={selected.value} />}
        {selected.kind === "account" && <AccountDetail account={selected.value} />}
        {selected.kind === "machine" && <MachineDetail machine={selected.value} />}
        {selected.kind === "request" && <RequestDetail request={selected.value} />}
        {selected.kind === "error" && <ErrorDetail error={selected.value} />}
        {selected.kind === "tool" && <ToolDetail tool={selected.value} />}
        {selected.kind === "attachment" && <AttachmentDetail attachment={selected.value} />}
      </section>
    </div>
  );
}

function SessionDetail({ session }: { session: SampleSession }) {
  return (
    <>
      <h2>{session.title}</h2>
      <p className="mono">{session.id}</p>
      <div className="sample-detail-badges"><Status value={session.status} /><span className="badge neutral">{session.agent}</span><span className="badge neutral">{session.machine}</span></div>
      <h3>Session summary</h3>
      <p className="memory-summary">{session.summary}</p>
      <p>{session.detailedSummary}</p>
      <h3>Key decisions</h3>
      <ul>{session.decisions.map(value => <li key={value}>{value}</li>)}</ul>
      <h3>Files touched (synthetic paths)</h3>
      <div className="chips">{session.files.map(value => <span key={value} className="badge neutral">{value}</span>)}</div>
      <h3>Session metrics</h3>
      <dl>
        <DetailRow label="Calls" value={session.calls} />
        <DetailRow label="Input / output" value={`${count(session.inputTokens)} / ${count(session.outputTokens)}`} />
        <DetailRow label="Cache read / write" value={`${count(session.cacheReadTokens)} / ${count(session.cacheWriteTokens)}`} />
        <DetailRow label="Total tokens" value={count(session.totalTokens)} />
        <DetailRow label="Recorded cost" value={money(session.cost)} />
        <DetailRow label="Market value" value={money(session.marketCost)} />
        <DetailRow label="Duration" value={duration(session.durationMs)} />
        <DetailRow label="Started" value={date(session.startedAt)} />
      </dl>
      <h3>Model steps</h3>
      <div className="table-wrap sample-step-table"><table><thead><tr><th>Model</th><th>Status</th><th>Input / output</th><th>Cache read</th><th>Cost</th><th>Duration</th></tr></thead><tbody>{session.steps.map(step => <tr key={step.id}><td>{step.model}<small>{step.provider}</small></td><td><Status value={step.status} /></td><td>{count(step.inputTokens)} / {count(step.outputTokens)}</td><td>{count(step.cacheReadTokens)}</td><td>{money(step.cost)}</td><td>{duration(step.durationMs)}</td></tr>)}</tbody></table></div>
    </>
  );
}

function AccountDetail({ account }: { account: SampleAccountRow }) {
  return (
    <>
      <h2>{account.label}</h2>
      <p className="mono">{account.id}</p>
      <div className="sample-detail-badges"><span className="badge neutral">{account.provider}</span><span className="badge neutral">{account.kind}</span></div>
      <div className="notice"><strong>Fictional identity.</strong><p>{account.note}</p></div>
      <h3>Aggregated sample usage</h3>
      <dl>
        <DetailRow label="Sessions" value={account.sessions} />
        <DetailRow label="Calls" value={account.calls} />
        <DetailRow label="Input tokens" value={count(account.inputTokens)} />
        <DetailRow label="Output tokens" value={count(account.outputTokens)} />
        <DetailRow label="Total tokens" value={count(account.totalTokens)} />
        <DetailRow label="Recorded cost" value={money(account.cost)} />
        <DetailRow label="Market value" value={money(account.marketCost)} />
        <DetailRow label="Last seen" value={date(account.lastSeen)} />
      </dl>
      <p className="footnote">This drawer deliberately contains no token, secret, or credential value. The real dashboard would only show opaque identity metadata.</p>
    </>
  );
}

function MachineDetail({ machine }: { machine: SampleMachineRow }) {
  return (
    <>
      <h2>{machine.label}</h2>
      <p className="mono">{machine.install}</p>
      <div className="sample-detail-badges"><span className="badge neutral">{machine.os}</span><span className="badge neutral">SAMPLE machine</span></div>
      <h3>Runtime inventory</h3>
      <div className="versions"><div><span>OpenCode</span><strong>{machine.runtimes.opencode}</strong></div><div><span>Collector</span><strong>{machine.runtimes.collector}</strong></div><div><span>Installation</span><strong className="mono">{machine.install}</strong></div></div>
      <h3>Filtered sample usage</h3>
      <dl>
        <DetailRow label="Sessions" value={machine.sessions} />
        <DetailRow label="Calls" value={machine.calls} />
        <DetailRow label="Total tokens" value={count(machine.totalTokens)} />
        <DetailRow label="Recorded cost" value={money(machine.cost)} />
        <DetailRow label="Market value" value={money(machine.marketCost)} />
        <DetailRow label="Last seen" value={date(machine.lastSeen)} />
      </dl>
    </>
  );
}

function RequestDetail({ request }: { request: SampleAttempt }) {
  return (
    <>
      <h2>{request.model} attempt</h2>
      <p className="mono">{request.id}</p>
      <div className="sample-detail-badges"><Status value={request.status} /><span className="badge neutral">HTTP {request.httpStatus ?? "—"}</span>{request.retry && <span className="badge completed">Retry</span>}</div>
      <h3>Attempt metadata</h3>
      <dl>
        <DetailRow label="Provider" value={request.provider} />
        <DetailRow label="Machine" value={request.machine} />
        <DetailRow label="Session" value={<span className="mono">{request.sessionId}</span>} />
        <DetailRow label="Usage source" value={request.usageSource} />
        <DetailRow label="First output" value={duration(request.firstOutputMs)} />
        <DetailRow label="Duration" value={duration(request.durationMs)} />
        <DetailRow label="Input / output" value={`${count(request.inputTokens)} / ${count(request.outputTokens)}`} />
        <DetailRow label="Total tokens" value={count(request.totalTokens)} />
        <DetailRow label="Recorded cost" value={money(request.cost)} />
        <DetailRow label="Market value" value={money(request.marketCost)} />
        <DetailRow label="Started" value={date(request.startedAt)} />
      </dl>
      {request.error && <div className="notice"><strong>Sample error classification</strong><p>{request.error}</p></div>}
      <p className="footnote">No request headers, prompt text, response body, or credential is represented by this synthetic record.</p>
    </>
  );
}

function ErrorDetail({ error }: { error: SampleSessionError }) {
  return (
    <>
      <h2>{error.error_type}</h2>
      <p className="mono">{error.error_code}</p>
      <div className="sample-detail-badges"><span className="badge failed">HTTP {error.http_status ?? "—"}</span><span className="badge neutral">{error.source}</span></div>
      <p>{error.explanation}</p>
      <dl>
        <DetailRow label="Provider" value={error.provider} />
        <DetailRow label="Model" value={error.model} />
        <DetailRow label="Occurrences" value={error.occurrences} />
        <DetailRow label="Affected sessions" value={error.sessions} />
        <DetailRow label="Retryable" value={error.retryable} />
        <DetailRow label="Last seen" value={date(error.last_seen)} />
      </dl>
    </>
  );
}

function ToolDetail({ tool }: { tool: SampleTool }) {
  return (
    <>
      <h2>{tool.tool}</h2>
      <p className="mono">{tool.id}</p>
      <div className="sample-detail-badges"><Status value={tool.status} /><span className="badge neutral">{tool.machine}</span></div>
      <dl>
        <DetailRow label="Invocation" value={tool.invocation} />
        <DetailRow label="Session" value={<span className="mono">{tool.sessionId}</span>} />
        <DetailRow label="Arguments" value={`${count(tool.argumentBytes)} bytes`} />
        <DetailRow label="Captured output" value={`${count(tool.outputBytes)} bytes`} />
        <DetailRow label="Duration" value={duration(tool.durationMs)} />
        <DetailRow label="Started" value={date(tool.startedAt)} />
      </dl>
      <p className="footnote">Byte counts are synthetic metadata. No tool arguments or output content is stored in this sample.</p>
    </>
  );
}

function AttachmentDetail({ attachment }: { attachment: SampleAttachment }) {
  return (
    <>
      <h2>{attachment.name}</h2>
      <p className="mono">{attachment.id}</p>
      <div className="sample-detail-badges"><span className="badge neutral">{attachment.mime}</span><span className="badge neutral">{attachment.machine}</span></div>
      <p>{attachment.note}</p>
      <dl>
        <DetailRow label="Session" value={<span className="mono">{attachment.sessionId}</span>} />
        <DetailRow label="Bytes" value={`${count(attachment.bytes)} bytes`} />
        <DetailRow label="Hash reference" value={<span className="mono">{attachment.hash}</span>} />
        <DetailRow label="Created" value={date(attachment.createdAt)} />
      </dl>
      <div className="notice"><strong>Descriptor only.</strong><p>The fictional file bytes are not present. The hash is a synthetic reference, not a downloadable asset.</p></div>
    </>
  );
}
