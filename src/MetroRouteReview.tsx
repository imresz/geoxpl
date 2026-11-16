import { ArrowUpRight, MapPin } from 'lucide-react';
import type { MetroReview } from './api';

export function MetroRouteReview({ review, segments, onLocate }: {
  review: MetroReview; segments: number; onLocate: (point: [number, number]) => void;
}) {
  return <section className="detail-section">
    <h2>Matched Vicmap alignment</h2>
    <p className="small muted">{segments} connected road segments matched to the 2015 corridor. Current signing is unverified.</p>
    <a className="source-link" href={review.baseline} target="_blank" rel="noreferrer">2015 VicRoads route maps<ArrowUpRight size={15}/></a>
    <h3>Needs verification</h3>
    <ul className="metro-checks">
      {review.checks.map(({ kind, node, label, note, evidenceUrl, coordinates }) => <li key={node}>
        <button className="text-button" type="button" onClick={() => onLocate(coordinates)} aria-label={`Locate ${label} on map`}><MapPin size={15}/>{label}</button>
        <span className="badge amber">{kind === 'endpoint' ? 'Endpoint' : 'Turn or transition'}</span>
        <p className="small muted">{note}</p>
        {evidenceUrl && <a className="source-link" href={evidenceUrl} target="_blank" rel="noreferrer">Junction evidence<ArrowUpRight size={15}/></a>}
      </li>)}
    </ul>
    <h3>Current signage</h3>
    <p className="small muted">{review.signage}</p>
    {!!review.codes.length && <dl>{review.codes.map(({ code, count }) => <div key={code} className="metro-code"><dt>{code}</dt><dd>{count} segments</dd></div>)}</dl>}
    {review.signageUrl && <a className="source-link" href={review.signageUrl} target="_blank" rel="noreferrer">Signage evidence<ArrowUpRight size={15}/></a>}
  </section>;
}
