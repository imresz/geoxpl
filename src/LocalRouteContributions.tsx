import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Eye, LoaderCircle, MapPin, RotateCcw, Save, Upload } from 'lucide-react';
import { api } from './api';
import './local-contributions.css';

type Road = GeoJSON.Feature<GeoJSON.LineString, { pfi:number; ezi_road_name_label?:string; ezi_road_name?:string }> & { id:string; snapshotId:string };
type Form = { author:string; basis:string; observedAt:string; statement:string; uncertainty:string; links:string; segments:Road[] };
const empty = ():Form => ({author:'',basis:'local_knowledge',observedAt:'',statement:'',uncertainty:'',links:'',segments:[]});
const overview:Record<string,[number,number,number,number]> = {
  '20':[144.95,-37.86,145.13,-37.80], '22':[144.99,-37.94,145.32,-37.85]
};

function ContributionMap({code,roads,selected,preview,onToggle,onBounds}: {
  code:string; roads:Road[]; selected:Road[]; preview:any;
  onToggle:(road:Road)=>void; onBounds:(bounds:number[])=>void;
}) {
  const element=useRef<HTMLDivElement>(null), map=useRef<maplibregl.Map|null>(null);
  const [loaded,setLoaded]=useState(false),[error,setError]=useState('');
  const callbacks=useRef({roads,onToggle,onBounds});
  callbacks.current={roads,onToggle,onBounds};
  useEffect(()=>{
    if(!element.current)return;
    const m=new maplibregl.Map({container:element.current,bounds:overview[code],fitBoundsOptions:{padding:35},attributionControl:{compact:true},
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
  },[code]);
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
  const [roads,setRoads]=useState<Road[]>([]),[bounds,setBounds]=useState<number[]>([]),[dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [confirmed,setConfirmed]=useState(false),[reason,setReason]=useState('');
  const locked=saved?.state==='published';
  const adopt=(data:any)=>{
    setSaved(data);setForm(data?{...data.data,links:data.data.links.join('\n'),segments:data.selected}:empty());
    setDirty(false);setPreview(null);setConfirmed(false);
  };
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setRoads([]);setNotice('');setBounds([]);
    api(`/admin/local-routes/${code}`,'GET',undefined,controller.signal).then(data=>{
      if(!controller.signal.aborted)adopt(data);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[code]);
  const edit=(update:Partial<Form>)=>{setForm(current=>({...current,...update}));setDirty(true);setPreview(null);setConfirmed(false);};
  const toggle=(road:Road)=>{
    if(locked||busy||loading)return;
    edit({segments:form.segments.some(r=>r.id===road.id)?form.segments.filter(r=>r.id!==road.id):[...form.segments,road]});
  };
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const loadRoads=()=>act(async()=>{
    const data=await api(`/admin/local-routes/${code}/roads`,'POST',{bounds});
    setRoads(data.features.map((f:any)=>({...f,snapshotId:data.id})));setNotice(`${data.features.length} Vicmap road segments loaded.`);
  });
  const closeView=bounds.length===4&&bounds[2]-bounds[0]<=.045&&bounds[3]-bounds[1]<=.035;
  const save=()=>act(async()=>{
    const value=await api(`/admin/local-routes/${code}`,'PUT',{
      ...form,version:saved?.version||0,links:form.links.split('\n').map(x=>x.trim()).filter(Boolean),
      segments:form.segments.map(r=>({snapshotId:r.snapshotId,recordId:r.id}))
    });
    adopt(value);
    setPreview(await api(`/admin/local-routes/${code}/preview`,'POST',{}));
    setNotice('Draft saved. Preview is not public.');
  });
  const review=()=>act(async()=>{setPreview(await api(`/admin/local-routes/${code}/preview`,'POST',{}));});
  const publish=()=>act(async()=>{
    const value=await api(`/admin/local-routes/${code}/publish`,'POST',{version:preview.version,checksum:preview.checksum,confirmed:true});
    adopt(value);setNotice('Published as a partially resolved local contribution.');
  });
  const withdraw=()=>act(async()=>{
    const value=await api(`/admin/local-routes/${code}/withdraw`,'POST',{version:saved.version,reason});
    adopt(value);setReason('');setNotice('Publication withdrawn. Draft and archived revisions retained.');
  });
  return <section className="local-contributions">
    <div className="section-heading"><h2>Local route contributions</h2>
      <select aria-label="Contribution route" value={code} disabled={busy} onChange={e=>{
        if(!dirty||window.confirm('Discard unsaved changes to this contribution?'))setCode(e.target.value);
      }}><option value="20">Metropolitan Route 20</option><option value="22">Metropolitan Route 22</option></select></div>
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
        <ContributionMap code={code} roads={roads} selected={form.segments} preview={preview} onToggle={toggle} onBounds={setBounds}/>
        <div className="contribution-toolbar"><button type="button" className="secondary" title={closeView?'Load Vicmap road segments in this map view':'A closer map view is required'} disabled={busy||locked||!closeView} onClick={loadRoads}><MapPin size={16}/>Load visible roads</button>
          <span className="small muted">{form.segments.length} selected{!closeView?' · Overview scale':''}</span></div>
        <details open><summary>Selected segments ({form.segments.length})</summary>
          <div className="contribution-roads">{form.segments.map(r=><label key={r.id}><input type="checkbox" checked disabled={locked||busy} onChange={()=>toggle(r)}/><span>{r.properties.ezi_road_name||r.properties.ezi_road_name_label||'Unnamed road'}<small>PFI {r.properties.pfi}</small></span></label>)}</div>
        </details>
        <details><summary>Road segments in map view ({roads.length})</summary>
          <div className="contribution-roads">{roads.map(r=><label key={r.id}><input type="checkbox" checked={form.segments.some(s=>s.id===r.id)} disabled={locked||busy} onChange={()=>toggle(r)}/><span>{r.properties.ezi_road_name||r.properties.ezi_road_name_label||'Unnamed road'}<small>PFI {r.properties.pfi}</small></span></label>)}</div>
        </details>
      </div>
    </div>}
  </section>;
}
