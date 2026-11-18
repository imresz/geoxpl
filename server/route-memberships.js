import { createHash } from 'node:crypto';
import { length, multiLineString } from '@turf/turf';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lines = geometry => geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
const lineHash = line => {
  const forward=JSON.stringify(line), reverse=JSON.stringify([...line].reverse());
  return digest(forward < reverse ? forward : reverse);
};
const https = value => typeof value === 'string' && /^https:\/\//i.test(value);
const unique = values => [...new Set(values.filter(Boolean))];

export function routeIdentity(feature) {
  const code=String(feature.roadRoute?.code || '').trim().toUpperCase();
  const name=feature.name || feature.displayName || code;
  const metro=/^(?:local|vicmap):metro-route:/.test(feature.identityKey || '') || /^Metropolitan Route /i.test(name);
  const scheme=metro ? 'metropolitan' : /^[MABC]\d{1,3}$/.test(code) ? 'alphanumeric' : /^Numbered Route /i.test(name) ? 'unconfirmed_numeric' : 'other';
  return {key:scheme==='other' ? `vic:other:${feature.identityKey || name}` : `vic:${scheme}:${code}`,
    code,scheme,name:feature.displayName || name};
}

function assignment(feature, record, evidence) {
  const route=routeIdentity(feature), contribution=feature.roadRoute?.contribution;
  const geometryEvidence={...evidence};
  const common={route,geometryEvidence,uncertainty:unique(feature.warnings || [])};
  if(feature.method==='local_knowledge_vicmap_match' && contribution) {
    const note=feature.roadRoute.membershipNotes?.find(n=>n.pfi===record.properties.pfi);
    return {...common,basis:contribution.basis,certainty:'local_contribution',
      assignmentEvidence:[{kind:'local_contribution',...contribution},...(note ? [{kind:'section_note',author:contribution.author,
        observedAt:contribution.observedAt,statement:note.statement,uncertainty:note.uncertainty,links:note.links}] : [])],
      uncertainty:unique([...common.uncertainty,contribution.uncertainty,note?.uncertainty,
        'Local evidence does not independently verify current route signing or permitted turns.'])};
  }
  if(feature.method==='vicmap_2015_metro_corridor_match' && https(feature.roadRoute?.review?.baseline)) {
    const review=feature.roadRoute.review;
    return {...common,basis:'reviewed_corridor',certainty:'candidate',
      assignmentEvidence:[{kind:'reviewed_reference',sourceName:'VicRoads metropolitan route maps (2015)',sourceUrl:review.baseline,
        sourceId:review.referenceSourceId,statement:'Reviewed corridor matched to these Vicmap road records.'}],
      uncertainty:unique([...common.uncertainty,review.signage,'Candidate membership; current signed concurrency has not been verified.'])};
  }
  const field=feature.method==='vicmap_exact_route_code' ? 'route_no' : feature.method==='dtp_exact_srns_code' ? 'SRNS' : null;
  if(field && String(record.properties?.[field] || '').trim().toUpperCase()===route.code) {
    return {...common,basis:'published_tag',certainty:'published_assignment',
      assignmentEvidence:[{kind:'source_field',...evidence,field,value:record.properties[field]}],
      uncertainty:unique([...common.uncertainty,'Published route assignment; present-day signs and permitted turns were not independently checked.'])};
  }
  return null;
}

// A membership is an assignment claim, not ownership of a road or certification of signing.
export function recoverRouteMemberships(db, feature) {
  const claims=[], missing=[], imports=new Map(), keys=new Set();
  const mapped=new Set(lines(feature.geometry).map(lineHash));
  const records=feature.evidence || [];
  for(const evidence of records) {
    if(!imports.has(evidence.importId)) {
      const row=db.prepare('SELECT payload,metadata FROM imports WHERE id=?').get(evidence.importId || '');
      let imported=null;
      try {
        const payload=row && JSON.parse(row.payload), metadata=row && JSON.parse(row.metadata);
        if(Array.isArray(payload?.features)) imported={metadata,records:new Map(payload.features.map(f=>[String(f.id),f]))};
      } catch { /* Older incomplete snapshots remain explicitly unlinked. */ }
      imports.set(evidence.importId,imported);
    }
    const imported=imports.get(evidence.importId), record=imported?.records.get(String(evidence.objectId));
    const parts=lines(record?.geometry);
    const valid=parts.length && parts.every(line=>Array.isArray(line) && line.length>=2 && line.every(c=>
      Array.isArray(c)&&c.length===2&&c.every(Number.isFinite))) && parts.every(line=>mapped.has(lineHash(line)));
    if(!valid) {missing.push(evidence.objectId);continue;}
    const p=record.properties || {};
    const vicmap=/^tr_road\./.test(record.id) && Number.isSafeInteger(p.pfi) && p.pfi>0;
    const dtp=feature.method==='dtp_exact_srns_code' && imported.metadata?.adapter==='dtp-srns-snapshot/1' && Number.isSafeInteger(p.OBJECTID);
    const segmentKey=vicmap ? `vicmap:tr_road:${p.pfi}` : dtp ? `dtp:managed-road:${p.OBJECTID}` : null;
    const claim=segmentKey && assignment(feature,record,evidence);
    if(!claim || keys.has(segmentKey) || (evidence.pfi!==undefined && evidence.pfi!==p.pfi)) {missing.push(evidence.objectId);continue;}
    keys.add(segmentKey);
    const coords=parts.flat(), first=parts[0];
    const bounds=coords.reduce((b,c)=>[Math.min(b[0],c[0]),Math.min(b[1],c[1]),Math.max(b[2],c[0]),Math.max(b[3],c[1])],[Infinity,Infinity,-Infinity,-Infinity]);
    claims.push({...claim,segmentKey,segmentId:String(vicmap ? p.pfi : p.OBJECTID),recordId:String(record.id),
      roadName:p.ezi_road_name || p.ezi_road_name_label || [p.RD_NAME,p.RD_TYPE].filter(Boolean).join(' ') || 'Unnamed road',
      geometryHash:digest(parts.map(lineHash).sort()),mappedKm:length(multiLineString(parts)),
      location:first[Math.floor(first.length/2)],
      bbox:bounds,
      sourceRoadTag:p.route_no || p.SRNS || null});
  }
  const expected=Math.max(records.length,feature.roadRoute?.segments || 0);
  return {claims,processorVersion:'route-memberships/1',coverage:{expected,indexed:claims.length,unlinked:Math.max(0,expected-claims.length)},
    limitations:claims.length<expected ? ['Some saved route records could not be linked to retained source geometry and an explicit assignment. They are excluded from shared-section comparisons.'] : []};
}

export function indexRouteRevision(db, revisionId, origin='publication') {
  if(db.prepare('SELECT 1 FROM route_membership_revisions WHERE revision_id=?').get(revisionId)) return false;
  const row=db.prepare('SELECT feature_id,data FROM derivations WHERE id=?').get(revisionId);
  if(!row) throw Error('Geometry revision not found.');
  const feature=JSON.parse(row.data);
  if(feature.type!=='road_route' || !feature.roadRoute) return false;
  const {claims,...summary}=recoverRouteMemberships(db,feature), created=new Date().toISOString();
  db.prepare('INSERT INTO route_membership_revisions VALUES(?,?,?,?,?)').run(revisionId,row.feature_id,origin,JSON.stringify(summary),created);
  const insert=db.prepare('INSERT INTO route_memberships VALUES(?,?,?,?,?,?)');
  for(const claim of claims) insert.run(revisionId,row.feature_id,claim.segmentKey,claim.geometryHash,JSON.stringify(claim),created);
  return true;
}

export function routeMembershipReport(db, featureId, revisionId) {
  const row=db.prepare('SELECT * FROM route_membership_revisions WHERE revision_id=? AND feature_id=?').get(revisionId,featureId);
  if(!row) return {origin:'not_indexed',claims:[],coverage:null,limitations:['Membership details have not been indexed for this saved revision.'],shared:null};
  const claims=db.prepare('SELECT data FROM route_memberships WHERE revision_id=? ORDER BY segment_key').all(revisionId).map(r=>JSON.parse(r.data));
  const report={...JSON.parse(row.data),origin:row.origin,recordedAt:row.created,claims,shared:null};
  const latest=db.prepare('SELECT id FROM derivations WHERE feature_id=? ORDER BY rowid DESC LIMIT 1').get(featureId);
  if(latest?.id!==revisionId) return report;
  const own=new Map(claims.map(c=>[c.segmentKey,c]));
  const matches=db.prepare(`SELECT other.feature_id,other.revision_id,other.data,j.id AS job_id
    FROM route_memberships selected JOIN route_memberships other ON other.segment_key=selected.segment_key
    JOIN features f ON f.id=other.feature_id JOIN jobs j ON j.id=f.job_id
    WHERE selected.revision_id=? AND other.feature_id<>? AND f.active=1 AND j.superseded_by IS NULL
      AND other.revision_id=(SELECT d.id FROM derivations d WHERE d.feature_id=f.id ORDER BY d.rowid DESC LIMIT 1)`)
    .all(revisionId,featureId);
  const groups=new Map();
  for(const match of matches) {
    const membership=JSON.parse(match.data), selected=own.get(membership.segmentKey);
    if(selected.route.key===membership.route.key) continue;
    let group=groups.get(match.feature_id);
    if(!group) {group={featureId:match.feature_id,revisionId:match.revision_id,jobId:match.job_id,route:membership.route,sections:[]};groups.set(match.feature_id,group);}
    group.sections.push({segmentKey:membership.segmentKey,geometryMatches:selected.geometryHash===membership.geometryHash,membership});
  }
  const coverage=db.prepare(`SELECT COUNT(*) AS total,SUM(EXISTS(SELECT 1 FROM route_membership_revisions r
    WHERE r.revision_id=(SELECT d.id FROM derivations d WHERE d.feature_id=f.id ORDER BY d.rowid DESC LIMIT 1))) AS indexed
    FROM features f JOIN jobs j ON j.id=f.job_id WHERE f.active=1 AND j.superseded_by IS NULL AND j.type='road_route'`).get();
  report.shared={comparedAt:new Date().toISOString(),indexedRoutes:coverage.indexed || 0,totalRoutes:coverage.total,
    groups:[...groups.values()].sort((a,b)=>a.route.name.localeCompare(b.route.name,'en-AU',{numeric:true}))};
  return report;
}
