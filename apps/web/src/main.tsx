import React,{useState,useEffect,useCallback,useMemo} from "react";
import {createRoot} from "react-dom/client";
import {XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,BarChart,Bar} from "recharts";
import {Activity,ArrowUpRight,Boxes,ChartNoAxesCombined,Check,ChevronLeft,ChevronRight,Coins,Copy,Download,Filter,KeyRound,Layers,LogOut,Monitor,RefreshCw,Settings,ShieldCheck,Terminal,Users,X,Zap,Paperclip,DollarSign} from "lucide-react";
import "./style.css";
import "./theme.css";
import { UsageChart } from "./UsageChart";
import { ActivityChart } from "./ActivityChart";
import { groupColors } from "./colors";
import { usageMetrics, type UsageMetric } from "./chartMetrics";
import { providerGroup } from "@observatory/contracts";
import { AccountAssignments } from "./AccountAssignments";
import { money, chartTooltipStyle } from "./format";
import { ThemeControl } from "./Theme";
import { DistributionChart } from "./DistributionChart";

type User={id:string;email:string;admin:boolean};
type Entity={entity_id:string;installation_id:string;machine:string;session_id:string;message_id:string;observed_at:string;historical:boolean;runtime:any;data:any;alias?:string};

const n=(v:any)=>v==null?"—":Intl.NumberFormat("en",{notation:Number(v)>10000?"compact":"standard",maximumFractionDigits:1}).format(Number(v));
const ms=(v:any)=>v==null?"—":Number(v)>1000?`${(Number(v)/1000).toFixed(1)}s`:`${Math.round(Number(v))}ms`;
const date=(v:any)=>new Date(Number(v)).toLocaleString();
const short=(v:any)=>v?String(v).replace("hmac:","").slice(0,14):"Unknown";
const percent=(v:any)=>v==null?"—":`${(Number(v)*100).toFixed(1)}%`;
const clientCache=new Map<string,{expires:number,value:Promise<any>}>();
function clearClientCache(){clientCache.clear();}

async function request(path:string,body?:unknown,method?:string,signal?:AbortSignal){
  const cacheable=body===undefined&&!method&&(path.startsWith("/api/analytics?")||path==="/api/dimensions");
  const run=async()=>{const response=await fetch(path,{credentials:"same-origin",method:method??(body===undefined?"GET":"POST"),headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:cacheable?undefined:signal});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error??"Request failed"),{status:response.status});return value;};
  let value:Promise<any>;
  const hit=clientCache.get(path);
  if(cacheable&&hit&&hit.expires>Date.now())value=hit.value;
  else{value=run();if(cacheable){if(clientCache.size>64)clientCache.delete(clientCache.keys().next().value!);clientCache.set(path,{expires:Date.now()+10000,value});value.catch(()=>clientCache.delete(path));}}
  const result=await value;if(body!==undefined||method==="DELETE")clearClientCache();if(signal?.aborted)throw new DOMException("Aborted","AbortError");return result;
}

const views=[
  {id:"overview",name:"Overview",icon:ChartNoAxesCombined},
  {id:"models",name:"Models & providers",icon:Boxes},
  {id:"accounts",name:"Accounts & keys",icon:Users},
  {id:"sessions",name:"Sessions",icon:Layers},
  {id:"requests",name:"Request attempts",icon:Activity},
  {id:"errors",name:"Error breakdown",icon:Zap},
  {id:"tools",name:"Tool executions",icon:Terminal},
  {id:"attachments",name:"Attachments",icon:Paperclip},
  {id:"machines",name:"Machines",icon:Monitor},
  {id:"settings",name:"Settings",icon:Settings}
];

function useSortable<T>(items:T[],defaultKey="",defaultDir:"asc"|"desc"="desc"){
  const[key,setKey]=useState<string>(defaultKey),[dir,setDir]=useState<"asc"|"desc">(defaultDir);
  const onSort=(newKey:string)=>{
    if(key===newKey)setDir(d=>d==="asc"?"desc":"asc");
    else{setKey(newKey);setDir("desc");}
  };
  const sorted=useMemo(()=>{
    if(!key)return items;
    return[...items].sort((a:any,b:any)=>{
      const getVal=(x:any)=>{
        if(!x)return null;
        if(key in x)return x[key];
        if(x.data&&key in x.data)return x.data[key];
        return null;
      };
      let va=getVal(a),vb=getVal(b);
      if(typeof va==="string"&&!isNaN(Number(va))&&va.trim()!=="")va=Number(va);
      if(typeof vb==="string"&&!isNaN(Number(vb))&&vb.trim()!=="")vb=Number(vb);
      if(va==null&&vb==null)return 0;
      if(va==null)return 1;
      if(vb==null)return -1;
      if(typeof va==="number"&&typeof vb==="number")return dir==="asc"?va-vb:vb-va;
      return dir==="asc"?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
    });
  },[items,key,dir]);
  return {sorted,key,dir,onSort};
}

function Th({label,sortKey,currentKey,dir,onSort,width,align="left"}:any){
  const active=currentKey===sortKey;
  return (
    <th tabIndex={0} aria-sort={active?dir==="asc"?"ascending":"descending":"none"} style={{cursor:"pointer",userSelect:"none",width,textAlign:align}} onClick={()=>onSort(sortKey)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSort(sortKey);}}} title={`Sort by ${label}`}>
      <span style={{display:"inline-flex",alignItems:"center",gap:5,justifyContent:align==="right"?"flex-end":"flex-start"}}>
        {label}
        <span style={{opacity:active?1:0.25,fontSize:10,color:active?"var(--purple)":"inherit"}}>
          {active?(dir==="asc"?"▲":"▼"):"⇅"}
        </span>
      </span>
    </th>
  );
}

function App(){
  const[user,setUser]=useState<User|null>(null),[checking,setChecking]=useState(true),[view,setView]=useState("overview"),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const[range,setRange]=useState("7"),[provider,setProvider]=useState(""),[model,setModel]=useState(""),[account,setAccount]=useState(""),[credential,setCredential]=useState(""),[machine,setMachine]=useState(""),[status,setStatus]=useState(""),[customFrom,setCustomFrom]=useState(""),[customTo,setCustomTo]=useState("");
  const[accountGrouping,setAccountGrouping]=useState<"provider"|"account"|"credential">("account");
  const[modelGrouping,setModelGrouping]=useState<"model"|"provider">("model"),[metric,setMetric]=useState<UsageMetric>("total_tokens");
  const[machineInventory,setMachineInventory]=useState<any[]>([]);
  const grouping=view==="accounts"?accountGrouping:view==="machines"?"machine":view==="models"?modelGrouping:"model";
  const[serverSort,setServerSort]=useState({key:"observed_at",dir:"desc" as "asc"|"desc"});
  const[dimensions,setDimensions]=useState<any[]>([]),[stats,setStats]=useState<any>(null),[rows,setRows]=useState<Entity[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(0),[tick,setTick]=useState(0),[selected,setSelected]=useState<Entity|null>(null),[session,setSession]=useState<Entity|null>(null);
  const[loadedAt,setLoadedAt]=useState<number|null>(null),[listingStats,setListingStats]=useState<any>(null);

  useEffect(()=>{request("/api/auth/me").then(setUser).catch(()=>{}).finally(()=>setChecking(false));},[]);
  useEffect(()=>{if(user)request("/api/dimensions").then(setDimensions).catch(e=>setError(e.message));},[user,tick]);

  const timeframe=useMemo(()=>{const to=Date.now();return range==="custom"?{from:customFrom?new Date(customFrom).getTime():undefined,to:customTo?new Date(customTo).getTime():to}:range==="all"?{from:undefined,to}:{from:to-Number(range)*86400000,to};},[range,customFrom,customTo,tick]);
  const query=useCallback((listing=true)=>{
    const q=new URLSearchParams({groupBy:grouping});
    if(listing){q.set("limit","50");q.set("offset",String(page*50));q.set("sortBy",serverSort.key);q.set("sortDir",serverSort.dir);}
    if(timeframe.from!==undefined)q.set("from",String(timeframe.from));q.set("to",String(timeframe.to));
    for(const[k,v]of Object.entries({provider,model,account,credential,machine,status}))if(v)q.set(k,v);
    if(session){q.set("sessionId",session.entity_id);q.set("installationId",session.installation_id);}
    return q;
  },[timeframe,provider,model,account,credential,machine,status,page,session,serverSort,grouping]);

  useEffect(()=>{
    if(!user||view==="settings")return;const abort=new AbortController();setBusy(true);setError("");
    const q=query(!["overview","models","accounts","machines"].includes(view));let work:Promise<any>;
    if(["overview","models","accounts"].includes(view))work=request(`/api/analytics?${q}`,undefined,undefined,abort.signal).then(setStats);
    else if(view==="machines")work=Promise.all([request(`/api/analytics?${q}`,undefined,undefined,abort.signal),request("/api/machines",undefined,undefined,abort.signal)]).then(([analytics,inventory])=>{setStats(analytics);setMachineInventory(inventory);});
    else if(view==="errors")work=request(`/api/errors?${q}`,undefined,undefined,abort.signal).then(value=>{setRows(value.items);setTotal(value.total);setListingStats(value.summary);});
    else {const kind=session?"step":({sessions:"session",requests:"attempt",tools:"tool",attachments:"attachment"} as any)[view];work=request(`/api/entities/${kind}?${q}`,undefined,undefined,abort.signal).then(value=>{setRows(value.items);setTotal(value.total);setListingStats(value.summary??null);});}
    work.then(()=>setLoadedAt(Date.now())).catch(e=>{if(e.name!=="AbortError"){setError(e.message);if(e.status===401)setUser(null);}}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});
    return()=>abort.abort();
  },[user,view,query,tick,session]);

  const navigate=(id:string)=>{setView(id);setPage(0);setSession(null);setSelected(null);setListingStats(null);setStatus("");setError("");setServerSort({key:id==="errors"?"occurrences":"observed_at",dir:"desc"});window.scrollTo({top:0});};
  const reset=()=>{setProvider("");setModel("");setAccount("");setCredential("");setMachine("");setStatus("");setPage(0);};
  const refresh=()=>{clearClientCache();setTick(x=>x+1);};
  const logout=async()=>{await request("/api/auth/logout",{});clearClientCache();setUser(null);setStats(null);setRows([]);setSelected(null);setDimensions([]);setMachineInventory([]);};

  const groups=stats?({model:stats.modelGroups,provider:stats.providerGroups,account:stats.accountGroups,credential:stats.credentialGroups,machine:stats.machineGroups} as any)[grouping]??[]:[];
  const modelUniverse=useMemo(()=>dimensions.map(d=>({id:`${d.provider}/${d.model}`,label:d.model,provider:providerGroup(d.provider,d.model??"")})),[dimensions]);
  const colors=useMemo(()=>groupColors(groups,grouping,["model","provider"].includes(grouping)?[...modelUniverse,...groups]:groups),[groups,grouping,modelUniverse]);
  const machineData=useMemo(()=>{
    const names=new Set<string>(groups.map((g:any)=>g.id));
    if(!(provider||model||account||credential))for(const item of machineInventory)if(!machine||item.machine===machine)names.add(item.machine);
    return [...names].map(name=>{
      const inventories=machineInventory.filter(i=>i.machine===name);
      return {id:name,label:name,calls:0,total_tokens:0,cost:0,market_cost:0,...groups.find((g:any)=>g.id===name),inventories,last_seen:inventories.length?Math.max(...inventories.map(i=>Number(i.last_seen))):null};
    });
  },[groups,machineInventory,provider,model,account,credential,machine]);
  const machinesSort=useSortable(machineData,"calls","desc");
  const groupsSort=useSortable(groups,"calls","desc");
  const rowsSort={sorted:rows,key:serverSort.key,dir:serverSort.dir,onSort:(key:string)=>{setServerSort(old=>({key,dir:old.key===key&&old.dir==="desc"?"asc":"desc"}));setPage(0);}};

  if(checking)return <div className="auth"><div className="brand"><Activity/> Observatory</div><p>Connecting to your observatory…</p></div>;
  if(!user)return <Login onLogin={setUser}/>;
  const current=views.find(v=>v.id===view)!;
  const options=(field:string)=>[...new Set(dimensions.map(x=>field==="provider"?providerGroup(x.provider,x.model??""):x[field]).filter(Boolean))].sort() as string[];
  const select=(label:string,value:string,set:(v:string)=>void,values:string[])=> <label className="filter"><span>{label}</span><select value={value} onChange={e=>{set(e.target.value);setPage(0);}}><option value="">All {label.toLowerCase()}</option>{values.map(v=><option key={v} value={v}>{label==="Accounts"?short(v):v}</option>)}</select></label>;
  const identitySelect=(field:"account"|"credential")=>{
    const entries=new Map<string,string>();for(const d of dimensions){if(!d.provider||(provider&&providerGroup(d.provider,d.model??"")!==provider))continue;const id=`${d.provider}/${d[field]??(field==="credential"&&d.authType==="oauth"?"oauth":"unassigned")}`;entries.set(id,`${d.provider} · ${d[`${field}_label`]??"Unavailable"}`);}
    return <label className="filter"><span>{field==="account"?"Accounts":"Provider keys"}</span><select value={field==="account"?account:credential} onChange={e=>{(field==="account"?setAccount:setCredential)(e.target.value);setPage(0);}}><option value="">All {field==="account"?"accounts":"provider keys"}</option>{[...entries].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>;
  };

  return <div className="app">
    <aside className="sidebar"><a className="brand" href="/" onClick={e=>{e.preventDefault();navigate("overview");}}><div className="brand-icon"><img src="/logo.png" alt="Observatory logo"/></div><div>Observatory<small>OPENCODE ANALYTICS</small></div></a>
      <div className="nav-label">WORKSPACE</div><nav>{views.map(v=><button key={v.id} className={view===v.id?"active":""} onClick={()=>navigate(v.id)}><v.icon size={18}/>{v.name}{view===v.id&&<span className="nav-dot"/>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="connection"><i/> Private workspace</span><div className="profile"><div className="avatar">{user.email[0]?.toUpperCase()}</div><div><strong>{user.email}</strong><small>{user.admin?"Administrator":"Member"}</small></div><button className="icon" aria-label="Sign out" onClick={()=>void logout()}><LogOut size={16}/></button></div></div>
    </aside>
    <main>
      <header>
        <div className="header-title">
          <h1>{session ? "Session explorer" : current.name}</h1>
          <div className="breadcrumb">Your workspace <span>/</span> {session ? `${short(session.entity_id)} · ${session.machine}` : current.name}</div>
        </div>
        <div className="header-controls">
          {view !== "settings" && <button className="button subtle" onClick={refresh} disabled={busy}><RefreshCw size={14} className={busy ? "spin" : ""}/>Refresh</button>}
          {!["overview","models","accounts","machines"].includes(view) && <a className="button subtle" href={`/api/export/${session?"step":({sessions:"session",requests:"attempt",errors:"error",tools:"tool",attachments:"attachment"} as any)[view]}?${query()}`}><Download size={14}/>Export</a>}
          <div className="live"><ShieldCheck size={14}/> Metadata only</div>
          <ThemeControl/>
        </div>
      </header>
      {view!=="settings"&&<section className="filters"><Filter size={16}/><label className="filter"><span>Timeframe</span><select value={range} onChange={e=>{setRange(e.target.value);setPage(0);}}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option><option value="custom">Custom range</option></select></label>
        {range==="custom"&&<><label className="filter"><span>From (local)</span><input type="datetime-local" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}/></label><label className="filter"><span>To (exclusive)</span><input type="datetime-local" value={customTo} onChange={e=>setCustomTo(e.target.value)}/></label></>}
        {select("Providers",provider,setProvider,options("provider"))}{select("Models",model,setModel,options("model"))}{select("Machines",machine,setMachine,options("machine"))}
        {identitySelect("account")}{identitySelect("credential")}
        {(account||credential)&&<span className="badge neutral">{account?"Account":"Provider key"} filter active</span>}
        {view==="requests"&&select("Status",status,setStatus,["running","completed","failed","cancelled"])}<button className="text-button" onClick={reset}>Reset</button></section>}
      {error&&<div className="error" role="alert">{error}<button className="text-button" onClick={refresh}>Retry</button></div>}
      {busy&&<div className="loading-line"/>}

      {["overview","models","accounts","machines"].includes(view)&&<div className="analytics-controls">
        {view==="models"&&<div className="control-group"><span>Group by</span><div className="segmented">{(["model","provider"] as const).map(g=><button key={g} aria-pressed={modelGrouping===g} className={modelGrouping===g?"chosen":""} onClick={()=>setModelGrouping(g)}>{g==="model"?"Models":"Providers"}</button>)}</div></div>}
        {view==="accounts"&&<div className="control-group"><span>Group by</span><div className="segmented">{(["account","credential","provider"] as const).map(g=><button key={g} aria-pressed={accountGrouping===g} className={accountGrouping===g?"chosen":""} onClick={()=>setAccountGrouping(g)}>{g==="credential"?"Provider keys":g==="provider"?"Providers":"Accounts"}</button>)}</div></div>}
        <div className="control-group"><span>Measure</span><div className="segmented">{usageMetrics.map(([key,label])=><button key={key} aria-pressed={metric===key} className={metric===key?"chosen":""} onClick={()=>setMetric(key)}>{label}</button>)}</div></div>
      </div>}

      {["overview","models","accounts"].includes(view)&&stats&&<>
        <div className="stats-grid">
          <Stat label="Model calls" value={n(stats.summary.calls)} hint={`${n(stats.transport.attempts)} observed HTTP attempts`} icon={Zap}/>
          <Stat label="Input tokens" value={n(stats.summary.input_tokens)} hint={`${n(stats.summary.cache_read_tokens)} cache-read tokens`} icon={ArrowUpRight}/>
          <Stat label="Output tokens" value={n(stats.summary.output_tokens)} hint={`${n(stats.summary.reasoning_tokens)} reasoning tokens (separate)`} icon={Layers}/>
          <Stat label="Total tokens" value={n(stats.summary.total_tokens)} hint={`${n(stats.summary.unknown_usage_calls)} incomplete calls · includes cache + reasoning`} icon={Activity}/>
          <Stat label="Recorded cost" value={money(stats.summary.cost)} hint={`${n(stats.summary.unknown_cost_calls)} unavailable · reported or OpenCode estimate`} icon={Coins}/>
          <Stat label="Market value (pseudo-cost)" value={money(stats.summary.market_cost)} hint={`${n(stats.summary.unknown_market_calls)} unpriced calls · subscription fees excluded`} icon={DollarSign}/>
        </div>
        {view==="accounts"&&<div className="coverage-note"><p><strong>{n(stats.summary.account_count)} known accounts · {n(stats.summary.credential_count)} provider API keys.</strong> Imported history did not record its original identities. OAuth accounts have no provider API key. Unknown history is kept separate; use aliases and explicit assignments below.</p></div>}
        {stats.groupBy===grouping&&<div className="charts-grid"><UsageChart key={`${view}/${grouping}`} stats={stats} metric={metric} groups={groups} colors={colors} grouped={view!=="overview"} groupLabel={grouping==="credential"?"provider keys":`${grouping}s`}/><ActivityChart groups={groups} metric={metric} colors={colors} title={grouping==="provider"?"Provider activity":grouping==="account"?"Account activity":grouping==="credential"?"Provider key activity":"Model activity"}/></div>}
        <section className="panel reuse-panel"><div className="panel-title"><div><h2>Context reuse</h2><p>Provider-reported prompt caching · token-weighted, separate from context-window utilization</p></div><RefreshCw size={18}/></div><div className="reuse-metrics"><Mini label="Cached share of measured prompt tokens" value={percent(stats.summary.cache_reuse_ratio)}/><Mini label="Measured calls with cache hits" value={percent(stats.summary.cache_hit_ratio)}/><Mini label="Cache read / write tokens" value={`${n(stats.summary.cache_read_tokens)} / ${n(stats.summary.cache_write_tokens)}`}/><Mini label="Estimated cache-read API reduction" value={money(stats.summary.cache_savings)}/></div><div className="chart"><ResponsiveContainer width="100%" height={150}><BarChart data={stats.series}><XAxis dataKey="time" hide/><YAxis tickFormatter={n} width={60} tick={{fill:"var(--muted)",fontSize:10}}/><Tooltip cursor={false} contentStyle={chartTooltipStyle} labelStyle={{color:"var(--text)"}} labelFormatter={v=>new Date(Number(v)).toLocaleString()} formatter={n}/><Bar dataKey="input_tokens" name="Uncached input" stackId="prompt" fill="var(--purple)" isAnimationActive={false}/><Bar dataKey="cache_read_tokens" name="Cache reads" stackId="prompt" fill="var(--cache-read)" isAnimationActive={false}/><Bar dataKey="cache_write_tokens" name="Cache writes" stackId="prompt" fill="var(--cache-write)" isAnimationActive={false}/></BarChart></ResponsiveContainer></div><p className="chart-caption">Cache information available for {n(stats.summary.known_cache_calls)} of {n(stats.summary.calls)} calls. Estimated reductions use matching API rates, not subscription invoices.</p></section>
        <div className="charts-grid distribution-grid"><section className="panel"><div className="panel-title"><div><h2>Generated output lengths</h2><p>Adaptive token ranges · explicit outlier tail when needed</p></div><Layers size={18}/></div>{stats.outputDistribution?.length?<div className="chart"><DistributionChart data={stats.outputDistribution}/></div>:<Empty/>}</section>
          <section className="panel"><div className="panel-title"><div><h2>Context utilization</h2><p>Observed provider attempts · cached tokens included where measurable</p></div><Activity size={18}/></div>{stats.contextDistribution?.length?<div className="chart"><DistributionChart data={stats.contextDistribution} valueKey="attempts" name="HTTP attempts" color="var(--purple)"/><p className="chart-caption">Median utilization {percent(stats.contextPercentiles?.p50_ratio)} · p95 {percent(stats.contextPercentiles?.p95_ratio)}. Values use the request model's configured context limit.</p></div>:<div className="empty compact"><Activity size={25}/><p>No context limits and usage captured yet.<br/>Connect an instance with request transport coverage.</p></div>}</section></div>
        <div className="health-grid">
          <Mini label="Median / p95 lifecycle duration" value={`${ms(stats.summary.p50_ms)} / ${ms(stats.summary.p95_ms)}`}/>
          <Mini label="Median / p95 output tokens" value={`${n(stats.summary.p50_output_tokens)} / ${n(stats.summary.p95_output_tokens)}`}/>
          <Mini label="Median first streamed output" value={ms(stats.transport.first_output_ms)}/>
          <Mini label="Context p50 / p95" value={`${stats.contextPercentiles?.p50_ratio==null?"—":`${(Number(stats.contextPercentiles.p50_ratio)*100).toFixed(0)}%`} / ${stats.contextPercentiles?.p95_ratio==null?"—":`${(Number(stats.contextPercentiles.p95_ratio)*100).toFixed(0)}%`}`}/>
          <Mini label="Failed HTTP attempts" value={`${n(stats.transport.failed)} / ${n(stats.transport.attempts)}`}/>
          <Mini label="Imported model calls" value={n(stats.summary.imported_calls)}/>
        </div>
        <section className="panel"><div className="panel-title"><div><h2>{grouping==="provider"?"Provider breakdown":view==="accounts"?"Account breakdown":"Model breakdown"}</h2><p>{view==="accounts"?"Provider totals → accounts → provider credentials · identities are distinct from upload keys":"Click headers to sort · recorded cost vs API-rate equivalent"}</p></div><span className="badge neutral">{groups.length} groups</span></div>
          <div className="table-wrap"><table><thead><tr>
            <Th label={grouping==="provider"?"Provider":view==="accounts"?accountGrouping==="credential"?"Provider key":"Account":"Provider / model"} sortKey="label" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort}/>
            <Th label="Calls" sortKey="calls" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Input" sortKey="input_tokens" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Output" sortKey="output_tokens" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Cache read" sortKey="cache_read_tokens" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Reasoning" sortKey="reasoning_tokens" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Total" sortKey="total_tokens" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Reuse" sortKey="cache_reuse_ratio" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            {view==="accounts"&&<Th label="Accounts / keys" sortKey="account_count" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>}
            <Th label="Cost" sortKey="cost" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
            <Th label="Market rate" sortKey="market_cost" currentKey={groupsSort.key} dir={groupsSort.dir} onSort={groupsSort.onSort} align="right"/>
          </tr></thead><tbody>{groupsSort.sorted.map((x:any)=><tr key={x.id}>
            <td><span className="model-dot" style={{background:colors[x.id]}}/>{view==="accounts"?<button className="table-link" onClick={()=>{if(accountGrouping==="provider"){setProvider(x.id);setAccount("");setCredential("");setAccountGrouping("account");}else if(accountGrouping==="account"){setAccount(x.id);setAccountGrouping("credential");}else{setCredential(x.id);navigate("requests");}}}>{x.label}</button>:x.label}{view==="accounts"&&x.attribution&&<small>{x.attribution==="unassigned"?"Identity unavailable":`${x.attribution} identity`}</small>}{view==="accounts"&&x.credential_kind&&<small>{x.credential_kind==="oauth"?"OAuth · no API key":x.credential_kind==="unavailable"?"Original key not recorded":"Observed API-key fingerprint"}</small>}</td>
            <td style={{textAlign:"right"}}>{n(x.calls)}</td>
            <td style={{textAlign:"right"}}>{n(x.input_tokens)}</td>
            <td style={{textAlign:"right"}}>{n(x.output_tokens)}</td>
            <td style={{textAlign:"right"}}>{n(x.cache_read_tokens)}</td>
            <td style={{textAlign:"right"}}>{n(x.reasoning_tokens)}</td>
            <td style={{textAlign:"right"}} title={`${x.unknown_usage_calls} incomplete calls`}>{n(x.total_tokens)}</td>
            <td style={{textAlign:"right"}}>{percent(x.cache_reuse_ratio)}</td>
            {view==="accounts"&&<td style={{textAlign:"right"}}>{n(x.account_count)} / {n(x.credential_count)}</td>}
            <td style={{textAlign:"right"}}>{money(x.cost)}</td>
            <td style={{textAlign:"right"}}>{money(x.market_cost)}</td>
          </tr>)}</tbody></table>{!groups.length&&<Empty/>}</div>
        </section>
        {view==="accounts"&&<><AliasEditor dimensions={dimensions} onSave={refresh}/><AccountAssignments dimensions={dimensions} request={request} onSave={refresh}/></>}
        <p className="footnote">Total tokens include cached prompt tokens and completion including reasoning, without adding overlapping categories twice. Unknown pricing stays unavailable. Market value excludes subscription fees; recorded cost is reported usage or an OpenCode estimate, not a verified invoice.</p>
      </>}

      {view==="sessions"&&!session&&<section className="panel">
        <div className="panel-title"><div><h2>Sessions</h2><p>{n(total)} sessions recorded · Click column headers to sort or click a row to inspect</p></div><span className="badge neutral">Metadata</span></div>
        <div className="table-wrap"><table><thead><tr>
          <Th label="Session" sortKey="entity_id" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Agent" sortKey="agent" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Models" sortKey="model" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Machine" sortKey="machine" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Status" sortKey="status" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Input / Output" sortKey="inputTokens" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Total" sortKey="totalTokens" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Duration" sortKey="durationMs" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Cost" sortKey="cost" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort} align="right"/>
          <Th label="Market rate" sortKey="marketCost" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort} align="right"/>
          <Th label="Recorded" sortKey="observed_at" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
        </tr></thead><tbody>{rowsSort.sorted.map(row=><tr key={row.installation_id+row.entity_id} className="clickable" tabIndex={0} onClick={()=>setSelected(row)} onKeyDown={e=>{if(e.key==="Enter")setSelected(row);}}>
          <td><strong>{row.data.title||short(row.entity_id)}</strong><small className="mono">{row.entity_id}</small></td>
          <td><span className="badge neutral">{row.data.agents?.length ? row.data.agents.join(", ") : (row.data.agent ?? "—")}</span></td>
          <td>{row.data.models?.length > 1 ? <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{row.data.models.map((m:string)=><span key={m} className="badge neutral" style={{fontSize:9}}>{m}</span>)}</div> : (row.data.models?.[0] ?? row.data.model ?? row.data.provider ?? "—")}</td>
          <td>{row.machine}</td>
          <td><Badge status={row.data.status??"completed"}/></td>
          <td>{row.data.inputTokens!=null?`${n(row.data.inputTokens)} / ${n(row.data.outputTokens)}`:"—"}</td>
          <td>{n(row.data.totalTokens)}</td>
          <td>{ms(row.data.durationMs)}</td>
          <td style={{textAlign:"right"}}>{money(row.data.cost)}</td>
          <td style={{textAlign:"right"}}>{money(row.data.marketCost)}</td>
          <td>{date(row.observed_at)}</td>
        </tr>)}</tbody></table>{!rows.length&&!busy&&<Empty/>}</div>
        <div className="pagination"><span>{Math.min(page*50+1,total)}–{Math.min((page+1)*50,total)} of {total}</span><div><button className="icon" aria-label="Previous page" disabled={page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={18}/></button><button className="icon" aria-label="Next page" disabled={(page+1)*50>=total} onClick={()=>setPage(page+1)}><ChevronRight size={18}/></button></div></div>
      </section>}

      {view==="requests"&&listingStats&&<><div className="health-grid"><Mini label="Observed HTTP attempts" value={n(listingStats.attempts)}/><Mini label="Completed / running" value={`${n(listingStats.completed)} / ${n(listingStats.running)}`}/><Mini label="Failed / cancelled" value={`${n(listingStats.failed)} / ${n(listingStats.cancelled)}`}/><Mini label="Median / p95 duration" value={`${ms(listingStats.p50_ms)} / ${ms(listingStats.p95_ms)}`}/><Mini label="Median first output" value={ms(listingStats.first_output_ms)}/><Mini label="Measured token usage" value={`${n(listingStats.known_usage)} / ${n(listingStats.attempts)} attempts`}/></div><div className="coverage-note"><p>These are observed HTTP attempts, including retries. Historical imports contain model calls, not individual HTTP attempts. Usage comes from provider counters or uniquely matched lifecycle steps, labeled in Source. Missing and ambiguous measurements stay unavailable.</p></div></>}
      {(["requests","tools","attachments"].includes(view)||session)&&<section className="panel">
        {session&&<button className="button subtle back" onClick={()=>{setSession(null);setPage(0);}}><ChevronLeft size={16}/>All sessions</button>}
        <div className="panel-title"><div><h2>{session?"Model steps":current.name}</h2><p>{n(total)} records · Click column headers to sort or click a row to inspect</p></div><span className="badge neutral">Metadata</span></div>
        <div className="table-wrap"><table><thead><tr>
          <Th label={view==="tools"?"Tool":view==="attachments"?"MIME type":"Model / session"} sortKey={view==="tools"?"tool":view==="attachments"?"mime":"model"} currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Machine" sortKey="machine" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Status" sortKey="status" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          {view==="requests"&&!session&&<th>HTTP</th>}
          <Th label={view==="attachments"?"Size":view==="tools"?"Arguments / output bytes":"Input / output"} sortKey={view==="attachments"?"bytes":view==="tools"?"argumentBytes":"inputTokens"} currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          {(view==="requests"||session)&&<Th label="Total" sortKey="totalTokens" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>}
          <Th label="Duration" sortKey="durationMs" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          {view==="requests"&&!session&&<><th>First output</th><Th label="Cost" sortKey="cost" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/><Th label="Market rate" sortKey="marketCost" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/></>}
          <Th label="Recorded" sortKey="observed_at" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Source" sortKey="coverage" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
        </tr></thead><tbody>{rowsSort.sorted.map(row=><tr key={row.installation_id+row.entity_id} className="clickable" tabIndex={0} onClick={()=>setSelected(row)} onKeyDown={e=>{if(e.key==="Enter")setSelected(row);}}>
          <td><strong>{row.data.tool??row.data.mime??row.data.model??short(row.entity_id)}</strong><small>{row.data.agent ? `${row.data.agent} · ` : ""}{row.data.provider??short(row.session_id)}</small></td>
          <td>{row.machine}</td>
          <td><Badge status={row.data.status??"unknown"}/></td>
          {view==="requests"&&!session&&<td>{row.data.httpStatus??"—"}</td>}
          <td>{view==="attachments"?`${n(row.data.bytes)} bytes`:view==="tools"?`${n(row.data.argumentBytes)} / ${n(row.data.outputBytes)}`:`${n(row.data.inputTokens)} / ${n(row.data.outputTokens)}`}</td>
          {(view==="requests"||session)&&<td>{n(row.data.totalTokens)}</td>}
          <td>{ms(row.data.durationMs)}</td>
          {view==="requests"&&!session&&<><td>{ms(row.data.firstOutputMs)}</td><td>{money(row.data.cost)}</td><td>{money(row.data.marketCost)}</td></>}
          <td>{date(row.observed_at)}</td>
          <td><span className="badge neutral">{row.historical?"Imported":row.data.coverage??"Live"}</span>{view==="requests"&&!session&&<small>{row.data.usageProvenance==="lifecycle-correlated"?"Matched lifecycle usage":row.data.usageSource==="provider"?"Provider usage":row.data.usageSource==="opencode"?"OpenCode usage":"Usage unavailable"}</small>}</td>
        </tr>)}</tbody></table>{!rows.length&&!busy&&<Empty/>}</div>
        <div className="pagination"><span>{Math.min(page*50+1,total)}–{Math.min((page+1)*50,total)} of {total}</span><div><button className="icon" aria-label="Previous page" disabled={page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={18}/></button><button className="icon" aria-label="Next page" disabled={(page+1)*50>=total} onClick={()=>setPage(page+1)}><ChevronRight size={18}/></button></div></div>
      </section>}

      {view==="errors"&&listingStats&&<div className="health-grid"><Mini label="Recorded failures" value={n(listingStats.failed)}/><Mini label="Cancellations" value={n(listingStats.cancelled)}/><Mini label="Retryable failures" value={n(listingStats.retryable)}/><Mini label="Affected sessions" value={n(listingStats.sessions)}/><Mini label="Transport events" value={n(listingStats.transport)}/><Mini label="Imported error events" value={n(listingStats.historical)}/></div>}
      {view==="errors"&&<section className="panel"><div className="panel-title"><div><h2>Recorded errors & cancellations</h2><p>{n(total)} groups · transport, lifecycle and imported errors · message/error copies deduplicated</p></div><span className="badge neutral">Metadata only</span></div>
        <div className="table-wrap"><table><thead><tr>
          <Th label="Error category" sortKey="error_type" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Error code" sortKey="error_code" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="Provider / model" sortKey="provider" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <Th label="HTTP" sortKey="http_status" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
          <th>Source</th>
          <Th label="Occurrences" sortKey="occurrences" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort} align="right"/>
          <Th label="Sessions" sortKey="sessions" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort} align="right"/>
          <Th label="Retryable" sortKey="retryable" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort} align="right"/>
          <Th label="Last seen" sortKey="last_seen" currentKey={rowsSort.key} dir={rowsSort.dir} onSort={rowsSort.onSort}/>
        </tr></thead><tbody>{rowsSort.sorted.map((row:any,index)=><tr key={`${row.error_type}-${row.error_code}-${row.model}-${index}`}>
          <td><strong>{row.error_type}</strong></td>
          <td><small className="mono">{row.error_code}</small></td>
          <td>{row.provider}<small>{row.model}</small></td>
          <td>{row.http_status??"—"}</td>
          <td><span className="badge neutral">{row.source}</span></td>
          <td style={{textAlign:"right"}}>{n(row.occurrences)}</td>
          <td style={{textAlign:"right"}}>{n(row.sessions)}</td>
          <td style={{textAlign:"right"}}>{n(row.retryable)}</td>
          <td>{date(row.last_seen)}</td>
        </tr>)}</tbody></table>{!rows.length&&!busy&&<Empty/>}</div>
        <div className="pagination"><span>{total?Math.min(page*50+1,total):0}–{Math.min((page+1)*50,total)} of {total} groups</span><div><button className="icon" aria-label="Previous page" disabled={page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={18}/></button><button className="icon" aria-label="Next page" disabled={(page+1)*50>=total} onClick={()=>setPage(page+1)}><ChevronRight size={18}/></button></div></div>
      </section>}

      {view==="machines"&&stats?.groupBy==="machine"&&<>
        <div className="charts-grid"><UsageChart key="machines" stats={stats} metric={metric} groups={groups} colors={colors} groupLabel="machines"/><ActivityChart groups={groups} metric={metric} colors={colors} title="Machine activity"/></div>
        <section className="panel machine-table"><div className="panel-title"><div><h2>Machine breakdown</h2><p>Usage in the selected timeframe · expand a machine for installation and runtime details</p></div><span className="badge neutral">{machineData.length} machines</span></div>
          <div className="table-wrap"><table><thead><tr>{[["Machine","label"],["Calls","calls"],["Total tokens","total_tokens"],["Cost","cost"],["Market rate","market_cost"],["Last captured (all time)","last_seen"]].map(([label,key])=><Th key={key} label={label} sortKey={key} currentKey={machinesSort.key} dir={machinesSort.dir} onSort={machinesSort.onSort} align={key==="label"||key==="last_seen"?"left":"right"}/>)}<th>Details</th></tr></thead><tbody>{machinesSort.sorted.map(row=><tr key={row.id}>
            <td><span className="model-dot" style={{background:colors[row.id]??"var(--muted)"}}/><strong>{row.label}</strong></td><td className="numeric">{n(row.calls)}</td><td className="numeric">{n(row.total_tokens)}</td><td className="numeric">{money(row.cost)}</td><td className="numeric">{money(row.market_cost)}</td><td>{row.last_seen?date(row.last_seen):"—"}</td>
            <td><details className="machine-details"><summary>{row.inventories.length} installation{row.inventories.length===1?"":"s"}</summary>{row.inventories.map((item:any)=><div className="machine-installation" key={item.installation_id}><p className="mono">{item.installation_id}</p><p>All-time inventory: {n(item.instances)} instances · {n(item.sessions)} sessions · {n(item.attempts)} HTTP attempts</p><VersionInventory runtime={item.runtime}/></div>)}</details></td>
          </tr>)}</tbody></table>{!machineData.length&&!busy&&<Empty/>}</div>
        </section>
      </>}
      {view==="settings"&&<SettingsPage user={user} onError={setError}/>}
      <footer>OpenCode Observatory <span>{loadedAt?`Updated ${new Date(loadedAt).toLocaleTimeString()}`:"Your private AI usage workspace"}</span></footer>
    </main>

    {selected&&<div className="overlay" onClick={()=>setSelected(null)}><section className="drawer" role="dialog" aria-modal="true" aria-label="Record metadata" onClick={e=>e.stopPropagation()}><button className="icon close" aria-label="Close details" onClick={()=>setSelected(null)}><X/></button><div className="eyebrow">RECORD INSPECTOR</div><h2>{selected.data.title??selected.data.model??selected.data.tool??short(selected.entity_id)}</h2><p className="mono">{selected.entity_id}</p>{view==="sessions"&&!session&&<button className="button primary" onClick={()=>{setSession(selected);setSelected(null);setPage(0);}}>Explore model steps<ArrowUpRight size={16}/></button>}<h3>Metadata</h3><dl>{Object.entries(selected.data).map(([k,v])=><div key={k}><dt>{k.replace(/([A-Z])/g," $1")}</dt><dd>{v==null?"Unavailable":["cost","marketCost","cacheSavings"].includes(k)?money(v):String(v)}</dd></div>)}</dl><h3>Runtime at capture</h3><VersionInventory runtime={selected.runtime}/>{selected.historical&&<div className="notice">Historical request/plugin versions were not recorded by OpenCode. The import-time inventory is not evidence of versions used for these requests.</div>}</section></div>}
  </div>;
}

function Login({onLogin}:{onLogin:(user:User)=>void}){
  const[email,setEmail]=useState(""),[password,setPassword]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[invite,setInvite]=useState(new URLSearchParams(location.search).get("invite"));
  const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{if(invite){await request("/api/auth/accept-invite",{email,password,invite});setInvite(null);history.replaceState({},"","/");}onLogin(await request("/api/auth/login",{email,password}));}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <div className="auth"><div className="auth-theme"><ThemeControl/></div><div className="auth-glow"/><div className="auth-card"><div className="brand"><div className="brand-icon"><img src="/logo.png" alt="Observatory logo"/></div>Observatory</div><div className="eyebrow">YOUR AI WORK, IN FOCUS</div><h1>{invite?"Join your observatory":"Welcome back."}</h1><p>Understand your models, tokens, and costs.<br/>One private workspace. Every machine.</p><form onSubmit={submit}><label>Email<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" required minLength={12} maxLength={256} autoComplete={invite?"new-password":"current-password"} value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<div className="error" role="alert">{error}</div>}<button className="button primary" disabled={busy}>{busy?"Connecting…":invite?"Create account":"Sign in"}<ArrowUpRight size={16}/></button></form><div className="auth-note"><ShieldCheck size={14}/>{invite?"Your invitation is private and single-use.":"Invite-only · Your usage stays yours."}</div></div></div>;
}

function Stat({label,value,hint,icon:Icon}:any){return <section className="stat"><div className="stat-label">{label}<Icon size={17}/></div><strong>{value}</strong><p>{hint}</p></section>;}
function Mini({label,value}:any){return <div className="mini"><span>{label}</span><strong>{value}</strong></div>;}
function Badge({status}:{status:string}){return <span className={`badge ${status}`}><i/>{status}</span>;}
function Empty(){return <div className="empty"><Activity size={30}/><h3>No data in this view yet</h3><p>Connect a client or import past sessions.<br/>Try a wider timeframe if your client is already connected.</p></div>;}
function VersionInventory({runtime}:any){return <div className="versions"><div><span>OpenCode</span><strong>{runtime?.opencode??"Not recorded"}</strong></div><div><span>Collector</span><strong>{runtime?.collector??"Unknown"}</strong></div><div><span>Provenance</span><strong>{runtime?.provenance??"Unknown"}</strong></div>{runtime?.plugins?.map((p:any)=><div key={p.spec}><span title={p.spec}>{p.name}</span><strong>{p.version??"Unknown"}<small>{p.source}</small></strong></div>)}{!runtime?.plugins?.length&&<p>No plugin inventory recorded.</p>}</div>;}
function AliasEditor({dimensions,onSave}:any){
  const[fingerprint,setFingerprint]=useState(""),[alias,setAlias]=useState(""),[message,setMessage]=useState("");
  const identities=new Map<string,string>();for(const d of dimensions)for(const field of ["account","credential"])if(d[field])identities.set(d[field],`${d.provider} · ${d[`${field}_label`]??short(d[field])}`);
  return <section className="panel settings-panel"><h2>Name an account or credential</h2><p>Give an opaque fingerprint a useful label across your machines.</p><form className="inline-form" onSubmit={async e=>{e.preventDefault();try{await request("/api/aliases",{fingerprint,alias});setMessage("Alias saved");onSave();}catch(e:any){setMessage(e.message);}}}><select required value={fingerprint} onChange={e=>setFingerprint(e.target.value)}><option value="">Select fingerprint</option>{[...identities].map(([id,label])=><option value={id} key={id}>{label}</option>)}</select><input required placeholder="Personal / work / team" value={alias} onChange={e=>setAlias(e.target.value)} maxLength={100}/><button className="button">Save alias</button></form>{message&&<p>{message}</p>}</section>;
}

function SettingsPage({user,onError}:{user:User;onError:(e:string)=>void}){
  const[keys,setKeys]=useState<any[]>([]),[key,setKey]=useState(""),[name,setName]=useState(""),[scope,setScope]=useState("both"),[copied,setCopied]=useState(false),[inviteEmail,setInviteEmail]=useState(""),[inviteUrl,setInviteUrl]=useState(""),[reveal,setReveal]=useState<string|null>(null),[password,setPassword]=useState(""),[prices,setPrices]=useState<any[]>([]),[dimensions,setDimensions]=useState<any[]>([]),[price,setPrice]=useState({provider:"",model:"",account:"",input:"",output:"",cacheRead:"0",cacheWrite:"0",effectiveAt:new Date().toISOString().slice(0,10)}),[current,setCurrent]=useState(""),[newPassword,setNewPassword]=useState(""),[notice,setNotice]=useState("");
  const load=()=>{request("/api/keys").then(setKeys).catch(e=>onError(e.message));request("/api/prices").then(setPrices).catch(e=>onError(e.message));request("/api/dimensions").then(setDimensions).catch(e=>onError(e.message));};
  useEffect(load,[]);
  const act=async(fn:()=>Promise<void>)=>{try{onError("");await fn();}catch(e:any){onError(e.message);}};
  const copy=async()=>{try{await navigator.clipboard.writeText(key);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{onError("Clipboard is unavailable; select and copy the key manually.");}};
  return <div className="settings-grid"><section className="panel settings-panel"><div className="panel-title"><div><h2><KeyRound size={18}/> Telemetry API keys</h2><p>Separate from your provider keys. Use one per installation, or share a key across machines.</p></div></div><form className="inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{const value=await request("/api/keys",{name,scopes:scope==="both"?["ingest","read"]:[scope]});setKey(value.key);setName("");load();});}}><input placeholder="Key name" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/><select value={scope} onChange={e=>setScope(e.target.value)}><option value="both">Upload + read statistics</option><option value="ingest">Upload only</option><option value="read">Read only / MCP</option></select><button className="button primary">Create key</button></form>{key&&<div className="secret"><code>{key}</code><button className="icon" aria-label="Copy API key" onClick={()=>void copy()}>{copied?<Check size={16}/>:<Copy size={16}/>}</button><button className="icon" aria-label="Hide API key" onClick={()=>setKey("")}><X size={16}/></button></div>}
      <div className="key-list">{keys.map(k=><div key={k.id}><div><strong>{k.name}</strong><small>{k.scopes.join(" + ")} · {k.last_used_at?`Last used ${new Date(k.last_used_at).toLocaleDateString()}`:"Not used yet"}</small></div>{k.revoked_at?<span className="badge failed">Revoked</span>:<><button className="text-button" onClick={()=>{setReveal(k.id);setPassword("");}}>Reveal</button><button className="text-button danger" onClick={()=>void act(async()=>{await request(`/api/keys/${k.id}`,undefined,"DELETE");setKey("");load();})}>Revoke</button></>}</div>)}</div>
      <div className="notice"><h3>Connect a client</h3><code>bun packages/plugin/dist/cli.js setup</code><p>Enter the server URL and a key with upload scope. Enable historical import during setup or run <code>import</code> later.</p></div>
    </section>
    {user.admin&&<section className="panel settings-panel"><h2><Users size={18}/> Invite a user</h2><p>Invited users get independent, private dashboards. Links expire in seven days.</p><form className="inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{const value=await request("/api/invitations",{email:inviteEmail});setInviteUrl(value.url);});}}><input type="email" required placeholder="person@example.com" value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)}/><button className="button">Create invitation</button></form>{inviteUrl&&<div className="secret"><code>{inviteUrl}</code></div>}</section>}
    <section className="panel settings-panel"><h2><Coins size={18}/> Pricing overrides</h2><p>USD per million tokens. Effective-dated rules update estimates without modifying recorded provider measurements. Unknown cache usage remains unknown when a cache rate is nonzero.</p><form className="price-form" onSubmit={e=>{e.preventDefault();void act(async()=>{const{account,...rates}=price;await request("/api/prices",{...rates,account:account||null,input:Number(price.input),output:Number(price.output),cacheRead:Number(price.cacheRead),cacheWrite:Number(price.cacheWrite),effectiveAt:new Date(price.effectiveAt).getTime()});load();setNotice("Pricing rule saved");});}}>{Object.entries(price).filter(([k])=>k!=="account").map(([k,v])=><label key={k}>{k.replace(/([A-Z])/g," $1")}<input required type={k==="effectiveAt"?"date":["provider","model"].includes(k)?"text":"number"} min="0" step="any" value={v} onChange={e=>setPrice({...price,[k]:e.target.value})}/></label>)}<label>Account override<select value={price.account} onChange={e=>setPrice({...price,account:e.target.value})}><option value="">All accounts</option>{[...new Set<string>(dimensions.flatMap((d:any)=>[d.account,d.credential]).filter(Boolean))].map(v=><option key={v} value={v}>{short(v)}</option>)}</select></label><button className="button">Save pricing rule</button></form><div className="key-list">{prices.map(p=><div key={p.id}><div><strong>{p.provider}/{p.model}{p.account?` · ${short(p.account)}`:" · all accounts"}</strong><small>From {date(p.effective_at)} · In {money(p.input)} / Out {money(p.output)} · Cache read {money(p.cache_read)} / write {money(p.cache_write)} per 1M</small></div></div>)}</div></section>
    <section className="panel settings-panel"><h2><ShieldCheck size={18}/> Change password</h2><form className="inline-form" onSubmit={e=>{e.preventDefault();void act(async()=>{await request("/api/auth/password",{current,password:newPassword});setCurrent("");setNewPassword("");setNotice("Password updated; other login sessions revoked");});}}><input type="password" required placeholder="Current password" value={current} onChange={e=>setCurrent(e.target.value)} autoComplete="current-password"/><input type="password" required minLength={12} maxLength={256} placeholder="New password (12+ characters)" value={newPassword} onChange={e=>setNewPassword(e.target.value)} autoComplete="new-password"/><button className="button">Update password</button></form></section>{notice&&<div className="notice">{notice}</div>}
    {reveal&&<div className="overlay"><form className="modal panel" onSubmit={e=>{e.preventDefault();void act(async()=>{const value=await request(`/api/keys/${reveal}/reveal`,{password});setKey(value.key);setReveal(null);setPassword("");});}}><h2>Reveal API key</h2><p>Confirm your password to decrypt this key.</p><input type="password" autoFocus required value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/><div className="modal-actions"><button type="button" className="button" onClick={()=>setReveal(null)}>Cancel</button><button className="button primary">Reveal key</button></div></form></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
