import { useEffect, useState } from "react";
import { Activity, FlaskConical, ShieldCheck } from "lucide-react";
import { ThemeControl } from "../Theme";
import { LiveDashboard } from "./LiveDashboard";
import { SampleWorkspace, sampleViews, type SampleView } from "./SampleWorkspace";
import "./public.css";

type Mode = "live" | "sample";
const modeFromPath = (): Mode => (location.pathname.replace(/\/+$/, "") === "/public/sample" ? "sample" : "live");

export function PublicApp() {
  const [mode, setMode] = useState<Mode>(modeFromPath);
  const [sampleView, setSampleView] = useState<SampleView>("overview");
  const sampleViewLabel = sampleViews.find(item => item.id === sampleView)?.label ?? "Overview";

  useEffect(() => {
    document.title =
      mode === "sample" ? `${sampleViewLabel} · Synthetic sample · Observatory` : "Public analytics · Observatory";
  }, [mode, sampleViewLabel]);

  useEffect(() => {
    const sync = () => setMode(modeFromPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const change = (next: Mode) => {
    if (next === mode) return;
    history.pushState(null, "", next === "sample" ? "/public/sample" : "/public");
    setMode(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseSampleView = (next: SampleView) => {
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
