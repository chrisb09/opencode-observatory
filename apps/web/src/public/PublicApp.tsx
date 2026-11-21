import { useEffect, useState } from "react";
import { Activity, FlaskConical, LockKeyhole, ShieldCheck } from "lucide-react";
import { ThemeControl } from "../Theme";
import { LiveDashboard } from "./LiveDashboard";
import { SampleWorkspace } from "./SampleWorkspace";
import "./public.css";

type Mode = "live" | "sample";
const modeFromPath = (): Mode => (location.pathname.replace(/\/+$/, "") === "/public/sample" ? "sample" : "live");

export function PublicApp() {
  const [mode, setMode] = useState<Mode>(modeFromPath);

  useEffect(() => {
    document.title = mode === "sample" ? "Synthetic sample · Observatory" : "Public analytics · Observatory";
  }, [mode]);

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

  return (
    <div className={`public-shell public-mode-${mode}`}>
      <header className="public-topbar">
        <a
          className="brand public-brand"
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
            <small>PUBLIC ANALYTICS</small>
          </div>
        </a>
        <nav className="public-mode-tabs" aria-label="Public data mode">
          <button className={mode === "live" ? "active" : ""} aria-pressed={mode === "live"} onClick={() => change("live")}>
            <Activity size={15} /> Live aggregate
            <span className="mode-dot live-dot" />
          </button>
          <button className={mode === "sample" ? "active sample-tab" : ""} aria-pressed={mode === "sample"} onClick={() => change("sample")}>
            <FlaskConical size={15} /> Synthetic sample
            <span className="mode-dot sample-dot" />
          </button>
        </nav>
        <div className="public-top-actions">
          <span className={`public-mode-pill ${mode === "live" ? "live" : "sample"}`}>
            {mode === "live" ? <ShieldCheck size={13} /> : <FlaskConical size={13} />}
            {mode === "live" ? "LIVE · AGGREGATE ONLY" : "SAMPLE · FICTIONAL DATA"}
          </span>
          <ThemeControl />
        </div>
      </header>

      <div className={`public-boundary ${mode === "live" ? "live" : "sample"}`} role="note">
        {mode === "live" ? (
          <>
            <ShieldCheck size={15} />
            <strong>LIVE PUBLIC VIEW</strong>
            <span>Allowlisted aggregates only · no sign-in, accounts, credentials, machines, sessions, prompts, or exports.</span>
          </>
        ) : (
          <>
            <FlaskConical size={15} />
            <strong>SYNTHETIC SAMPLE WORKSPACE</strong>
            <span>Fictional demonstration data · read-only · never fetched from, mixed with, or written to live analytics.</span>
          </>
        )}
        <span className="public-boundary-lock">
          <LockKeyhole size={12} /> Credentials omitted
        </span>
      </div>

      <main className="public-main">{mode === "live" ? <LiveDashboard onOpenSample={() => change("sample")} /> : <SampleWorkspace />}</main>

      <footer className="public-footer">
        <span>OpenCode Observatory · public analytics</span>
        <span>
          {mode === "live"
            ? "Live aggregate view. Account, credential, and machine identities are never part of this route."
            : "Synthetic sample workspace. Every name and number is fictional."}
        </span>
      </footer>
    </div>
  );
}
