import { useEffect, useState } from "react";
export function AccountAssignments({ dimensions, request, onSave }: any) {
  const [rows, setRows] = useState<any[]>([]), [provider, setProvider] = useState(""), [installationId, setInstallation] = useState(""), [label, setLabel] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState(""), [error, setError] = useState("");
  const load = () => request("/api/account-assignments").then(setRows).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const installations = [...new Map(dimensions.map((d: any) => [d.installation_id, d.machine])).entries()] as [string, string][];
  const knownAccounts = [...new Set<string>(dimensions.map((d: any) => d.account_label).filter((l: string) => l && !l.includes("unassigned") && !l.includes("unavailable") && !l.includes("Account ")))].sort();
  return <section className="panel settings-panel"><h2>Assign historical usage to an account</h2><p>Imported sessions do not contain the original account/key identity. This explicit assignment applies only to unattributed records in the selected provider, installation and timeframe; it never creates a provider API-key identity. Reusing the same provider and label groups multiple rules into one assigned account.</p>
    {knownAccounts.length > 0 && <div className="quick-suggestions" style={{marginBottom:14,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:11}}>
      <span style={{color:"var(--muted)"}}>Known accounts:</span>
      {knownAccounts.map(acc => <button key={acc} type="button" className="text-button" style={{textDecoration:"underline",padding:"2px 6px"}} onClick={() => { setLabel(acc); if (!provider && dimensions.find((d: any) => d.account_label === acc)?.provider) setProvider(dimensions.find((d: any) => d.account_label === acc).provider); }}>{acc}</button>)}
    </div>}
    <form className="inline-form assignment-form" onSubmit={async e => { e.preventDefault(); try { await request("/api/account-assignments", { provider, installationId: installationId || null, label, from: from ? new Date(from).getTime() : 0, to: to ? new Date(to).getTime() : null }); setError(""); load(); onSave(); } catch (e: any) { setError(e.message); } }}>
      <label>Provider<select required value={provider} onChange={e => setProvider(e.target.value)}><option value="">Select provider</option>{[...new Set<string>(dimensions.map((d: any) => d.provider).filter(Boolean))].sort().map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Installation<select value={installationId} onChange={e => setInstallation(e.target.value)}><option value="">All installations</option>{installations.map(([id, machine]) => <option key={id} value={id}>{machine}</option>)}</select></label>
      <label>Account label<input required list="known-accounts" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} placeholder="e.g. your email or personal account"/></label>
      <datalist id="known-accounts">{knownAccounts.map(acc => <option key={acc} value={acc}/>)}</datalist>
      <label>From (optional, local)<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)}/></label><label>Until (exclusive, local)<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)}/></label><button className="button">Save assignment</button>
    </form>{error && <p role="alert">{error}</p>}
    {rows.map(row => <div className="assignment-row" key={row.id}><span>{row.provider} · {row.label}<small>Explicit assignment · {row.installation_id ? "one installation" : "all installations"} · {Number(row.from_time) ? new Date(Number(row.from_time)).toLocaleString() : "all history"} → {row.to_time ? new Date(Number(row.to_time)).toLocaleString() : "ongoing"}</small></span><button className="text-button danger" onClick={async () => { try { await request(`/api/account-assignments/${row.id}`, undefined, "DELETE"); load(); onSave(); } catch (e: any) { setError(e.message); } }}>Remove</button></div>)}
  </section>;
}
