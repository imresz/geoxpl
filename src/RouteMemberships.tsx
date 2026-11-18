import { useState } from 'react';
import { ChevronDown, MapPin } from 'lucide-react';
import './route-memberships.css';

type Evidence={kind?:string;sourceName?:string;sourceUrl?:string;sourceVersion?:string;licence?:string;attribution?:string;
  objectId?:string;importId?:string;checksum?:string;field?:string;value?:string;author?:string;basis?:string;
  observedAt?:string;statement?:string;uncertainty?:string;links?:string[];version?:number};
type Route={key:string;code:string;scheme:string;name:string};
type Membership={segmentKey:string;segmentId:string;recordId:string;route:Route;roadName:string;mappedKm:number;
  location:[number,number];geometryHash:string;basis:string;certainty:string;uncertainty:string[];
  geometryEvidence:Evidence;assignmentEvidence:Evidence[];sourceRoadTag?:string};
export type RouteMembershipReport={origin:string;recordedAt?:string;processorVersion?:string;coverage:{expected:number;indexed:number;unlinked:number}|null;
  claims:Membership[];limitations:string[];shared:null|{comparedAt:string;indexedRoutes:number;totalRoutes:number;
    groups:{featureId:string;revisionId:string;jobId:string;route:Route;
      sections:{segmentKey:string;geometryMatches:boolean;membership:Membership}[]}[]}};

const labels:Record<string,string>={published_assignment:'Published assignment',candidate:'Candidate membership',local_contribution:'Local contribution',
  published_tag:'Published source tag',reviewed_corridor:'Reviewed corridor',local_knowledge:'Local knowledge',
  observed_signs:'Observed roadside signs (unverified)',published_reference:'Contributed published reference'};
const sourceLink=(url?:string)=>url&&/^https:\/\//i.test(url);

function Claim({claim}:{claim:Membership}) {
  const geometry=claim.geometryEvidence;
  return <section className="membership-claim">
    <h4>{claim.route.name}</h4>
    <p className="small"><strong>{labels[claim.certainty] || claim.certainty}</strong> · {labels[claim.basis] || claim.basis}</p>
    {claim.assignmentEvidence.map((e,index)=><div key={index} className="membership-reference">
      {e.author&&<p className="small">Credit: {e.author}{e.observedAt&&` · Observed ${e.observedAt}`}{e.version!=null&&` · Contribution revision ${e.version}`}</p>}
      {e.statement&&<p className="small">{e.statement}</p>}
      {e.field&&<p className="small">Source assignment: <code>{e.field}={String(e.value)}</code></p>}
      {sourceLink(e.sourceUrl)&&<a className="source-link" href={e.sourceUrl} target="_blank" rel="noreferrer">{e.sourceName || 'Assignment reference'}</a>}
      {e.sourceVersion&&<p className="small muted">Source version: {e.sourceVersion}</p>}
      {e.links?.filter(sourceLink).map((url,i)=><a className="source-link" href={url} key={url} target="_blank" rel="noreferrer">Supporting reference {i+1}</a>)}
    </div>)}
    <ul className="membership-uncertainty">{claim.uncertainty.map(note=><li key={note}>{note}</li>)}</ul>
    {claim.sourceRoadTag&&claim.sourceRoadTag!==claim.route.code&&<p className="small muted">Source road tag: {claim.sourceRoadTag}. A different tag alone neither proves nor disproves concurrent signing.</p>}
    <details><summary>Road geometry evidence</summary>
      {sourceLink(geometry.sourceUrl)&&<a className="source-link" href={geometry.sourceUrl} target="_blank" rel="noreferrer">{geometry.sourceName || 'Geometry source'}</a>}
      <p className="small muted">{[geometry.sourceVersion,geometry.licence,geometry.attribution].filter(Boolean).join(' · ')}</p>
      <pre>{JSON.stringify({record:geometry.objectId,import:geometry.importId,checksum:geometry.checksum},null,2)}</pre>
    </details>
  </section>;
}

function SharedRoute({group,own,onLocate}:{group:NonNullable<RouteMembershipReport['shared']>['groups'][number];own:Map<string,Membership>;onLocate?:(point:[number,number])=>void}) {
  const [visible,setVisible]=useState(20),[open,setOpen]=useState(false);
  const exact=group.sections.filter(s=>s.geometryMatches).length;
  const differences=group.sections.length-exact;
  return <details className="shared-route" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{group.route.name}<small>{exact} shared {exact===1?'segment':'segments'}{differences>0&&` · ${differences} geometry-version ${differences===1?'difference':'differences'}`}</small></summary>
    {open&&<>
      <a className="source-link" href={`/?job=${encodeURIComponent(group.jobId)}`} target="_blank" rel="noreferrer">Open {group.route.name}</a>
      {group.sections.slice(0,visible).map(section=>{
        const selected=own.get(section.segmentKey)!;
        return <details className="shared-segment" key={section.segmentKey}>
          <summary>{selected.roadName}<small>Segment {selected.segmentId} · {selected.mappedKm.toFixed(2)} km{!section.geometryMatches&&' · Geometry differs'}</small></summary>
          {!section.geometryMatches&&<p className="warning small">Same source segment ID, but different saved coordinates. Not counted as a confirmed geometry overlap.</p>}
          {onLocate&&<button type="button" className="membership-locate" aria-label={`Locate segment ${selected.segmentId}`} title={`Locate ${selected.roadName}, segment ${selected.segmentId}`} onClick={()=>onLocate(selected.location)}><MapPin size={16}/></button>}
          <Claim claim={selected}/><Claim claim={section.membership}/>
        </details>;
      })}
      {visible<group.sections.length&&<button type="button" className="text-button" onClick={()=>setVisible(n=>n+20)}><ChevronDown size={15}/>More shared segments</button>}
    </>}
  </details>;
}

export function RouteMemberships({report,onLocate}:{report:RouteMembershipReport;onLocate?:(point:[number,number])=>void}) {
  const [showClaims,setShowClaims]=useState(false),[visible,setVisible]=useState(20);
  const own=new Map(report.claims.map(c=>[c.segmentKey,c]));
  return <section className="detail-section route-memberships">
    <h3>Shared road sections</h3>
    <p className="small">Overlapping catalogue alignments do not by themselves verify concurrent roadside signing. Each route's evidence and uncertainty remain separate.</p>
    {report.shared ? <>
      <p className="small muted">Current catalogue comparison · {report.shared.indexedRoutes}/{report.shared.totalRoutes} route revisions indexed.</p>
      {!report.shared.groups.length&&<p className="small">No shared source segment IDs found in the indexed catalogue. This does not establish that the route has no concurrency.</p>}
      {report.shared.groups.map(group=><SharedRoute key={group.featureId} group={group} own={own} onLocate={onLocate}/>)}
    </> : report.origin!=='not_indexed'&&<p className="small muted">Shared-section comparison is available for the current geometry only. The membership records below belong to this saved revision.</p>}
    {report.coverage&&<p className="small muted">{report.coverage.indexed}/{report.coverage.expected} segment memberships linked to saved inputs{report.coverage.unlinked>0&&` · ${report.coverage.unlinked} unlinked`}.</p>}
    {report.limitations.map(note=><p className="warning small" key={note}>{note}</p>)}
    {report.origin==='saved_inputs_backfill'&&<p className="small muted">Memberships recovered from retained inputs on {new Date(report.recordedAt!).toLocaleDateString()}. Original geometry revisions were not rewritten.</p>}
    <details onToggle={e=>setShowClaims(e.currentTarget.open)}><summary>Membership records ({report.claims.length})</summary>
      {showClaims&&<><p className="small muted">Membership processor: {report.processorVersion || 'Not recorded'}</p>{report.claims.slice(0,visible).map(claim=><details key={claim.segmentKey} className="shared-segment">
        <summary>{claim.roadName}<small>Segment {claim.segmentId} · {labels[claim.certainty] || claim.certainty}</small></summary><Claim claim={claim}/>
      </details>)}{visible<report.claims.length&&<button type="button" className="text-button" onClick={()=>setVisible(n=>n+20)}><ChevronDown size={15}/>More membership records</button>}</>}
    </details>
  </section>;
}
