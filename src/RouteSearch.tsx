import { useEffect,useState } from 'react';
import { ArrowUpRight,FileSearch,LoaderCircle,RefreshCw,Route } from 'lucide-react';
import { api,featureLabel,statusLabel,type FeatureSummary,type RouteDiscovery,type RouteQualityData,type RouteSearchData } from './api';
import './route-search.css';

export const routeQualityOf=(feature:unknown)=>(feature as {routeQuality?:RouteQualityData})?.routeQuality;
export function RouteQuality({quality,details=false}:{quality?:RouteQualityData;details?:boolean}) {
  if(!quality)return null;
  return <div className="route-quality"><dl><dt>Mapped coverage</dt><dd>{quality.coverage.label}</dd><dt>Designation</dt><dd>{quality.designation.label}</dd></dl>
    {details&&<><p className="small muted">{quality.coverage.note}</p><p className="small muted">{quality.designation.note}</p></>}</div>;
}

export function RouteResearchEvidence({discovery}:{discovery:RouteDiscovery}) {
  const d=discovery.data,records=d.records||[];
  return <details className="detail-section mapping-disclosure"><summary>How this was mapped</summary>
    <p>{d.note||d.message||'The source check is queued. No mapped extent has been published.'}</p>
    {d.provider&&<dl><dt>Source</dt><dd>{d.provider}</dd><dt>Checked</dt><dd>{d.retrievedAt?new Date(d.retrievedAt).toLocaleString():'Not recorded'}</dd><dt>Licence</dt><dd>{d.licence}</dd><dt>Credit</dt><dd>{d.attribution}</dd></dl>}
    {d.sourceUrl&&<a className="source-link" href={d.sourceUrl} target="_blank" rel="noreferrer">Source and licence<ArrowUpRight size={14}/></a>}
    {records.length>0&&<details><summary>Source records ({records.length})</summary><ul className="route-records">{records.map((r,i)=><li key={`${r.id||r.pfi}:${i}`}>
      {r.url?<a href={r.url} target="_blank" rel="noreferrer">{r.name}</a>:<strong>{r.name}</strong>}
      {r.pfi&&<small>Vicmap PFI {r.pfi} · {r.localities?.join(' / ')}{r.code?` · source tag ${r.code}`:''}</small>}
      {r.claims?.map(c=><small key={c.field}>{statusLabel(c.status)} · {c.field}={c.value}</small>)}
      {r.version&&<small>Source revision {r.version}{r.timestamp?` · ${new Date(r.timestamp).toLocaleDateString()}`:''}</small>}
      {r.tags&&<details><summary>Reported tags</summary><dl>{Object.entries(r.tags).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></details>}
    </li>)}</ul></details>}
    {d.checksum&&<details><summary>Evidence fingerprint</summary><code className="route-checksum">{d.checksum}</code></details>}
    {!!discovery.history?.length&&<details><summary>Research history ({discovery.history.length})</summary><ul>{discovery.history.map(r=><li key={r.id}><details><summary>{new Date(r.created).toLocaleString()} · {statusLabel(r.state)}</summary><pre>{JSON.stringify(r.data,null,2)}</pre></details></li>)}</ul></details>}
  </details>;
}

export function RouteSearchResults({initial,onSelect,onSearch,loading}:{initial:RouteSearchData;onSelect:(id:string)=>void;onSearch:(query:string)=>void;loading:boolean}) {
  const [result,setResult]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false),[locality,setLocality]=useState('');
  const discovery=result.discovery,pending=discovery&&['queued','running'].includes(discovery.state);
  async function refresh() {
    if(!discovery)return;
    const next=await api<{routeSearch:RouteSearchData}>(`/route-discoveries/${discovery.id}`);setResult(next.routeSearch);
  }
  useEffect(()=>{
    if(!pending)return;
    let live=true;
    const timer=setInterval(()=>{api<{routeSearch:RouteSearchData}>(`/route-discoveries/${discovery.id}`).then(r=>{if(live)setResult(r.routeSearch);}).catch(()=>{});},1200);
    const stop=setTimeout(()=>clearInterval(timer),5000);
    return()=>{live=false;clearInterval(timer);clearTimeout(stop);};
  },[discovery?.id,pending]);
  async function research() {
    setBusy(true);setError('');
    try{const query=locality.trim()?`${result.offer!.query.split(',')[0]}, ${locality.trim()}`:result.offer!.query;
      const response=await api<{routeSearch:RouteSearchData}>('/route-discoveries','POST',{query});setResult(response.routeSearch);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const publicCodes=[...new Set((discovery?.data.records||[]).map(r=>r.code).filter((c):c is string=>!!c&&/^[MABC]\d{1,3}$/.test(c)))];
  return <section aria-label="Route search results"><div className="panel-title"><h1>{result.query}</h1><Route size={20}/></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {result.matches.length>0?<><p className="small muted">{result.matches.length} saved {result.matches.length===1?'alignment':'alignments'} matching this road{discovery?.input.locality?` in ${discovery.input.locality}`:''}.</p>
      <div className="catalogue-list">{result.matches.map((f:FeatureSummary)=><button key={f.id} disabled={loading} onClick={()=>onSelect(f.id)}><Route size={18}/><span><strong>{featureLabel(f)}</strong><small>{routeQualityOf(f)?.coverage.label}</small><small>{routeQualityOf(f)?.designation.label}</small></span><ArrowUpRight size={16}/></button>)}</div></>:
      <p role="status">{pending?'Checking the source. The request is saved and will continue in the background.':discovery?.state==='unavailable'?'The source check could not finish. This is not evidence that the route is absent.':discovery?.state==='no_match'?'No matching records were found in this source check. Other evidence may still exist.':discovery?.state==='available'?'Provisional research result. There is no published map extent yet.':'No saved route alignment matches this search.'}</p>}
    {result.offer&&<div className="detail-section"><h2>Research {result.offer.label}</h2><label>Locality (optional)<input value={locality} onChange={e=>setLocality(e.target.value)} maxLength={80}/></label><button className="primary full" type="button" disabled={busy} onClick={research}>{busy?<LoaderCircle className="spin" size={16}/>:<FileSearch size={16}/>}Check public sources</button></div>}
    {discovery&&<><dl><dt>Mapped coverage</dt><dd>{result.matches.length?'Saved route sections matched':'No mapped extent'}</dd><dt>Designation</dt><dd>{discovery.input.code?discovery.data.designation||'Not assessed':'Road/locality match only'}</dd></dl>
      {pending&&<p className="small muted">Please try again later if the result is not ready.</p>}
      <button className="secondary full" disabled={busy} onClick={()=>{setBusy(true);refresh().catch(e=>setError(e.message)).finally(()=>setBusy(false));}}><RefreshCw size={15}/>Check saved result</button>
      <RouteResearchEvidence discovery={discovery}/>
      {discovery.state==='unavailable'&&!discovery.input.locality&&<div className="detail-section"><label>Limit the next check to a locality<input value={locality} onChange={e=>setLocality(e.target.value)} maxLength={80}/></label><button className="secondary full" disabled={!locality.trim()} onClick={()=>onSearch(`${discovery.input.label}, ${locality.trim()}`)}>Search this locality<ArrowUpRight size={15}/></button></div>}
    </>}
    {publicCodes.length>0&&<div className="detail-section"><h2>Route tags reported by Vicmap</h2>{publicCodes.map(c=><button className="text-button" key={c} onClick={()=>onSearch(c)}>{c}<ArrowUpRight size={15}/></button>)}</div>}
    <p className="small muted">{result.message}</p>
  </section>;
}
