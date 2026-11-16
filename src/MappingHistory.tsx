import { useEffect, useState } from 'react';
import { api, statusLabel, type Feature, type MetroReview, type ExtentEstimate } from './api';
import { MetroRouteReview } from './MetroRouteReview';

type Evidence = {
  sourceName?: string; sourceUrl?: string; sourceVersion?: string; attribution?: string;
  licence?: string; importId?: string; checksum?: string; objectId?: string; role?: string;
};
type History = {
  revisions: { id: string; created: string }[];
  revisionId?: string;
  lineage: {
    method?: string; description?: string; processorVersion?: string; status?: string; geometryType?: string;
    limitations: string[]; evidence?: Evidence[];
    routeReview?: MetroReview; routeSegments?: number;
    extent?: ExtentEstimate; areaKm2?: number; floorAreaKm2?: number;
    scaleSensitivity?: { intersectionOverUnion: number; scalesMetres: number[]; areaKm2: number[] };
    estimates?: { id: string; label: string; method: string; certainty: string; lengthKm: number; basis?: string; evidenceRecord?: string }[];
  } | null;
};

export function hasMappingHistory(feature: Feature) {
  const name = (feature.statePark?.officialName || feature.name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU');
  return (feature.type === 'state_park' && name === 'bunyip state park') ||
    (feature.type === 'river' && ['avoca', 'avoca river'].includes(name)) || !!evidencePilotKind(feature);
}

export function evidencePilotKind(feature: Feature) {
  if (feature.type === 'road_route' && feature.roadRoute?.code === '24' && feature.roadRoute.review) return 'route';
  if (feature.type === 'valley' && feature.name.trim().toLowerCase() === 'yarra valley' && feature.extentEstimate) return 'valley';
  return null;
}

export function MappingHistory({ featureId, onLocate }: { featureId: string; onLocate?: (point: [number, number]) => void }) {
  const [revision, setRevision] = useState('');
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : '';
    api<History>(`/features/${encodeURIComponent(featureId)}/provenance${query}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setHistory(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load mapping history.'); });
    return () => controller.abort();
  }, [featureId, revision, attempt]);
  const lineage = history?.revisionId === (revision || history?.revisions[0]?.id) ? history?.lineage : undefined;
  const sources = new Map<string, Evidence[]>();
  for (const record of lineage?.evidence || []) {
    const key = JSON.stringify([record.sourceName, record.sourceUrl, record.sourceVersion, record.importId]);
    const records = sources.get(key);
    if (records) records.push(record);
    else sources.set(key, [record]);
  }
  return <section className="detail-section">
    {!!history?.revisions.length && <label>Geometry revision
      <select value={revision || history.revisions[0].id} onChange={event => { setError(''); setRevision(event.target.value); }}>
        {history.revisions.map((item, index) => <option key={item.id} value={item.id}>
          {index === 0 ? 'Current' : `Revision ${history.revisions.length - index}`} · {new Date(item.created).toLocaleString()}
        </option>)}
      </select>
    </label>}
    {error ? <p role="alert">{error} <button type="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</button></p>
      : lineage === undefined ? <p role="status">Loading mapping history…</p>
      : lineage === null ? <p>Mapping history was not recorded.</p>
      : <>
        {history?.revisions[0].id !== history?.revisionId && <p className="muted small">Earlier revision. The map still shows the current geometry.</p>}
        <p>{lineage.description || lineage.method?.replaceAll('_', ' ') || 'Processing method not recorded.'}</p>
        {lineage.routeReview && <MetroRouteReview review={lineage.routeReview} segments={lineage.routeSegments ?? 0} onLocate={history?.revisions[0].id === history?.revisionId ? onLocate : undefined}/>}
        {lineage.extent && <section className="detail-section">
          <h3>{lineage.extent.label}</h3>
          <p className="small">{lineage.extent.scopeNote}</p>
          <p className="small muted">{lineage.extent.sourceScale}</p>
          <dl>
            {lineage.areaKm2 != null && <><dt>Estimated area</dt><dd>{lineage.areaKm2.toFixed(1)} km²</dd></>}
            {lineage.floorAreaKm2 != null && <><dt>Valley floor</dt><dd>{lineage.floorAreaKm2.toFixed(1)} km²</dd></>}
          </dl>
          {lineage.scaleSensitivity && <><h3>How much the outline changes</h3>
            <p className="small">Tested at {lineage.scaleSensitivity.scalesMetres.join(', ')} m. The estimates overlap by {Math.round(100 * lineage.scaleSensitivity.intersectionOverUnion)}%. This compares settings, not the chance that the boundary is correct.</p>
            <p className="small muted">Estimated area across settings: {lineage.scaleSensitivity.areaKm2.map(x => x.toFixed(1)).join(', ')} km².</p>
          </>}
          <a className="source-link" href={lineage.extent.evidenceUrl} target="_blank" rel="noreferrer">Geographic context</a>
        </section>}
        <dl><dt>Result</dt><dd>{lineage.status ? statusLabel(lineage.status) : 'Not recorded'}{lineage.geometryType && ` · ${lineage.geometryType}`}</dd>
          <dt>Processor</dt><dd>{lineage.processorVersion || 'Not recorded'}</dd></dl>
        <h3>Published inputs</h3>
        {!sources.size && <p>Source records were not recorded.</p>}
        {[...sources].map(([key, records]) => {
          const source = records[0];
          return <details key={key}><summary>{source.sourceName || 'Unnamed source'} · {records.length} records</summary>
            {source.sourceUrl && /^https?:\/\//i.test(source.sourceUrl) && <a className="source-link" href={source.sourceUrl} target="_blank" rel="noreferrer">Source dataset</a>}
            <p className="muted small">{[source.sourceVersion, source.licence, source.attribution].filter(Boolean).join(' · ') || 'Source metadata not recorded.'}</p>
            <pre>{JSON.stringify({ import: source.importId, checksum: source.checksum, records: records.map(record => ({ id: record.objectId, role: record.role })) }, null, 2)}</pre>
          </details>;
        })}
        {!!lineage.estimates?.length && <><h3>Dotted estimates</h3>
          <p className="muted small">These connections are not published routes and do not count towards the recorded length.</p>
          <ul>{lineage.estimates.map(estimate => <li key={estimate.id}>
            <strong>{estimate.label}</strong> · {estimate.lengthKm.toFixed(2)} km
            <div className="muted small">{[estimate.basis, estimate.evidenceRecord].filter(Boolean).join(' · ')}</div>
          </li>)}</ul>
        </>}
        {!!lineage.limitations.length && <><h3>Limitations</h3><ul>{lineage.limitations.map(note => <li key={note}>{note}</li>)}</ul></>}
      </>}
  </section>;
}
