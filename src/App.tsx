import { useEffect, useRef, useState } from 'react';
import { Compass, Search, ArrowUpRight, Waves, Mountain, Database, LoaderCircle, ArrowLeft, Check, Clock3, ShieldCheck, X, Info } from 'lucide-react';
import { MapView } from './MapView';
import { api, statusLabel, type Job, type Feature } from './api';
import { Admin } from './Admin';

export function Brand() { return <a className="brand" href="/"><span className="brand-symbol"><Compass size={23}/></span><span>Geo<span className="brand-accent">Xpl</span></span></a>; }
export function App() {
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [job, setJob] = useState<Job | null>(null), [waiting, setWaiting] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<Feature | null>(null), [tab, setTab] = useState('explore'), [catalogue, setCatalogue] = useState<Feature[]>([]), [elapsed, setElapsed] = useState(0);
  const active = useRef<AbortController | null>(null);
  const refreshCatalogue = () => api<Feature[]>('/catalogue').then(setCatalogue).catch(() => {});
  useEffect(() => { refreshCatalogue(); return () => active.current?.abort(); }, []);
  async function search(event?: React.FormEvent, requested?: { query: string; type: string }) {
    event?.preventDefault();
    const input = requested || { query, type }; if (!input.query.trim() || !input.type) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setError(''); setJob(null); setSelected(null); setWaiting(true); setTab('explore'); setElapsed(0);
    const start = performance.now();
    const timeout = window.setTimeout(() => controller.abort('budget'), 5000);
    const clock = window.setInterval(() => setElapsed(Math.min(5, (performance.now() - start) / 1000)), 100);
    try {
      let current = await api<Job>('/search', 'POST', input, controller.signal); setJob(current);
      while (current.status === 'pending' && performance.now() - start < 4900) {
        await new Promise(resolve => setTimeout(resolve, 450));
        if (controller.signal.aborted) break;
        current = await api<Job>(`/jobs/${current.id}`, 'GET', undefined, controller.signal); setJob(current);
      }
      if (current.status === 'resolved' && current.feature && !controller.signal.aborted) { setSelected(current.feature); refreshCatalogue(); }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { clearTimeout(timeout); clearInterval(clock); if (active.current === controller) { setWaiting(false); setElapsed(5); } }
  }
  if (location.pathname.startsWith('/admin')) return <Admin/>;
  return <div className="app-shell">
    <header className="topbar"><Brand/><nav aria-label="Main navigation"><button className={tab === 'explore' ? 'nav-active' : ''} onClick={() => setTab('explore')}>Explore</button><button className={tab === 'catalogue' ? 'nav-active' : ''} onClick={() => { setTab('catalogue'); refreshCatalogue(); }}>Catalogue <span className="nav-count">{catalogue.length}</span></button></nav><a className="admin-link" href="/admin"><ShieldCheck size={16}/><span>Administration</span><ArrowUpRight size={14}/></a></header>
    <form className="search-bar" onSubmit={search}>
      <label className="query-field"><Search size={20}/><input aria-label="Feature name" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a geographical feature" autoComplete="off" required minLength={2} maxLength={150}/>{query && <button type="button" className="clear-query" aria-label="Clear search" onClick={() => setQuery('')}><X size={16}/></button>}</label>
      <select aria-label="Feature type" required value={type} onChange={e => setType(e.target.value)}><option value="" disabled>Feature type</option><option value="river">River</option><option value="valley">Valley</option></select>
      <button className="primary search-submit" type="submit" disabled={waiting || !query.trim() || !type}>{waiting ? <LoaderCircle className="spin" size={18}/> : <Search size={18}/>}<span>{waiting ? 'Processing' : 'Search'}</span></button>
    </form>
    <main className="explorer">
      <aside className="feature-panel">
        <div className="panel-kicker"><span className="live-dot"/>VICTORIA & BEYOND</div>
        {tab === 'catalogue' ? <><div className="panel-title"><h1>Feature catalogue</h1><Database size={20}/></div><p className="muted small">{catalogue.length} resolved {catalogue.length === 1 ? 'feature' : 'features'}</p><div className="catalogue-list">{catalogue.map(f => <button key={f.id} onClick={async () => { setSelected(await api<Feature>(`/features/${f.id}`)); setTab('explore'); setJob(null); }}>{f.type === 'river' ? <Waves size={20}/> : <Mountain size={20}/>}<span><strong>{f.name}</strong><small>{f.type} · {f.lengthKm ? `${f.lengthKm.toFixed(1)} km` : `${f.areaKm2?.toFixed(1)} km²`}</small></span><ArrowUpRight size={16}/></button>)}</div>{!catalogue.length && <div className="empty-state"><Database size={30}/><h2>No processed features yet</h2><p>Completed features will appear here.</p></div>}</> : selected ? <>
          <button className="text-button back" onClick={() => { setSelected(null); setJob(null); }}><ArrowLeft size={15}/>Overview</button>
          <div className="feature-type">{selected.type === 'river' ? <Waves size={17}/> : <Mountain size={17}/>} {selected.type}</div>
          <h1 className="feature-name">{selected.name}</h1><span className={`badge ${selected.status === 'resolved' ? 'green' : 'amber'}`}>{statusLabel(selected.status)}</span>
          <div className="measure"><strong>{selected.lengthKm?.toFixed(1) || selected.areaKm2?.toFixed(1)}</strong><span>{selected.type === 'river' ? 'km of recorded watercourse' : 'km² recorded extent'}</span></div>
          {selected.warnings.map((w, i) => <p className="warning" key={i}><Info size={15}/>{w}</p>)}
          <div className="detail-section"><h2>Provenance</h2>{[...new Map(selected.evidence.map(e => [e.sourceId, e])).values()].map(e => <a key={e.sourceId} className="source-link" href={e.sourceUrl} target="_blank" rel="noreferrer"><span>{e.sourceName}<small>{e.licence}</small></span><ArrowUpRight size={16}/></a>)}<dl><dt>Source records</dt><dd>{selected.evidence.length}</dd><dt>Method</dt><dd>{selected.method.replaceAll('_', ' ')}</dd><dt>Processed</dt><dd>{new Date(selected.created).toLocaleDateString()}</dd></dl><details><summary>Processing evidence</summary><pre>{JSON.stringify({ id: selected.id, algorithm: selected.algorithmVersion, evidence: selected.evidence }, null, 2)}</pre></details></div>
        </> : <>
          <div className="panel-title"><h1>Explore geography</h1><Compass size={21}/></div><p className="muted">Rivers and valleys, in their full context.</p>
          {error && <p className="error" role="alert">{error}</p>}
          {(waiting || job) && <div className="search-result" role="status" aria-live="polite">
            <div className="result-symbol">{waiting ? <LoaderCircle className="spin" size={24}/> : job?.status === 'resolved' ? <Check size={24}/> : <Clock3 size={24}/>}</div>
            <h2>{job?.query || query}</h2><span className="feature-type">{job?.type || type}</span>
            <h3>{waiting ? 'Preparing your feature' : job?.status === 'resolved' ? 'Feature ready' : job?.status === 'failed' ? 'Processing interrupted' : 'Processing continues'}</h3>
            <p>{waiting ? 'Checking sources and assembling the geometry.' : job?.status === 'pending' ? 'Please try this search again later. Your request is saved.' : job?.message || 'Your request is being processed.'}</p>
            {waiting && <div className="progress-track"><span style={{ width: `${elapsed / 5 * 100}%` }}/></div>}
            {!waiting && job && <><span className="badge">{statusLabel(job.phase)}</span><button className="secondary full" onClick={() => search(undefined, { query: job.query, type: job.type })}>Check again</button></>}
            {!waiting && job?.feature && job.status !== 'resolved' && <button className="text-button" onClick={() => setSelected(job.feature)}>View available geometry<ArrowUpRight size={15}/></button>}
          </div>}
          {!waiting && !job && <><div className="overview-row"><Waves size={20}/><span>Rivers</span><span className="muted">Main-stem geometry</span></div><div className="overview-row"><Mountain size={20}/><span>Valleys</span><span className="muted">Published extents</span></div><div className="catalogue-summary"><span>PROCESSED CATALOGUE</span><strong>{catalogue.length.toString().padStart(2, '0')}</strong><p>{catalogue.length ? 'Features ready to explore' : 'No features stored yet'}</p></div></>}
        </>}
        <div className="panel-footer"><span className="boundary-swatch"/>Victoria boundary<span>01 / AU</span></div>
      </aside>
      <MapView feature={selected}/>
    </main>
    <footer className="app-footer"><span>GeoXpl <span className="footer-divider">/</span> Geographic exploration</span><span className="footer-right"><span className="live-dot"/>Local workspace</span></footer>
  </div>;
}
