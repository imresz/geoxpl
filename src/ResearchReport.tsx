import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, FileSearch, LoaderCircle, Play, Plus, Save, Settings2, X } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import { api, statusLabel } from './api';
import './research-report.css';

const labels: Record<string, string> = { queued:'Queued', running:'Investigating', ready:'Ready for review', applied:'Applied', stale:'Outdated', cancelled:'Cancelled', failed:'Failed', completed:'Action completed', active:'Active', deferred:'Deferred', dismissed:'Dismissed' };
const ownerLabels: Record<string,string> = { unassigned:'Unassigned', geoxpl:'GeoXpl investigation', decision:'Your decision', specialist:'Specialist / development' };
const date = (value:string) => new Date(value).toLocaleString();
function PreviewMap({ preview }: { preview:any }) {
  const container = useRef<HTMLDivElement>(null);
  const [error,setError] = useState('');
  const serialized = JSON.stringify(preview);
  useEffect(() => {
    if (!container.current) return;
    let map:maplibregl.Map;
    try {
      map = new maplibregl.Map({ container:container.current, bounds:preview.bounds, fitBoundsOptions:{ padding:35,maxZoom:13 },
        style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}},layers:[{id:'base',type:'raster',source:'osm'}]} });
      map.addControl(new maplibregl.NavigationControl(),'top-right');
      map.on('style.load',()=>{
        map.addSource('sample',{type:'geojson',data:preview.collection});
        map.addLayer({id:'sample-fill',type:'fill',source:'sample',filter:['==','$type','Polygon'],paint:{'fill-color':'#a33f71','fill-opacity':0.2}});
        map.addLayer({id:'sample-line',type:'line',source:'sample',paint:{'line-color':'#a33f71','line-width':4,'line-dasharray':[2,2]}});
        map.addLayer({id:'sample-point',type:'circle',source:'sample',filter:['==','$type','Point'],paint:{'circle-color':'#a33f71','circle-radius':6}});
      });
      map.on('error',()=>setError('Some map tiles or preview data could not load.'));
    } catch { setError('Map preview requires WebGL.'); return; }
    return ()=>map.remove();
  },[serialized]);
  return <><div className="report-preview" ref={container} aria-label="Unverified source sample map"/>{error && <p className="warning">{error}</p>}</>;
}

function Recommendation({ step, disabled, onSave, onInvestigate }: { step:any; disabled:boolean; onSave:(index:number,body:any)=>void; onInvestigate:(index:number)=>void }) {
  const [owner,setOwner]=useState(step.owner),[status,setStatus]=useState(step.status),[note,setNote]=useState(step.note);
  return <li className="recommendation-item"><p>{step.text}</p><div className="recommendation-controls">
    <label>Responsibility<select aria-label={`Responsibility for step ${step.index+1}`} value={owner} disabled={disabled} onChange={e=>setOwner(e.target.value)}>{Object.entries(ownerLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label>Disposition<select aria-label={`Disposition for step ${step.index+1}`} value={status} disabled={disabled} onChange={e=>setStatus(e.target.value)}><option value="open">Open</option><option value="handled">Handled</option><option value="deferred">Deferred</option></select></label>
  </div><label>Evidence or reason<textarea aria-label={`Evidence for step ${step.index+1}`} value={note} disabled={disabled} maxLength={2000} rows={2} onChange={e=>setNote(e.target.value)}/></label>
  <div className="report-buttons"><button className="secondary" disabled={disabled || (status!=='open'&&!note.trim())} onClick={()=>onSave(step.index,{owner,status,note})}><Save size={15}/>Save step</button><button className="secondary" disabled={disabled} onClick={()=>onInvestigate(step.index)}><FileSearch size={15}/>Investigate this step</button></div></li>;
}

export function ResearchReport({ reportId, sources, onClose, onChanged, onSource, onSettings }: { reportId:string; sources:any[]; onClose:()=>void; onChanged:()=>void; onSource:(id:string)=>void; onSettings:()=>void }) {
  const [view,setView]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState('actions');
  const [operation,setOperation]=useState('source'),[sourceId,setSourceId]=useState(''),[query,setQuery]=useState(''),[aliases,setAliases]=useState(''),[stepIndex,setStepIndex]=useState('');
  const [useSource,setUseSource]=useState(false),[useAliases,setUseAliases]=useState(false),[confirmed,setConfirmed]=useState(false),[note,setNote]=useState(''),[reason,setReason]=useState('');
  const [notes,setNotes]=useState('');
  const [targetName,setTargetName]=useState(''),[radiusKm,setRadiusKm]=useState(10),[discover,setDiscover]=useState(true),[refreshGap,setRefreshGap]=useState(false),[useEstimate,setUseEstimate]=useState(false);
  const load=()=>api(`/admin/reports/${reportId}/workflow`).then(setView);
  useEffect(()=>{
    let stopped=false;
    const poll=()=>api(`/admin/reports/${reportId}/workflow`).then(value=>{ if(!stopped)setView(value); }).catch(e=>{if(!stopped)setError(e.message);});
    api(`/admin/reports/${reportId}/workflow`).then(value=>{if(stopped)return;setView(value);setNotes(value.report.data.adminNotes||'');setSourceId(value.report.data.candidateIds?.find((id:string)=>sources.some(s=>s.id===id&&s.status!=='rejected'))||sources.find(s=>s.type===value.job.type&&s.status==='approved')?.id||'');}).catch(e=>{if(!stopped)setError(e.message);});
    const timer=setInterval(poll,2000);return()=>{stopped=true;clearInterval(timer);};
  },[reportId]);
  const investigation=view?.actions.find((a:any)=>a.kind==='investigate');
  useEffect(()=>{setUseSource(false);setUseAliases(false);setUseEstimate(false);setConfirmed(false);setNote('');},[investigation?.id]);
  useEffect(()=>{if(investigation?.input.operation==='gap'){setOperation('gap');setTargetName(investigation.input.targetName);setRadiusKm(investigation.input.radiusKm);setDiscover(investigation.input.discover);setRefreshGap(false);}},[investigation?.id]);
  async function act(fn:()=>Promise<unknown>) {setBusy(true);setError('');try{await fn();await load();onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const locked=busy||!!view?.readOnlyReason||view?.state!=='active';
  const investigating=['queued','running'].includes(investigation?.status);
  const result=investigation?.result;
  const canApply=investigation?.status==='ready'&&!investigation.stale&&result?.applicable&&!locked;
  return <div className="modal-backdrop" onClick={()=>!busy&&onClose()}><section className="modal research-workflow" role="dialog" aria-modal="true" aria-labelledby="report-title" onClick={e=>e.stopPropagation()}>
    <header><div><h2 id="report-title">{view?.job.name||'Research report'}</h2><span className="small muted">Research actions</span></div><button className="icon-button" aria-label="Close report" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    {!view?<div className="report-body"><LoaderCircle className="spin"/>Loading report{error&&<p className="error" role="alert">{error}</p>}</div>:<>
      <div className="report-body report-overview"><div className="report-buttons"><span className="badge">{labels[view.state]}</span><span className="badge">Feature: {statusLabel(view.job.status)}</span><a className="source-link" href={`/?job=${encodeURIComponent(view.job.id)}`}>View feature<ArrowUpRight size={14}/></a></div>
        {view.readOnlyReason&&<p className="warning">{view.readOnlyReason}</p>}{view.reason&&<p className="small">{view.reason}</p>}
        <details><summary>Research summary</summary><p>{view.report.data.summary}</p></details>
        <div className="admin-tabs report-tabs">{['actions','recommendations','evidence','history'].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t[0].toUpperCase()+t.slice(1)}</button>)}</div>
      </div>
      <div className="report-body report-content">
        {tab==='actions'&&<>
          <form onSubmit={e=>{e.preventDefault();act(()=>api(`/admin/reports/${reportId}/investigate`,'POST',{operation,...(stepIndex!==''?{stepIndex:Number(stepIndex)}:{}),...(operation==='source'?{sourceId,aliases:aliases.split('\n').map(s=>s.trim()).filter(Boolean)}:{}),...(operation==='gap'?{targetName,radiusKm,discover,refresh:refreshGap}:{}),...(operation==='prerequisite'?{query}:{})}));}}>
            <div className="recommendation-controls"><label>Operation<select aria-label="Investigation operation" disabled={locked||investigating} value={operation} onChange={e=>setOperation(e.target.value)}><option value="source">Check registered source</option><option value="retry">Review feature retry</option>{view.job.type==='river'&&<option value="gap">Investigate geographic gap</option>}{view.job.type==='valley'&&<option value="prerequisite">Process prerequisite river</option>}</select></label>
            <label>Recommendation<select aria-label="Recommendation" disabled={locked||investigating} value={stepIndex} onChange={e=>setStepIndex(e.target.value)}><option value="">General feature investigation</option>{view.steps.map((s:any)=><option key={s.index} value={s.index}>Step {s.index+1}</option>)}</select></label></div>
            {stepIndex!==''&&<p className="small">{view.steps[Number(stepIndex)]?.text}</p>}
            {operation==='source'&&<><label>Registered source<select aria-label="Investigation source" required value={sourceId} disabled={locked||investigating} onChange={e=>setSourceId(e.target.value)}><option value="">Select source</option>{sources.filter(s=>s.status!=='rejected').map(s=><option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}</select></label>
              <label>Alternative names to check<textarea aria-label="Alternative names to check" rows={2} maxLength={3000} value={aliases} disabled={locked||investigating} onChange={e=>setAliases(e.target.value)}/></label>
              <div className="report-buttons">{[...new Set<string>((view.report.data.candidates||[]).filter((s:any)=>s.type===view.job.type).flatMap((s:any)=>s.aliases||[]))].filter(a=>!aliases.split('\n').includes(a)).slice(0,20).map(a=><button key={a} type="button" className="text-button" disabled={locked||investigating} onClick={()=>setAliases(current=>[current,a].filter(Boolean).join('\n'))}><Plus size={14}/>{a}</button>)}</div>
            </>}
            {operation==='prerequisite'&&<label>River name<input aria-label="Prerequisite river name" required minLength={2} maxLength={150} value={query} disabled={locked||investigating} onChange={e=>setQuery(e.target.value)}/></label>}
            {operation==='gap'&&<><div className="recommendation-controls"><label>Destination waterbody<input aria-label="Destination waterbody" required minLength={2} maxLength={150} value={targetName} disabled={locked||investigating} onChange={e=>setTargetName(e.target.value)}/></label><label>Search radius (km)<input aria-label="Gap search radius" type="number" min={0.5} max={20} step={0.5} required value={radiusKm} disabled={locked||investigating} onChange={e=>setRadiusKm(Number(e.target.value))}/></label></div><label className="check-row"><input type="checkbox" checked={discover} disabled={locked||investigating} onChange={e=>setDiscover(e.target.checked)}/>AI discovery if mapped connection is missing</label><label className="check-row"><input type="checkbox" checked={refreshGap} disabled={locked||investigating} onChange={e=>setRefreshGap(e.target.checked)}/>Refresh unchanged findings</label></>}
            <button className="primary" disabled={locked||investigating}>{investigating?<LoaderCircle className="spin" size={16}/>:<FileSearch size={16}/>}Investigate next step</button>
          </form>
          {investigation&&<section className="investigation-result"><div className="report-buttons"><h3>Investigation result</h3><span className="badge">{investigation.stale?'Outdated':labels[investigation.status]}</span></div><p>{result.message||'Waiting for the background worker.'}</p>
            {investigation.stale&&<p className="warning">The feature or source changed. A new investigation is required.</p>}
            {investigation.input.operation==='gap'&&<>
              {result.anchor&&<p className="small">Recorded endpoint: {result.anchor.classification} · {result.anchor.coordinates.join(', ')}</p>}
              {result.checks?.length>0&&<div className="table-wrap"><table><thead><tr><th>Source</th><th>Finding</th><th>Records</th></tr></thead><tbody>{result.checks.map((c:any)=><tr key={c.source.url}><td>{c.source.name}<br/><a className="source-link" href={c.source.url} target="_blank" rel="noreferrer">Dataset<ArrowUpRight size={14}/></a></td><td>{c.message||`${c.kind} checked`}<br/>{c.source.status==='pending'?'Approval required':''}</td><td>{c.total??'—'}</td></tr>)}</tbody></table></div>}
              {result.targets?.map((t:any,i:number)=><p className="small" key={i}>Destination: {t.name} · record {t.id} · {t.status}</p>)}
              {result.routes?.map((r:any,i:number)=><p className="warning" key={i}>{r.message} Records: {r.recordIds.join(', ')}</p>)}
              {result.estimate&&<p className="warning">Proposed dotted estimate: {result.estimate.label}. The intervening route and physical entry point are unverified.</p>}
              {result.research&&<><p className="small">{result.research.summary}</p>{result.research.evidence?.map((e:any,i:number)=><a key={i} className="source-link" href={e.url} target="_blank" rel="noreferrer">{e.title}<ArrowUpRight size={14}/></a>)}</>}
              {result.candidateIds?.map((id:string)=><button key={id} className="secondary" disabled={locked} onClick={()=>{onChanged();onSource(id);}}><Settings2 size={16}/>Review {sources.find(s=>s.id===id)?.name||'discovered source'}</button>)}
              <details><summary>Spatial query evidence</summary>{result.checks?.flatMap((c:any)=>c.requests||[]).map((url:string,i:number)=><a key={i} className="source-link" href={url} target="_blank" rel="noreferrer">Source query {i+1}<ArrowUpRight size={14}/></a>)}</details>
            </>}
            {result.source&&<><h3>{result.source.name}</h3><p className="small">Source: {statusLabel(result.source.status)} · {result.checkedAt?date(result.checkedAt):''}</p>{result.total!==undefined&&<p><strong>{result.total} matching records</strong> · {result.records?.length||0} sampled</p>}
              {result.preview&&<PreviewMap preview={result.preview}/>}<p className="small muted">Unverified sample only. Not a complete feature extent.</p>{result.previewError&&<p className="warning">{result.previewError}</p>}
              {result.source.attribution&&<p className="small">{result.source.attribution} {result.source.licence&&`(${result.source.licence})`}</p>}
              {result.records?.length>0&&<div className="table-wrap"><table><thead><tr><th>Record</th><th>Name</th></tr></thead><tbody>{result.records.map((r:any,i:number)=><tr key={i}><td>{r.id}</td><td>{r.name}</td></tr>)}</tbody></table></div>}
              <details><summary>Query evidence</summary><p className="small">Names: {result.terms?.join(', ')}</p><p className="small">Fields: {result.fields?.join(', ')}</p>{result.requests?.map((url:string)=><a key={url} className="source-link" href={url} target="_blank" rel="noreferrer">Source query<ArrowUpRight size={14}/></a>)}</details>
              {result.source.status!=='approved'&&<button className="secondary" disabled={locked} onClick={()=>onSource(result.source.id)}><Settings2 size={16}/>Review source</button>}
              {result.owner==='specialist'&&<button className="secondary" disabled={locked} onClick={onSettings}><Settings2 size={16}/>Review geographic settings</button>}
            </>}
            {result.existing?.map((j:any)=><p key={j.id}><a className="source-link" href={`/?job=${encodeURIComponent(j.id)}`}>{j.name}<ArrowUpRight size={14}/></a>{statusLabel(j.status)}</p>)}
            {canApply&&<form className="proposal-review" onSubmit={e=>{e.preventDefault();act(()=>api(`/admin/reports/${reportId}/actions/${investigation.id}/apply`,'POST',{confirmed,useSource,useAliases,useEstimate,note}));}}>
              <h3>Review proposed changes</h3>
              {investigation.input.operation==='gap'&&<label className="check-row"><input type="checkbox" checked={useEstimate} onChange={e=>setUseEstimate(e.target.checked)}/>Add the dotted terminal-connection estimate; retain partial status</label>}
              {investigation.input.operation==='source'&&<><p className="small">Current source: {sources.find(s=>s.id===result.beforeSettings?.preferredSourceId)?.name||'Automatic selection'}</p><label className="check-row"><input type="checkbox" checked={useSource} onChange={e=>setUseSource(e.target.checked)}/>Use {result.source.name} for this feature</label>
                {result.proposedAliases?.length>0&&<><p className="small">Current aliases: {result.beforeSettings?.aliases?.join(', ')||'None'}</p><label className="check-row"><input type="checkbox" checked={useAliases} onChange={e=>setUseAliases(e.target.checked)}/>Add aliases: {result.proposedAliases.join(', ')}</label></>}
              </>}
              <p className="small">{investigation.input.operation==='prerequisite'?`Target: ${result.query}. The valley settings will not change.`:'The affected feature will be reprocessed using approved sources.'} Automatic AI research is disabled for newly queued work.</p>
              <label>Review evidence / notes<textarea aria-label="Proposal review notes" rows={2} maxLength={2000} required={useAliases||investigation.input.operation==='gap'} value={note} onChange={e=>setNote(e.target.value)}/></label>
              <label className="check-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I approve the selected changes and processing request</label>
              <button className="primary" disabled={!confirmed||busy||(investigation.input.operation==='gap'&&!useEstimate)}><Check size={16}/>Apply and reprocess</button>
            </form>}
            {investigation.outcome&&<div className="action-outcome"><h3>Processing outcome</h3>{result.before&&!Array.isArray(result.before)&&<p className="small">Before: {statusLabel(result.before.status)}</p>}<p>Now: {statusLabel(investigation.outcome.status)} · {statusLabel(investigation.outcome.phase)}</p><a className="source-link" href={`/?job=${encodeURIComponent(investigation.outcome.id)}`}>{investigation.outcome.name}<ArrowUpRight size={14}/></a><p className="small muted">The action was applied; geographic completeness is assessed separately.</p></div>}
          </section>}
        </>}
        {tab==='recommendations'&&<><p className="small muted">Handled recommendations do not certify feature geometry.</p><ol className="recommendation-list">{view.steps.map((step:any)=><Recommendation key={step.index} step={step} disabled={locked} onSave={(index,body)=>act(()=>api(`/admin/reports/${reportId}/steps/${index}`,'PATCH',body))} onInvestigate={index=>{setStepIndex(String(index));setTab('actions');}}/>)}</ol>{!view.steps.length&&<p>No individual recommendations were recorded.</p>}</>}
        {tab==='evidence'&&<>{view.report.data.evidence?.map((e:any,i:number)=><a className="source-link" key={i} href={e.url} target="_blank" rel="noreferrer">{e.title}<ArrowUpRight size={16}/></a>)}{!view.report.data.evidence?.length&&<p>No external evidence links were recorded.</p>}<p className="small muted">{view.report.data.provider} · {date(view.report.created)}</p><button className="secondary" disabled={locked} onClick={onSettings}><Settings2 size={16}/>Feature settings</button></>}
        {tab==='history'&&<><ol className="report-history">{view.actions.map((a:any)=><li key={a.id}><strong>{a.kind==='investigate'?`Investigate: ${a.input.operation}`:statusLabel(a.kind)}</strong><span className="badge">{a.stale?'Outdated':labels[a.status]}</span><small>{date(a.updated)}</small>
          {a.result.message&&<p>{a.result.message}</p>}{(a.input.reason||a.input.note||a.input.notes)&&<p>{a.input.reason||a.input.note||a.input.notes}</p>}
          {a.result.selectedSourceName&&<p className="small">Selected source: {a.result.selectedSourceName}</p>}{a.result.addedAliases?.length>0&&<p className="small">Added aliases: {a.result.addedAliases.join(', ')}</p>}
          {a.input.stepIndex!==undefined&&<p className="small">Recommendation {a.input.stepIndex+1}</p>}{a.input.index!==undefined&&<p className="small">Step {a.input.index+1}: {ownerLabels[a.input.owner]} · {a.input.status}</p>}{a.outcome&&<a className="source-link" href={`/?job=${encodeURIComponent(a.outcome.id)}`}>{a.outcome.name}: {statusLabel(a.outcome.status)}<ArrowUpRight size={14}/></a>}</li>)}</ol>{!view.actions.length&&<p>No actions recorded yet.</p>}</>}
        {error&&<p className="error" role="alert">{error}</p>}
      </div>
      <footer className="report-footer"><details><summary>Report disposition and notes</summary><label>Administrator notes<textarea rows={2} maxLength={4000} disabled={locked} value={notes} onChange={e=>setNotes(e.target.value)}/></label><button className="secondary" disabled={locked} onClick={()=>act(()=>api(`/admin/reports/${reportId}`,'PATCH',{status:'approved',notes}))}><Check size={15}/>Mark reviewed</button><label>Deferral / dismissal reason<textarea aria-label="Deferral or dismissal reason" rows={2} maxLength={2000} value={reason} disabled={busy||!!view.readOnlyReason} onChange={e=>setReason(e.target.value)}/></label><div className="report-buttons">
        {view.state==='active'?<><button className="secondary" disabled={locked||!reason.trim()} onClick={()=>act(()=>api(`/admin/reports/${reportId}/state`,'POST',{state:'deferred',reason}))}>Defer</button><button className="secondary" disabled={locked||!reason.trim()} onClick={()=>act(()=>api(`/admin/reports/${reportId}/state`,'POST',{state:'dismissed',reason}))}>Dismiss</button></>:<button className="secondary" disabled={busy||!!view.readOnlyReason} onClick={()=>act(()=>api(`/admin/reports/${reportId}/state`,'POST',{state:'active',reason}))}><Play size={15}/>Resume report</button>}
      </div></details></footer>
    </>}
  </section></div>;
}
