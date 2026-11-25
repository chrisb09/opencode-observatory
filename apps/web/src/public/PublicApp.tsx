import { useEffect, useState } from "react";
import { Activity, FlaskConical, ShieldCheck } from "lucide-react";
import { ThemeControl } from "../Theme";
import { LiveDashboard } from "./LiveDashboard";
import { SampleWorkspace, sampleViews, type SampleView } from "./SampleWorkspace";
import "./public.css";

type Mode = "live" | "sample";
const validSampleViews = new Set<SampleView>(sampleViews.map(item => item.id));
const routeFromPath = (): { mode: Mode; sampleView: SampleView } => {
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/public/sample") return { mode: "sample", sampleView: "overview" };
  if (path.startsWith("/public/sample/")) {
    const view = path.slice("/public/sample/".length) as SampleView;
    return { mode: "sample", sampleView: validSampleViews.has(view) ? view : "overview" };
  }
  return { mode: "live", sampleView: "overview" };
};

export function PublicApp() {
  const initialRoute = routeFromPath();
  const [mode, setMode] = useState<Mode>(initialRoute.mode);
  const [sampleView, setSampleView] = useState<SampleView>(initialRoute.sampleView);
  const sampleViewLabel = sampleViews.find(item => item.id === sampleView)?.label ?? "Overview";

  useEffect(() => {
    document.title =
      mode === "sample" ? `${sampleViewLabel} · Synthetic sample · Observatory` : "Public analytics · Observatory";
  }, [mode, sampleViewLabel]);

  useEffect(() => {
    const sync = () => {
      const next = routeFromPath();
      setMode(next.mode);
      if (next.mode === "sample") setSampleView(next.sampleView);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const change = (next: Mode) => {
    if (next === mode) return;
    const target = next === "sample" ? (sampleView === "overview" ? "/public/sample" : `/public/sample/${sampleView}`) : "/public";
    history.pushState(null, "", target);
    setMode(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseSampleView = (next: SampleView) => {
    if (next !== sampleView) {
      const target = next === "overview" ? "/public/sample" : `/public/sample/${next}`;
      history.pushState(null, "", `${target}${location.search}`);
    }
    setSampleView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={`app public-shell public-mode-${mode}`}>
      <aside className="sidebar public-sidebar">
        <a
          className="brand"
          href="/public"
          onClick={event => {
            event.preventDefault();
            change("live");
          }}
        >
          <div className="brand-icon">
            <img src="/logo.png" alt="Observatory logo" />
          </div>
          <div>
            Observatory
            <small>OPENCODE ANALYTICS</small>
          </div>
        </a>

        <div className="nav-label">WORKSPACE</div>
        <nav className="public-mode-nav" aria-label="Public data mode">
          <button className={`mode-live ${mode === "live" ? "active" : ""}`} aria-pressed={mode === "live"} onClick={() => change("live")}>
            <Activity size={18} /> Live aggregate
            {mode === "live" && <span className="nav-dot" />}
          </button>
          <button className={`mode-sample ${mode === "sample" ? "active" : ""}`} aria-pressed={mode === "sample"} onClick={() => change("sample")}>
            <FlaskConical size={18} /> Synthetic sample
            {mode === "sample" && <span className="nav-dot" />}
          </button>
        </nav>

        {mode === "sample" && (
          <>
            <div className="nav-label public-nav-label">SAMPLE VIEWS</div>
            <nav className="public-sample-nav" aria-label="Synthetic sample sections">
              {sampleViews.map(item => (
                <button
                  key={item.id}
                  className={sampleView === item.id ? "active" : ""}
                  aria-current={sampleView === item.id ? "page" : undefined}
                  onClick={() => chooseSampleView(item.id)}
                >
                  <item.icon size={18} />
                  {item.label}
                  {sampleView === item.id && <span className="nav-dot" />}
                </button>
              ))}
            </nav>
          </>
        )}

        <div className="sidebar-bottom">
          <span className={`connection public-connection ${mode}`}>
            <i />
            {mode === "live" ? "Live · aggregate only" : "Synthetic · fictional data"}
          </span>
          <p className={`public-sidebar-note ${mode}`}>
            {mode === "live"
              ? "Allowlisted model and provider totals. No accounts, credentials, machines, sessions, prompts, or exports."
              : "Read-only demonstration. Nothing is sent, saved, or connected to live analytics."}
          </p>
        </div>
      </aside>

      <main className="public-main">
        <header>
          <div className="header-title">
            <h1>{mode === "sample" ? sampleViewLabel : "Overview"}</h1>
            <div className="breadcrumb">
              Public analytics <span>/</span> {mode === "sample" ? "Synthetic sample" : "Overview"}
            </div>
          </div>
          <div className="header-controls">
            {mode === "live" && <div className="public-header-note">
              A limited selection of my actual usage.{" "}
              <a href="/public/sample" onClick={event => { event.preventDefault(); change("sample"); }}>
                Explore the fuller dashboard with synthetic data
              </a>.
            </div>}
            <div className={`live public-mode-status ${mode}`}>
              {mode === "live" ? (
                <>
                  <ShieldCheck size={14} /> Aggregate only
                </>
              ) : (
                <>
                  <FlaskConical size={14} /> Synthetic data
                </>
              )}
            </div>
            <ThemeControl />
          </div>
        </header>

        {mode === "live" ? <LiveDashboard onOpenSample={() => change("sample")} /> : <SampleWorkspace view={sampleView} />}

        <footer className="public-footer">
          <span>OpenCode Observatory · public analytics</span>
          <span>
            {mode === "live"
              ? "Allowlisted aggregates only · account, credential, and machine identities are never exposed."
              : "Synthetic sample workspace · every name and number is fictional and read-only."}
          </span>
        </footer>
      </main>
    </div>
  );
}
