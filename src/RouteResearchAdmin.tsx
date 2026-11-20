import { useEffect,useState } from 'react';
import { RefreshCw,ArrowUpRight } from 'lucide-react';
import { api,statusLabel,type RouteDiscovery } from './api';
import { RouteResearchEvidence } from './RouteSearch';

export function RouteResearchAdmin() {
  const [rows,setRows]=useState<RouteDiscovery[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
  const refresh=()=>api<RouteDiscovery[]>('/admin/route-discoveries').then(setRows).catch(e=>setError(e.message));
  useEffect(()=>{refresh();const timer=setInterval(refresh,3000);return()=>clearInterval(timer);},[]);
  return <section className="followup-group"><h3>Route source checks <span className="badge">{rows.length}</span></h3>
    {error&&<p className="error" role="alert">{error}</p>}
    {!rows.length&&<p className="muted small">No route source checks requested.</p>}
    {rows.map(row=><section className="followup-row" key={row.id}><div><h3>{row.input.query}</h3><span className="badge">{statusLabel(row.state)}</span>
      <p>{['queued','running'].includes(row.state)?'Source check in progress.':row.state==='available'?'Evidence saved. No new geometry has been published.':row.state==='no_match'?'This source check found no matching records; other evidence may exist.':'Source unavailable. Retry when connectivity has recovered.'}</p>
      <RouteResearchEvidence discovery={row}/></div><div className="report-buttons"><a className="text-button" href={`/?routeResearch=${encodeURIComponent(row.id)}`}>View result<ArrowUpRight size={14}/></a>
      <button className="secondary small-button" disabled={!!busy||['queued','running'].includes(row.state)||Date.now()-Date.parse(row.updated)<300000} onClick={async()=>{
        setBusy(row.id);setError('');try{await api(`/admin/route-discoveries/${row.id}/retry`,'POST',{});await refresh();}catch(e){setError((e as Error).message);}finally{setBusy('');}
      }}><RefreshCw size={14}/>Check sources again</button></div></section>)}
  </section>;
}
