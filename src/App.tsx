import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Route, Search, ArrowUpRight, Waves, Mountain, Trees, Database, LoaderCircle, ArrowLeft, Check, Clock3, ShieldCheck, X, Info } from 'lucide-react';
import { MapView } from './MapView';
import { MetroRouteReview } from './MetroRouteReview';
import './metro-review.css';
import { api, statusLabel, featureLabel, type Job, type Feature, type FeatureSummary, type Interpolation } from './api';
import { Admin } from './Admin';
import { evidencePilotKind, hasMappingHistory, MappingHistory } from './MappingHistory';
import './catalogue.css';

export function Brand() { return <a className="brand" href="/"><span className="brand-symbol"><Compass size={23}/></span><span>Geo<span className="brand-accent">Xpl</span></span></a>; }
const FeatureIcon = ({type}:{type:string}) => type==='road_route'?<Route size={20}/>:type==='river'?<Waves size={20}/>:['national_park','state_forest','state_park'].includes(type)?<Trees size={20}/>:<Mountain size={20}/>;
export function App() {
  type SearchInput = { query: string; type: string; confirmType?: boolean };
  type SearchAlternative = { query: string; type: string; saved: boolean };
  const typeLabel = (value: string) => statusLabel(value).replace(/\b\w/g, letter => letter.toUpperCase());
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [job, setJob] = useState<Job | null>(null), [waiting, setWaiting] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<Feature | null>(null), [tab, setTab] = useState('explore'), [catalogue, setCatalogue] = useState<FeatureSummary[]>([]), [elapsed, setElapsed] = useState(0);
  const [loadingFeature, setLoadingFeature] = useState<string | null>(null);
  const [typePrompt, setTypePrompt] = useState<{ input: SearchInput; alternatives: SearchAlternative[] } | null>(null);
  const [catalogueType,setCatalogueType]=useState('all');
  const visibleCatalogue=catalogue.filter(f=>catalogueType==='all'||f.type===catalogueType);
  const plmExtent=selected?.statePark||selected?.forest;
  const evidencePilot = selected && evidencePilotKind(selected);
  const active = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [selected?.id, job?.id, job?.selectionRequired, tab, typePrompt]);
  const [showNetwork, setShowNetwork] = useState(false);
  const [showFloor, setShowFloor] = useState(false);
  const [focusedEstimate, setFocusedEstimate] = useState<Interpolation | null>(null);
  const [reviewFocus, setReviewFocus] = useState<[number, number] | null>(null);
  useEffect(() => { setShowNetwork(false); setShowFloor(false); setFocusedEstimate(null); setReviewFocus(null); }, [selected]);
  const displayedFeature = useMemo(() => selected && showNetwork && selected.recordedNetwork ? { ...selected, geometry: selected.recordedNetwork.geometry, bbox: selected.recordedNetwork.bbox, displayBbox: selected.recordedNetwork.bbox, interpolations: undefined } : selected && showFloor && selected.valleyFloor ? { ...selected, ...selected.valleyFloor, displayBbox: selected.valleyFloor.bbox } : selected, [selected, showNetwork, showFloor]);
  const refreshCatalogue = () => api<FeatureSummary[]>('/catalogue?status=all').then(setCatalogue).catch(() => {});
  useEffect(() => { refreshCatalogue(); return () => active.current?.abort(); }, []);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('job');
    if (!id) return;
    const controller = new AbortController(); active.current = controller;
    api<Job>(`/jobs/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal).then(current => {
      if (controller.signal.aborted) return;
      setQuery(current.query); setType(current.type); setJob(current);
      if (current.feature && !current.selectionRequired) setSelected(current.feature);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  async function selectFeature(id: string, fromCatalogue = false) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setError(''); setTypePrompt(null); setLoadingFeature(id); setWaiting(false);
    try {
      const feature = await api<Feature>(`/features/${id}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) { setSelected(feature); setTab('explore'); if (fromCatalogue) setJob(null); }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (active.current === controller) setLoadingFeature(null); }
  }
  async function search(event?: React.FormEvent, requested?: SearchInput) {
    event?.preventDefault();
    const input = requested || { query, type }; if (!input.query.trim() || !input.type) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setError(''); setTypePrompt(null); setJob(null); setSelected(null); setLoadingFeature(null); setWaiting(true); setTab('explore'); setElapsed(0);
    const start = performance.now();
    const timeout = window.setTimeout(() => controller.abort('budget'), 5000);
    const clock = window.setInterval(() => setElapsed(Math.min(5, (performance.now() - start) / 1000)), 100);
    try {
      const response = await api<Job | { alternatives: SearchAlternative[] }>('/search', 'POST', input, controller.signal);
      if (controller.signal.aborted) return;
      if ('alternatives' in response) { setTypePrompt({ input, alternatives: response.alternatives }); return; }
      let current = response; setJob(current);
      while (current.status === 'pending' && performance.now() - start < 4900) {
        await new Promise(resolve => setTimeout(resolve, 450));
        if (controller.signal.aborted) break;
        current = await api<Job>(`/jobs/${current.id}`, 'GET', undefined, controller.signal); setJob(current);
      }
      if (current.feature && !current.selectionRequired && (current.status === 'resolved' || current.feature.roadRoute || current.feature.interpolations?.features.length || current.feature.extentEstimate) && !controller.signal.aborted) setSelected(current.feature);
      if (!controller.signal.aborted) refreshCatalogue();
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { clearTimeout(timeout); clearInterval(clock); if (active.current === controller) { setWaiting(false); setElapsed(5); } }
  }
  if (location.pathname.startsWith('/admin')) return <Admin/>;
  return <div className="app-shell">
    <header className="topbar"><Brand/><nav aria-label="Main navigation"><button className={tab === 'explore' ? 'nav-active' : ''} onClick={() => setTab('explore')}>Explore</button><button className={tab === 'catalogue' ? 'nav-active' : ''} onClick={() => { setTab('catalogue'); refreshCatalogue(); }}>Catalogue <span className="nav-count">{catalogue.length}</span></button></nav><a className="admin-link" href="/admin"><ShieldCheck size={16}/><span>Administration</span><ArrowUpRight size={14}/></a></header>
    <form className="search-bar" onSubmit={search}>
      <label className="query-field"><Search size={20}/><input aria-label="Feature name" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a geographical feature" autoComplete="off" required minLength={2} maxLength={150}/>{query && <button type="button" className="clear-query" aria-label="Clear search" onClick={() => setQuery('')}><X size={16}/></button>}</label>
      <select aria-label="Feature type" required value={type} onChange={e => setType(e.target.value)}><option value="" disabled>Feature type</option><option value="river">River</option><option value="valley">Valley</option><option value="national_park">National Park</option><option value="state_forest">State Forest</option><option value="state_park">State Park</option><option value="road_route">Road Route</option></select>
      <button className="primary search-submit" type="submit" disabled={waiting || !query.trim() || !type}>{waiting ? <LoaderCircle className="spin" size={18}/> : <Search size={18}/>}<span>{waiting ? 'Processing' : 'Search'}</span></button>
    </form>
    <main className="explorer">
      <aside className="feature-panel" ref={panel}>
        <div className="panel-kicker"><span className="live-dot"/>VICTORIA & BEYOND</div>
        {error && <p className="error" role="alert">{error}</p>}
        {tab === 'catalogue' ? <><div className="panel-title"><h1>Feature catalogue</h1><Database size={20}/></div><p className="muted small">{catalogue.length} saved {catalogue.length === 1 ? 'feature' : 'features'}</p><select aria-label="Catalogue feature type" value={catalogueType} onChange={e=>setCatalogueType(e.target.value)}><option value="all">All feature types</option><option value="river">Rivers</option><option value="valley">Valleys</option><option value="national_park">National parks</option><option value="state_forest">State forests</option><option value="state_park">State parks</option><option value="road_route">Road routes</option></select>
          {catalogue.length ? [{status:'resolved',title:'Resolved'},{status:'partially_resolved',title:'Partially resolved'}].map(group => {
            const features = visibleCatalogue.filter(f => f.status === group.status).sort((a,b) => featureLabel(a).localeCompare(featureLabel(b)));
            return <section className="catalogue-group" key={group.status} aria-label={`${group.title} features`}><h2>{group.title}<span className={`badge ${group.status === 'resolved' ? 'green' : 'amber'}`}>{features.length}</span></h2>
              <div className="catalogue-list">{features.map(f => <button key={f.id} disabled={!!loadingFeature} onClick={() => selectFeature(f.id, true)}><FeatureIcon type={f.type}/><span><strong>{featureLabel(f)}</strong><small>{statusLabel(f.type)} · {f.type === 'road_route' ? 'Victorian snapshot' : f.lengthKm != null ? `${f.lengthKm.toFixed(1)} km` : f.areaKm2 != null ? `${f.areaKm2.toFixed(1)} km²${f.extentEstimate ? ' estimated' : ''}` : 'Measurement unavailable'}</small>{f.extentEstimate && <small>{f.extentEstimate.label}</small>}</span>{loadingFeature === f.id ? <LoaderCircle className="spin" size={16}/> : <ArrowUpRight size={16}/>}</button>)}</div>
              {!features.length && <p className="muted small">No {group.title.toLowerCase()} features yet.</p>}
            </section>;
          }) : <div className="empty-state"><Database size={30}/><h2>No processed features yet</h2><p>Saved features will appear here.</p></div>}
        </> : typePrompt && typePrompt.input.query === query && typePrompt.input.type === type ? <section className="detail-section" aria-labelledby="type-prompt-title">
          <h2 id="type-prompt-title">Check the name or feature type</h2>
          <p role="status">You entered “{typePrompt.input.query.trim()}” and selected {typeLabel(typePrompt.input.type)}.</p>
          <div className="catalogue-list">{typePrompt.alternatives.map(option => <button key={`${option.type}:${option.query}`} type="button" onClick={() => {
            setQuery(option.query); setType(option.type); void search(undefined, { query: option.query, type: option.type, confirmType: true });
          }}><FeatureIcon type={option.type}/><span><strong>{option.query} ({typeLabel(option.type)})</strong><small>{option.saved ? 'Saved feature match' : 'Suggested by the name'}</small></span><ArrowUpRight size={16}/></button>)}</div>
          <button className="secondary full" type="button" onClick={() => void search(undefined, { ...typePrompt.input, confirmType: true })}>Continue as {typeLabel(typePrompt.input.type)}</button>
        </section> : selected ? <>
          <button className="text-button back" onClick={() => { setSelected(null); if (!job?.selectionRequired) setJob(null); }}><ArrowLeft size={15}/>{job?.selectionRequired ? 'Matching features' : 'Overview'}</button>
          <div className="feature-type"><FeatureIcon type={selected.type}/> {statusLabel(selected.type)}</div>
          <h1 className="feature-name">{featureLabel(selected)}</h1><span className={`badge ${selected.status === 'resolved' ? 'green' : 'amber'}`}>{statusLabel(selected.status)}</span>
          {selected.recordedNetwork && <div className="geometry-modes" role="group" aria-label="River geometry"><button aria-pressed={!showNetwork} onClick={() => setShowNetwork(false)}>Main-stem candidate</button><button aria-pressed={showNetwork} onClick={() => setShowNetwork(true)}>Named network</button></div>}
          {selected.valleyFloor && <div className="geometry-modes" role="group" aria-label="Valley geometry"><button aria-pressed={!showFloor} onClick={() => setShowFloor(false)}>Terrain extent</button><button aria-pressed={showFloor} onClick={() => setShowFloor(true)}>Valley floor</button></div>}
          {!evidencePilot && displayedFeature?.extentEstimate && <div className="detail-section"><h2>{displayedFeature.extentEstimate.label}</h2><p className="muted small">{displayedFeature.extentEstimate.scopeNote}</p><a className="source-link" href={displayedFeature.extentEstimate.evidenceUrl} target="_blank" rel="noreferrer">Geographic context<ArrowUpRight size={16}/></a></div>}
          {!selected.roadRoute && <div className="measure"><strong>{(showNetwork ? selected.recordedNetwork?.lengthKm : selected.lengthKm)?.toFixed(1) || displayedFeature?.areaKm2?.toFixed(1)}</strong><span>{selected.type === 'river' ? selected.method === 'geofabric_directed_main_stem' ? 'km of BoM modelled flow path' : selected.mainStem?.status === 'candidate' && !showNetwork ? 'km of unverified candidate' : 'km of recorded watercourse' : selected.extentEstimate ? displayedFeature?.extentEstimate?.kind === 'terrain_valley' ? 'km² estimated valley extent' : 'km² estimated valley floor' : 'km² recorded extent'}</span></div>}
          {!evidencePilot && displayedFeature?.extentEstimate && <p className="muted small">{displayedFeature.extentEstimate.sourceScale}</p>}
          {selected.mainStem?.limitations && <details className="candidate-limits"><summary>{selected.mainStem.status === 'candidate' ? 'Candidate limitations' : 'Dataset limitations'}</summary>{selected.mainStem.limitations.map((text, i) => <p className="muted small" key={i}>{text}</p>)}</details>}
          {selected.park&&<div className="detail-section"><h2>Published park boundary</h2><dl><dt>Edition</dt><dd>{selected.park.edition}</dd><dt>Boundary snapshot</dt><dd>{selected.park.boundaryDate}</dd><dt>Park identifier</dt><dd>{selected.park.paId}</dd><dt>Classification</dt><dd>{selected.park.designation}</dd></dl>{selected.park.limitations.map((text,i)=><p className="muted small" key={i}>{text}</p>)}</div>}
          {!evidencePilot && selected.roadRoute?.review && <MetroRouteReview review={selected.roadRoute.review} segments={selected.roadRoute.segments} onLocate={point => setReviewFocus([...point])}/>}
          {selected.roadRoute && !selected.roadRoute.review && !selected.roadRoute.contribution && <div className="detail-section"><h2>Victorian route snapshot</h2><dl><dt>Tagged segments</dt><dd>{selected.roadRoute.segments}</dd>{!selected.roadRoute.topologyUnavailable && <><dt>Connected groups</dt><dd>{selected.roadRoute.components}</dd><dt>Largest group</dt><dd>{selected.roadRoute.largestComponent} segments</dd><dt>Records with unverified junctions</dt><dd>{selected.roadRoute.unverified}</dd></>}<dt>Snapshot retrieved</dt><dd>{new Date(selected.roadRoute.retrievedAt).toLocaleDateString()}</dd></dl><p className="muted small">{selected.roadRoute.mappedKm.toFixed(1)} km of tagged lines, including parallel carriageways. Not a driving distance.</p><details><summary>Road names</summary><ul>{selected.roadRoute.names.map(name => <li key={name}>{name}</li>)}</ul></details></div>}
          {plmExtent&&<div className="detail-section"><h2>{selected.type==='state_park'?'Published state-park parcels':'Published state-forest parcels'}</h2><dl><dt>Dataset</dt><dd>{plmExtent.dataset}</dd><dt>Mapping scale</dt><dd>{plmExtent.scale}</dd><dt>Source parcels</dt><dd>{plmExtent.parcelCount}</dd><dt>Record versions</dt><dd>{plmExtent.sourceVersionDates.length?`${plmExtent.sourceVersionDates[0].slice(0,10)}${plmExtent.sourceVersionDates.length>1?` to ${plmExtent.sourceVersionDates.at(-1)!.slice(0,10)}`:''}`:'Not supplied'}</dd></dl>{plmExtent.limitations.map((text,i)=><p className="muted small" key={i}>{text}</p>)}</div>}
          {!!selected.interpolations?.features.length && !showNetwork && <div className="detail-section estimated-connections"><h2>Interpolated connections</h2><p className="muted small">Approximate paths. Excluded from recorded measurements.</p>{selected.interpolations.features.some(f => f.properties.alternativeGroup) && <p className="muted small">Upstream alternatives are possibilities, not a chosen route.</p>}{selected.interpolations.features.map(gap => <button key={gap.properties.id} className="estimate-focus" title={`Show ${gap.properties.label} on map`} onClick={() => setFocusedEstimate({ ...gap })}><span className="legend-interpolated"/><span>{gap.properties.label}<small>{gap.properties.lengthKm.toFixed(2)} km estimated</small></span><ArrowUpRight size={15}/></button>)}</div>}
          {selected.interpolationSummary?.notes.map((note, i) => <p key={`interpolation-${i}`} className="warning"><Info size={15}/>{note}</p>)}
          {(selected.source || selected.mouth) && <div className="detail-section"><h2>Network endpoints</h2>{[selected.source, selected.mouth].filter(Boolean).map(endpoint => endpoint && <div className="network-endpoint" key={endpoint.nodeId}><span className={`endpoint-dot ${endpoint === selected.mouth ? 'outlet' : ''}`}/><span><strong>{endpoint.classification}</strong>{endpoint.receivingRiver && <small>{endpoint.joiningRiver ? `Forms ${endpoint.receivingRiver} with ${endpoint.joiningRiver}` : `Joins ${endpoint.receivingRiver}`}</small>}<small>{endpoint.coordinates[1].toFixed(5)}, {endpoint.coordinates[0].toFixed(5)}</small>{endpoint.namingEvidenceUrl && <a className="source-link" href={endpoint.namingEvidenceUrl} target="_blank" rel="noreferrer">Naming evidence<ArrowUpRight size={14}/></a>}</span></div>)}</div>}
          {!evidencePilot && selected.warnings.map((w, i) => <p className="warning" key={i}><Info size={15}/>{w}</p>)}
          {evidencePilot === 'route' && <p className="warning"><Info size={15}/>{selected.roadRoute?.contribution ? `Community-supported alignment · ${selected.roadRoute.contribution.author}. Current signing and permitted turns remain unverified.` : 'Road alignment matched. Current signing, turns and endpoints are not fully verified.'}</p>}
          {evidencePilot === 'valley' && <p className="warning"><Info size={15}/>{displayedFeature?.extentEstimate?.kind === 'terrain_valley' ? 'Terrain estimate. The outer edge varies with scale and is not an official or tourism-region boundary.' : 'Valley-floor estimate only. It does not show the full valley or its bounding slopes.'}</p>}
          {evidencePilot ? <details className="detail-section mapping-disclosure"><summary>How this was mapped</summary>
            <MappingHistory key={`${selected.id}:${selected.created}`} featureId={selected.id} onLocate={point => setReviewFocus([...point])}/>
          </details> : hasMappingHistory(selected) && <div className="detail-section"><h2>How this was mapped</h2><MappingHistory key={`${selected.id}:${selected.created}`} featureId={selected.id}/></div>}
          {!evidencePilot && <div className="detail-section"><h2>Provenance</h2>{selected.evidence.filter((e, i, all) => all.findIndex(other => other.sourceId === e.sourceId) === i).map(e => <a key={e.sourceId} className="source-link" href={e.sourceUrl} target="_blank" rel="noreferrer"><span>{e.sourceName}<small>{e.licence}</small>{selected.extentEstimate && <small>{e.attribution}</small>}</span><ArrowUpRight size={16}/></a>)}<dl><dt>Source records</dt><dd>{selected.evidence.length}</dd><dt>Method</dt><dd>{selected.method.replaceAll('_', ' ')}</dd><dt>Processed</dt><dd>{new Date(selected.created).toLocaleDateString()}</dd></dl><details><summary>Processing evidence</summary><pre>{JSON.stringify({ id: selected.id, algorithm: selected.algorithmVersion, extentEstimate: selected.extentEstimate, principalDrainage: selected.principalDrainage, terrain: selected.terrain, identity: selected.identity, selection: selected.selection, mainStem: selected.mainStem, source: selected.source, mouth: selected.mouth, evidence: selected.evidence, interpolations: selected.interpolations, interpolationSummary: selected.interpolationSummary }, null, 2)}</pre></details></div>}
        </> : job?.selectionRequired && !waiting ? <section className="matching-features" aria-label="Matching features">
          <div className="panel-title"><h1>{job.query}</h1></div>
          <p className="muted small" role="status">{job.matches.length} matching features. Choose a location.</p>
          <div className="catalogue-list">{job.matches.map(f => <button key={f.id} disabled={!!loadingFeature} onClick={() => selectFeature(f.id)}><FeatureIcon type={f.type}/><span><strong>{featureLabel(f)}</strong><small>{f.locationDescription}</small><small>{f.lengthKm != null ? `${f.lengthKm.toFixed(1)} km recorded` : `${f.areaKm2?.toFixed(1)} km² recorded`}</small><span className={`badge ${f.status === 'resolved' ? 'green' : 'amber'}`}>{statusLabel(f.status)}</span></span>{loadingFeature === f.id ? <LoaderCircle className="spin" size={16}/> : <ArrowUpRight size={16}/>}</button>)}</div>
        </section> : <>
          <div className="panel-title"><h1>Explore geography</h1><Compass size={21}/></div><p className="muted">Rivers and valleys, in their full context.</p>
          {(waiting || job) && <div className="search-result" role="status" aria-live="polite">
            <div className="result-symbol">{waiting ? <LoaderCircle className="spin" size={24}/> : job?.status === 'resolved' ? <Check size={24}/> : job&&['no_match','wrong_feature_type','import_failed','source_unavailable'].includes(job.status)?<Info size={24}/>:<Clock3 size={24}/>}</div>
            <h2>{job?.query || query}</h2><span className="feature-type">{statusLabel(job?.type || type)}</span>
            <h3>{waiting ? 'Preparing your feature' : job&&['no_match','wrong_feature_type','import_failed','source_unavailable'].includes(job.status)?statusLabel(job.status):job?.status === 'resolved' ? 'Feature ready' : job?.status === 'failed' ? 'Processing interrupted' : job?.phase === 'awaiting_data' ? 'Needs geographic evidence' : job?.phase === 'awaiting_review' ? 'Awaiting review' : 'Processing continues'}</h3>
            <p>{waiting ? 'Checking sources and assembling the geometry.' : job?.status === 'pending' ? 'Please try this search again later. Your request is saved.' : job?.message || 'Your request is being processed.'}</p>
            {waiting && <div className="progress-track"><span style={{ width: `${elapsed / 5 * 100}%` }}/></div>}
            {!waiting && job && <><span className="badge">{statusLabel(job.phase)}</span><button className="secondary full" onClick={() => search(undefined, { query: job.query, type: job.type })}>Check again</button></>}
            {!waiting && job?.feature && job.status !== 'resolved' && <button className="text-button" onClick={() => setSelected(job.feature)}>{job.feature.mainStem?.status === 'candidate' ? 'View main-stem candidate' : 'View available geometry'}<ArrowUpRight size={15}/></button>}
          </div>}
          {!waiting && !job && <><div className="overview-row"><Waves size={20}/><span>Rivers</span><span className="muted">Main-stem geometry</span></div><div className="overview-row"><Mountain size={20}/><span>Valleys</span><span className="muted">Estimated extents</span></div><div className="catalogue-summary"><span>PROCESSED CATALOGUE</span><strong>{catalogue.length.toString().padStart(2, '0')}</strong><p>{catalogue.length ? 'Features ready to explore' : 'No features stored yet'}</p></div></>}
        </>}
        <div className="panel-footer"><span className="boundary-swatch"/>Victoria boundary<span>01 / AU</span></div>
      </aside>
      <MapView feature={displayedFeature} focus={showNetwork ? null : focusedEstimate} reviewFocus={reviewFocus}/>
    </main>
    <footer className="app-footer"><span>GeoXpl <span className="footer-divider">/</span> Geographic exploration</span><span className="footer-right"><span className="live-dot"/>Local workspace</span></footer>
  </div>;
}
