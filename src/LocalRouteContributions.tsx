import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { ArrowRight, Eye, LoaderCircle, MapPin, Plus, RotateCcw, Save, Search, Upload } from 'lucide-react';
import { api } from './api';
import './local-contributions.css';

type SectionEvidence={statement:string;uncertainty:string;links:string[]};
type Road = GeoJSON.Feature<GeoJSON.LineString, { pfi:number; ezi_road_name_label?:string; ezi_road_name?:string }> & { id:string; snapshotId:string;membership?:SectionEvidence };
type Form = { author:string; basis:string; observedAt:string; statement:string; uncertainty:string; links:string; segments:Road[] };
type RouteOption={id:string;code:string;scheme:string;label:string;bbox:[number,number,number,number]|null;hasAlignment:boolean;hasSavedRoads:boolean};
const empty = ():Form => ({author:'',basis:'local_knowledge',observedAt:'',statement:'',uncertainty:'',links:'',segments:[]});
const overview:Record<string,[number,number,number,number]> = {
  '20':[144.95,-37.86,145.13,-37.80], '22':[144.99,-37.94,145.32,-37.85]
};

function ContributionMap({code,extent,roads,selected,preview,onToggle,onBounds}: {
  code:string; extent:[number,number,number,number];roads:Road[]; selected:Road[]; preview:any;
  onToggle:(road:Road)=>void; onBounds:(bounds:number[])=>void;
}) {
  const element=useRef<HTMLDivElement>(null), map=useRef<maplibregl.Map|null>(null);
  const [loaded,setLoaded]=useState(false),[error,setError]=useState('');
  const callbacks=useRef({roads,onToggle,onBounds});
  const extentKey=extent.join(',');
  callbacks.current={roads,onToggle,onBounds};
  useEffect(()=>{
    if(!element.current)return;
    const m=new maplibregl.Map({container:element.current,bounds:extent,fitBoundsOptions:{padding:35},attributionControl:{compact:true},
      style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,
        attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Vicmap Transport © State of Victoria (CC BY 4.0)'}},
        layers:[{id:'basemap',type:'raster',source:'osm'}]}});
    map.current=m;m.addControl(new maplibregl.NavigationControl(),'top-right');
    m.on('load',()=>{
      for(const id of ['roads','selected','preview'])m.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      m.addLayer({id:'road-hit',type:'line',source:'roads',paint:{'line-width':16,'line-opacity':0}});
      m.addLayer({id:'roads',type:'line',source:'roads',paint:{'line-color':'#547e91','line-width':3}});
      m.addLayer({id:'selected',type:'line',source:'selected',paint:{'line-color':'#ab3970','line-width':5}});
      m.addLayer({id:'preview',type:'line',source:'preview',paint:{'line-color':'#9b5f19','line-width':5,'line-dasharray':[2,2]}});
      setLoaded(true);
    });
    m.on('click','road-hit',event=>{
      const road=callbacks.current.roads.find(r=>r.id===event.features?.[0]?.properties?.recordId);
      if(road)callbacks.current.onToggle(road);
    });
    const moved=()=>{const b=m.getBounds();callbacks.current.onBounds([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]);};
    m.on('moveend',moved);m.on('load',moved);
    m.on('error',()=>setError('Some map tiles could not load.'));
    const observer=new ResizeObserver(()=>m.resize());observer.observe(element.current);
    return ()=>{observer.disconnect();m.remove();map.current=null;setLoaded(false);};
  },[code,extentKey]);
  useEffect(()=>{
    const m=map.current;if(!m||!loaded)return;
    for(const [id,features] of [['roads',roads],['selected',selected]] as const){
      (m.getSource(id) as maplibregl.GeoJSONSource)?.setData({type:'FeatureCollection',features:features.map(r=>({
        type:'Feature',geometry:r.geometry,properties:{recordId:r.id}
      }))});
    }
    (m.getSource('preview') as maplibregl.GeoJSONSource)?.setData({type:'FeatureCollection',features:preview?[{
      type:'Feature',geometry:preview.feature.geometry,properties:{}
    }]:[]});
  },[roads,selected,preview,loaded]);
  useEffect(()=>{
    if(preview&&loaded)map.current?.fitBounds(preview.feature.bbox,{padding:40,duration:0});
  },[preview,loaded]);
  return <div><div className="contribution-map" ref={element} aria-label="Local contribution map preview"/>{error&&<p role="status" className="small muted">{error}</p>}</div>;
}

export function LocalRouteContributions() {
  const [code,setCode]=useState('20'),[form,setForm]=useState<Form>(empty),[saved,setSaved]=useState<any>(null),[preview,setPreview]=useState<any>(null);
  const [options,setOptions]=useState<RouteOption[]>([{id:'20',code:'20',scheme:'metropolitan',label:'Metropolitan Route 20',bbox:null,hasAlignment:false,hasSavedRoads:false},
    {id:'22',code:'22',scheme:'metropolitan',label:'Metropolitan Route 22',bbox:null,hasAlignment:false,hasSavedRoads:false}]);
  const [filter,setFilter]=useState(''),[newRoute,setNewRoute]=useState(false),[newScheme,setNewScheme]=useState('metropolitan'),[newCode,setNewCode]=useState('');
  const [origin,setOrigin]=useState('live');
  const [roads,setRoads]=useState<Road[]>([]),[bounds,setBounds]=useState<number[]>([]),[dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [confirmed,setConfirmed]=useState(false),[reason,setReason]=useState('');
  const locked=saved?.state==='published';
  const refreshOptions=()=>{void api<RouteOption[]>('/admin/local-routes').then(setOptions).catch(()=>{});};
  const option=options.find(r=>r.id===code);
  const routePath=`/admin/local-routes/${encodeURIComponent(code)}`;
  const extent=option?.bbox || overview[code] || [140.9,-39.3,150.1,-34.0] as [number,number,number,number];
  useEffect(()=>{
    const controller=new AbortController();
    api<RouteOption[]>('/admin/local-routes','GET',undefined,controller.signal).then(data=>{
      if(!controller.signal.aborted)setOptions(data);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>setOrigin(option?.hasSavedRoads?'catalogue':'live'),[code,option?.hasSavedRoads]);
  const adopt=(data:any)=>{
    setSaved(data);setForm(data?{...data.data,links:data.data.links.join('\n'),segments:data.selected}:empty());
    setDirty(false);setPreview(null);setConfirmed(false);
  };
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setRoads([]);setNotice('');setBounds([]);
    api(routePath,'GET',undefined,controller.signal).then(data=>{
      if(!controller.signal.aborted)adopt(data);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[code]);
  const edit=(update:Partial<Form>)=>{setForm(current=>({...current,...update}));setDirty(true);setPreview(null);setConfirmed(false);};
  const toggle=(road:Road)=>{
    if(locked||busy||loading)return;
    edit({segments:form.segments.some(r=>r.id===road.id)?form.segments.filter(r=>r.id!==road.id):[...form.segments,road]});
  };
  const editSection=(id:string,change:Partial<SectionEvidence>)=>edit({segments:form.segments.map(r=>r.id===id ?
    {...r,membership:{statement:'',uncertainty:'',links:[],...r.membership,...change}} : r)});
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const loadRoads=()=>act(async()=>{
    const data=await api(`${routePath}/roads`,'POST',{bounds,origin});
    setRoads(data.features.map((f:any)=>({...f,snapshotId:f.snapshotId || data.id})));
    setNotice(`${data.features.length} road segments loaded from ${origin==='catalogue'?'retained alignment inputs':'Vicmap'}.${data.omitted?` ${data.omitted} records outside Victoria excluded.`:''}${data.sourceVersions?.length?` Source versions: ${data.sourceVersions.join(', ')}.`:''}`);
  });
  const closeView=bounds.length===4&&bounds[2]-bounds[0]<=.045&&bounds[3]-bounds[1]<=.035;
  const save=()=>act(async()=>{
    const value=await api(routePath,'PUT',{
      ...form,version:saved?.version||0,links:form.links.split('\n').map(x=>x.trim()).filter(Boolean),
      segments:form.segments.map(r=>({snapshotId:r.snapshotId,recordId:r.id,...(r.membership ? {membership:{...r.membership,
        links:r.membership.links.map(x=>x.trim()).filter(Boolean)}} : {})}))
    });
    adopt(value);
    setPreview(await api(`${routePath}/preview`,'POST',{}));
    setNotice('Draft saved. Preview is not public.');
  });
  const review=()=>act(async()=>{setPreview(await api(`${routePath}/preview`,'POST',{}));});
  const publish=()=>act(async()=>{
    const alternative=preview.publication?.mode==='alternative';
    const value=await api(`${routePath}/publish`,'POST',{version:preview.version,checksum:preview.checksum,confirmed:true});
    adopt(value);refreshOptions();setNotice(alternative?'Local candidate published separately. Existing alignment retained.':'Published as a partially resolved local contribution.');
  });
  const withdraw=()=>act(async()=>{
    const value=await api(`${routePath}/withdraw`,'POST',{version:saved.version,reason});
    adopt(value);refreshOptions();setReason('');setNotice('Publication withdrawn. Draft and archived revisions retained.');
  });
  return <section className="local-contributions">
    <div className="section-heading"><h2>Local route contributions</h2>
      <div className="contribution-route-picker">
        <label className="contribution-filter"><Search size={16}/><input type="search" aria-label="Filter contribution routes" placeholder="Route code" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
        <select aria-label="Contribution route" value={code} disabled={busy} onChange={e=>{
          if(!dirty||window.confirm('Discard unsaved changes to this contribution?'))setCode(e.target.value);
        }}>{options.filter(r=>r.id===code||r.label.toLowerCase().includes(filter.trim().toLowerCase())).map(r=><option key={r.id} value={r.id}>{r.label}{r.scheme==='unconfirmed_numeric'?' (scheme unconfirmed)':''}</option>)}</select>
        <button type="button" className="contribution-add" aria-label="Add route" title="Add a route to the contribution editor" disabled={busy} aria-expanded={newRoute} onClick={()=>setNewRoute(!newRoute)}><Plus size={18}/></button>
      </div></div>
    {newRoute&&<form className="contribution-new-route" onSubmit={event=>{
      event.preventDefault();const value=newCode.trim().toUpperCase(),alpha=newScheme==='alphanumeric';
      if(!(alpha?/^[MABC][0-9]{1,3}$/:/^[1-9][0-9]?$/).test(value)){setError(alpha?'Enter an M, A, B or C route code with up to three digits.':'Enter a route number from 1 to 99.');return;}
      const id=newScheme==='unconfirmed_numeric'?`numbered:${value}`:value;
      if(id!==code&&dirty&&!window.confirm('Discard unsaved changes to this contribution?'))return;
      const label=alpha?value:`${newScheme==='metropolitan'?'Metropolitan':'Numbered'} Route ${value}`;
      setOptions(current=>current.some(r=>r.id===id)?current:[...current,{id,code:value,scheme:newScheme,label,bbox:null,hasAlignment:false,hasSavedRoads:false}]);
      setCode(id);setFilter('');setNewCode('');setNewRoute(false);
    }}><label>Numbering scheme<select value={newScheme} onChange={e=>setNewScheme(e.target.value)}><option value="metropolitan">Metropolitan / state route</option><option value="alphanumeric">M / A / B / C route</option><option value="unconfirmed_numeric">Numeric tag (scheme unconfirmed)</option></select></label>
      <label>Route code<input required maxLength={4} value={newCode} onChange={e=>setNewCode(e.target.value)}/></label><button type="submit" className="secondary"><ArrowRight size={16}/>Open draft</button></form>}
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="warning">{notice}</p>}
    {loading?<p><LoaderCircle className="spin" size={16}/>Loading draft</p>:<div className="contribution-layout">
      <form className="contribution-form" onSubmit={event=>{event.preventDefault();void save();}}>
        <span className="badge">{saved?.state||'Unsaved draft'}{saved&&` · Revision ${saved.version}`}</span>
        <label>Public contributor name<input required minLength={2} maxLength={100} value={form.author} disabled={locked||busy} onChange={e=>edit({author:e.target.value})}/></label>
        <label>Evidence basis<select value={form.basis} disabled={locked||busy} onChange={e=>edit({basis:e.target.value})}>
          <option value="local_knowledge">Local knowledge</option><option value="observed_signs">Observed roadside signs</option><option value="published_reference">Published reference</option></select></label>
        <label>Observation date<input type="date" value={form.observedAt} disabled={locked||busy} onChange={e=>edit({observedAt:e.target.value})}/></label>
        <label>Contribution<textarea required minLength={10} maxLength={2000} rows={3} value={form.statement} disabled={locked||busy} onChange={e=>edit({statement:e.target.value})}/></label>
        <label>Unverified turns, endpoints or sections<textarea required minLength={10} maxLength={2000} rows={3} value={form.uncertainty} disabled={locked||busy} onChange={e=>edit({uncertainty:e.target.value})}/></label>
        <label>Supporting links (optional)<textarea rows={2} value={form.links} disabled={locked||busy} onChange={e=>edit({links:e.target.value})}/></label>
        <div className="report-buttons">
          {!locked&&<button className="secondary" disabled={busy||!form.segments.length}><Save size={16}/>Save draft & preview</button>}
          {saved&&!dirty&&<button type="button" className="secondary" disabled={busy} onClick={review}><Eye size={16}/>Preview saved draft</button>}
        </div>
        {!locked&&preview&&!dirty&&<>
          {preview.publication?.mode==='alternative'&&<p className="small">The existing catalogue alignment will be retained as a separate result.</p>}
          <p className="small">{preview.feature.roadRoute.segments} segments · {preview.feature.roadRoute.components} connected groups</p>
          {preview.feature.warnings.map((note:string)=><p className="small muted" key={note}>{note}</p>)}
          <label className="check-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Publish my contributor name, notes and links with this unverified alignment.</label>
          <button type="button" className="primary" disabled={busy||!confirmed} onClick={publish}><Upload size={16}/>Publish contribution</button>
        </>}
        {locked&&<section className="contribution-withdraw">
          <a className="source-link" href={`/?job=${saved.jobId||''}`}>View published route</a>
          <label>Withdrawal reason<textarea minLength={5} maxLength={1000} rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>
          <button type="button" className="secondary" disabled={busy||reason.trim().length<5} onClick={withdraw}><RotateCcw size={16}/>Withdraw publication</button>
        </section>}
        {!!saved?.history.length&&<details><summary>Contribution history</summary><ul>{saved.history.map((item:any,index:number)=><li key={index}>{item.kind} · {new Date(item.created).toLocaleString()}</li>)}</ul></details>}
      </form>
      <div>
        <ContributionMap code={code} extent={extent} roads={roads} selected={form.segments} preview={preview} onToggle={toggle} onBounds={setBounds}/>
        <div className="geometry-modes contribution-origin" role="group" aria-label="Road source">
          <button type="button" aria-pressed={origin==='catalogue'} disabled={busy||locked||!option?.hasSavedRoads} onClick={()=>setOrigin('catalogue')}>Saved alignment</button>
          <button type="button" aria-pressed={origin==='live'} disabled={busy||locked} onClick={()=>setOrigin('live')}>Vicmap area</button>
        </div>
        <div className="contribution-toolbar"><button type="button" className="secondary" title={closeView?'Load Vicmap road segments in this map view':'A closer map view is required'} disabled={busy||locked||!closeView} onClick={loadRoads}><MapPin size={16}/>Load visible roads</button>
          <span className="small muted">{form.segments.length} selected{!closeView?' · Overview scale':''}</span></div>
        <details open><summary>Selected segments ({form.segments.length})</summary>
          <div className="contribution-roads contribution-selected">{form.segments.map(r=><div className="contribution-segment" key={r.id}>
            <label><input type="checkbox" checked disabled={locked||busy} onChange={()=>toggle(r)}/><span>{r.properties.ezi_road_name||r.properties.ezi_road_name_label||'Unnamed road'}<small>PFI {r.properties.pfi}</small></span></label>
            <details><summary>Section evidence · PFI {r.properties.pfi}</summary>
              <label className="segment-evidence-field">Evidence for PFI {r.properties.pfi}<textarea rows={2} maxLength={1000} disabled={locked||busy} value={r.membership?.statement || ''} onChange={e=>editSection(r.id,{statement:e.target.value})}/></label>
              <label className="segment-evidence-field">Uncertainty for PFI {r.properties.pfi}<textarea rows={2} maxLength={1000} disabled={locked||busy} value={r.membership?.uncertainty || ''} onChange={e=>editSection(r.id,{uncertainty:e.target.value})}/></label>
              <label className="segment-evidence-field">Supporting links for PFI {r.properties.pfi}<textarea rows={2} disabled={locked||busy} value={r.membership?.links.join('\n') || ''} onChange={e=>editSection(r.id,{links:e.target.value.split('\n')})}/></label>
            </details>
          </div>)}</div>
        </details>
        <details><summary>Road segments in map view ({roads.length})</summary>
          <div className="contribution-roads">{roads.map(r=><label key={r.id}><input type="checkbox" checked={form.segments.some(s=>s.id===r.id)} disabled={locked||busy} onChange={()=>toggle(r)}/><span>{r.properties.ezi_road_name||r.properties.ezi_road_name_label||'Unnamed road'}<small>PFI {r.properties.pfi}</small></span></label>)}</div>
        </details>
      </div>
    </div>}
  </section>;
}
