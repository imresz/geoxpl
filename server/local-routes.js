import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { bbox, booleanPointInPolygon } from '@turf/turf';
import { publicJson } from './network.js';
import { buildRoadRoute, routeSource } from './road-routes.js';
import { normalize, now } from './store.js';
import { metroSource } from './metro-routes.js';

const codeSchema = z.string().regex(/^(?:[MABC][0-9]{1,3}|[1-9][0-9]?|numbered:[1-9][0-9]?)$/);
const sectionEvidenceSchema=z.object({statement:z.string().trim().max(1000).default(''),uncertainty:z.string().trim().max(1000).default(''),
  links:z.array(z.url().startsWith('https://').max(1000)).max(5).default([])}).strict();
const refSchema = z.object({ snapshotId:z.string().uuid(), recordId:z.string().min(1).max(100),membership:sectionEvidenceSchema.optional() }).strict();
const draftSchema = z.object({
  version:z.number().int().min(0),
  author:z.string().trim().min(2).max(100),
  basis:z.enum(['local_knowledge','observed_signs','published_reference']),
  observedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')),
  statement:z.string().trim().min(10).max(2000),
  uncertainty:z.string().trim().min(10).max(2000),
  links:z.array(z.url().startsWith('https://').max(1000)).max(5),
  segments:z.array(refSchema).min(1).max(1500)
}).strict();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const approvedRoadSources = store => store.sources().filter(s => s.status === 'approved' && s.type === 'road_route' &&
  [routeSource.format,metroSource.format].includes(s.format) && s.url === routeSource.url && s.licence?.trim() && s.attribution?.trim());
const sourceFingerprint = s => sha({id:s.id,name:s.name,format:s.format,url:s.url,nameField:s.nameField,idField:s.idField,
  licence:s.licence,attribution:s.attribution,version:s.version});

export function localRouteIdentity(id) {
  codeSchema.parse(id);
  const numbered=id.startsWith('numbered:'),code=numbered ? id.slice(9) : id;
  const scheme=numbered ? 'unconfirmed_numeric' : /^[MABC]/.test(code) ? 'alphanumeric' : 'metropolitan';
  const label=scheme==='alphanumeric' ? code : `${numbered ? 'Numbered' : 'Metropolitan'} Route ${code}`;
  const prefix=scheme==='metropolitan' ? 'metro-route' : numbered ? 'numbered-route' : 'road-route';
  return {id,code,scheme,label,key:`vic:${scheme}:${code}`,identityKey:`local:${prefix}:${code}`};
}
const baseJob = (store,route) => {
  const row=store.db.prepare("SELECT id FROM jobs WHERE type='road_route' AND normalized=?").get(normalize(route.label));
  return row ? store.currentJob(row.id) : null;
};
const baseFeatures = (store,route) => {
  const job=baseJob(store,route);return job ? store.jobFeatures(job.id) : [];
};

export function localRouteOptions(store) {
  const ids=new Set(['20','22']);
  for(const job of store.jobs().filter(j=>j.type==='road_route'&&!j.superseded_by)) {
    let id;
    if(/^[MABC][0-9]{1,3}$/.test(job.query)) id=job.query;
    else if(/^Metropolitan Route [1-9][0-9]?$/.test(job.query)) id=job.query.split(' ').at(-1);
    else if(/^Numbered Route [1-9][0-9]?$/.test(job.query)) id=`numbered:${job.query.split(' ').at(-1)}`;
    if(id)ids.add(id);
  }
  for(const row of store.db.prepare('SELECT code FROM local_route_drafts').all())ids.add(row.code);
  const sources=new Set(approvedRoadSources(store).map(s=>s.id));
  return [...ids].map(id=>{
    const route=localRouteIdentity(id),features=baseFeatures(store,route),extents=features.map(f=>f.bbox).filter(b=>b?.length===4);
    const extent=extents.length ? extents.reduce((a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]) : null;
    return {...route,bbox:extent,hasAlignment:features.length>0,hasSavedRoads:features.some(f=>f.evidence?.some(e=>sources.has(e.sourceId)))};
  }).sort((a,b)=>a.label.localeCompare(b.label,'en-AU',{numeric:true}));
}

export function localRouteAlternatives(store,job) {
  if(job.type!=='road_route'||/ \(local contribution\)$/.test(job.query))return [];
  const id=/^[MABC][0-9]{1,3}$/.test(job.query) ? job.query : /^Metropolitan Route [1-9][0-9]?$/.test(job.query) ? job.query.split(' ').at(-1) :
    /^Numbered Route [1-9][0-9]?$/.test(job.query) ? `numbered:${job.query.split(' ').at(-1)}` : null;
  if(!id)return [];
  return store.db.prepare(`SELECT f.data FROM local_route_drafts d JOIN features f ON f.id=d.feature_id
    WHERE d.code=? AND d.state='published' AND f.active=1 AND f.job_id<>?`).all(id,job.id).map(row=>JSON.parse(row.data));
}
const action = (store, code, kind, data) => store.db.prepare('INSERT INTO local_route_actions VALUES(?,?,?,?,?)')
  .run(randomUUID(),code,kind,JSON.stringify(data),now());
const inTransaction = (store, fn) => {
  store.db.exec('BEGIN IMMEDIATE');
  try { const value=fn();store.db.exec('COMMIT');return value; }
  catch(error) {store.db.exec('ROLLBACK');throw error;}
};

function draft(store, code) {
  codeSchema.parse(code);
  const row=store.db.prepare('SELECT * FROM local_route_drafts WHERE code=?').get(code);
  return row ? {...row,data:JSON.parse(row.data)} : null;
}
function recordsFor(store, code, refs) {
  const snapshots = new Map(), ids = new Set();
  return refs.map(ref => {
    if (!snapshots.has(ref.snapshotId)) {
      const row=store.db.prepare('SELECT code,data,created FROM local_route_roads WHERE id=?').get(ref.snapshotId);
      if (!row || row.code !== code) throw Error('Road snapshot does not belong to this route.');
      snapshots.set(ref.snapshotId,{...row,data:JSON.parse(row.data)});
    }
    const snapshot=snapshots.get(ref.snapshotId);
    const record=snapshot.data.features.find(f=>f.id===ref.recordId);
    if (!record || ids.has(record.properties.pfi)) throw Error('Unknown or duplicate selected road segment.');
    ids.add(record.properties.pfi);
    return {record,snapshotId:ref.snapshotId,retrievedAt:snapshot.data.sourceVersion || snapshot.created,
      sourceId:snapshot.data.sourceId,sourceFingerprint:snapshot.data.sourceFingerprint,
      checksum:snapshot.data.checksum,membership:ref.membership};
  });
}
export function localRouteView(store, code) {
  const row=draft(store,code);
  const history=store.db.prepare('SELECT kind,created FROM local_route_actions WHERE code=? ORDER BY rowid DESC').all(code);
  const jobId=row?.feature_id && store.db.prepare('SELECT job_id FROM features WHERE id=?').get(row.feature_id)?.job_id;
  return row ? {...row,jobId,selected:recordsFor(store,code,row.data.segments).map(r=>({...r.record,snapshotId:r.snapshotId,membership:r.membership})),history} : null;
}

export async function localRouteRoads(store, code, input, boundary, load=publicJson) {
  codeSchema.parse(code);
  const {bounds,origin}=z.object({bounds:z.tuple([z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite()]),
    origin:z.enum(['live','catalogue']).default('live')}).strict().parse(input);
  const [w,s,e,n]=bounds;
  const state=bbox(boundary),intersects=b=>b[0]<=e&&b[2]>=w&&b[1]<=n&&b[3]>=s;
  if(w>=e||s>=n||e-w>.045||n-s>.035||!intersects(state)) throw Error('Road coverage requires a closer map view within Victoria.');
  const sources=approvedRoadSources(store),source=sources.find(s=>s.format===routeSource.format);
  const ids=new Set(),pfis=new Set();let vertices=0,omitted=0;
  const validate=f=>{
    if(typeof f.id!=='string'||!/^tr_road\.[\w-]+$/.test(f.id)||ids.has(f.id)||!Number.isSafeInteger(f.properties?.pfi)||f.properties.pfi<=0||pfis.has(f.properties.pfi)||
      f.geometry?.type!=='LineString'||!Array.isArray(f.geometry.coordinates)||f.geometry.coordinates.length<2||
      f.geometry.coordinates.some(c=>!Array.isArray(c)||c.length!==2||!c.every(Number.isFinite)||c[0]<140||c[0]>151||c[1]<-40||c[1]>-33)) throw Error('Road geometry or identifiers failed validation.');
    vertices+=f.geometry.coordinates.length;
    if(vertices>250_000) throw Error('Road geometry is too large. Choose a smaller area.');
    ids.add(f.id);pfis.add(f.properties.pfi);
    if(!f.geometry.coordinates.every(c=>booleanPointInPolygon(c,boundary))){omitted++;return false;}
    return true;
  };
  const retain=(features,source,metadata={})=>{
    const current=approvedRoadSources(store).find(s=>s.id===source.id);
    if(!current||sourceFingerprint(current)!==sourceFingerprint(source))throw Error('The approved road source changed during loading.');
    const id=randomUUID(),created=now(),checksum=sha(features);
    store.db.prepare('INSERT INTO local_route_roads VALUES(?,?,?,?)').run(id,code,JSON.stringify({features,checksum,bounds,sourceId:source.id,
      sourceFingerprint:sourceFingerprint(source),origin,...metadata}),created);
    return {id,features:features.map(f=>({...f,snapshotId:id})),created};
  };
  if(origin==='catalogue') {
    const route=localRouteIdentity(code),groups=new Map(),imports=new Map(),approved=new Map(sources.map(s=>[s.id,s]));
    const features=baseFeatures(store,route);
    if(!features.some(f=>f.evidence?.some(e=>approved.has(e.sourceId))))throw Error('No approved retained Vicmap geometry is available for this route. Choose Vicmap area instead.');
    for(const feature of features)for(const evidence of feature.evidence || []) {
      const source=approved.get(evidence.sourceId);if(!source)continue;
      if(!imports.has(evidence.importId)) {
        const row=store.db.prepare('SELECT checksum,payload,metadata,created FROM imports WHERE id=? AND source_id=?').get(evidence.importId,source.id);
        const payload=row&&JSON.parse(row.payload);
        imports.set(evidence.importId,row&&Array.isArray(payload?.features) ? {checksum:row.checksum,retrievedAt:JSON.parse(row.metadata).retrievedAt || row.created,
          records:new Map(payload.features.map(f=>[String(f.id),f]))} : null);
      }
      const imported=imports.get(evidence.importId),record=imported?.records.get(String(evidence.objectId));
      if(!record)throw Error('Saved route geometry is missing its retained source record.');
      if(imported.checksum!==evidence.checksum)throw Error('Saved route evidence does not match its retained import checksum.');
      if(!intersects(bbox(record)))continue;
      if(pfis.has(record.properties?.pfi))continue;
      if(!validate(record))continue;
      if(evidence.pfi!==undefined&&evidence.pfi!==record.properties.pfi)throw Error('Saved route record identifiers changed.');
      const sourceVersion=evidence.sourceVersion || imported.retrievedAt,key=JSON.stringify([source.id,evidence.importId,sourceVersion]);
      if(!groups.has(key))groups.set(key,{source,features:[],metadata:{parentImportId:evidence.importId,parentChecksum:evidence.checksum,sourceVersion}});
      groups.get(key).features.push(record);
      if(pfis.size>2000)throw Error('Too many saved road segments in this view. Choose a smaller area.');
    }
    const snapshots=inTransaction(store,()=>[...groups.values()].map(g=>retain(g.features,g.source,g.metadata)));
    return {id:snapshots.length===1?snapshots[0].id:null,features:snapshots.flatMap(s=>s.features),origin,omitted,
      sourceVersions:[...new Set([...groups.values()].map(g=>g.metadata.sourceVersion).filter(Boolean))]};
  }
  if(!source) throw Error('An approved Vicmap road source is required.');
  const features=[],requests=[];let total,received=0;
  for(let offset=0;offset===0||offset<total;offset=received){
    const params=new URLSearchParams({service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:tr_road',
      outputFormat:'application/json',srsName:'EPSG:4326',count:'500',startIndex:String(offset),sortBy:'pfi A',
      propertyName:'geom,pfi,from_ufi,to_ufi,ezi_road_name,feature_type_code',
      cql_filter:`BBOX(geom,${bounds.join(',')},'EPSG:4326') AND feature_type_code IN ('road','bridge','tunnel','connector','roundabout')`});
    const url=`${routeSource.url}?${params}`;requests.push(url);
    let page;
    try {page=await load(url,25_000_000);}
    catch(error) {throw Error(`Vicmap road loading failed: ${error.message} Your saved draft is unchanged; use saved alignment roads if available, or try again later.`);}
    if(!Number.isSafeInteger(page.numberMatched)||page.numberMatched<0||page.numberMatched>2000 ||
      (total!==undefined&&total!==page.numberMatched)||page.type!=='FeatureCollection'||!Array.isArray(page.features)||
      page.numberReturned!==page.features.length||page.features.length>500||offset+page.features.length>page.numberMatched||(!page.features.length&&page.numberMatched>offset)||
      !/4326|CRS84/.test(page.crs?.properties?.name||'')) throw Error('Road service returned incomplete or oversized results. Choose a smaller area.');
    total=page.numberMatched;
    for(const f of page.features){
      received++;
      if(validate(f))features.push(f);
    }
  }
  if(received!==total)throw Error('Road results were truncated.');
  return {...retain(features,source,{requests}),origin,omitted};
}

export function saveLocalRoute(store,code,raw) {
  codeSchema.parse(code);
  const data=draftSchema.parse(raw);
  if(data.observedAt && (!Number.isFinite(Date.parse(data.observedAt)) ||
    new Date(data.observedAt).toISOString().slice(0,10)!==data.observedAt || data.observedAt>now().slice(0,10))) throw Error('Observation date must be a valid date, not in the future.');
  recordsFor(store,code,data.segments);
  return inTransaction(store,()=>{
    const old=draft(store,code);
    if((old?.version||0)!==data.version) throw Error('This draft changed. Reload it before saving.');
    if(old?.state==='published') throw Error('Withdraw the publication before editing its draft.');
    const version=data.version+1, time=now();
    const {version:_,...body}=data;
    store.db.prepare(`INSERT INTO local_route_drafts VALUES(?,?,?,'draft',NULL,?,?)
      ON CONFLICT(code) DO UPDATE SET data=excluded.data,version=excluded.version,state='draft',updated=excluded.updated`)
      .run(code,JSON.stringify(body),version,old?.created||time,time);
    action(store,code,'saved',{version,data:body});
    return localRouteView(store,code);
  });
}

export function previewLocalRoute(store,code,boundary) {
  const row=draft(store,code);
  if(!row) throw Error('Save a draft before previewing it.');
  const route=localRouteIdentity(code),sources=new Map(approvedRoadSources(store).map(s=>[s.id,s]));
  const selected=recordsFor(store,code,row.data.segments);
  if(selected.some(s=>!sources.has(s.sourceId)))throw Error('An approved Vicmap road source is required for every selected segment.');
  if(selected.some(s=>s.sourceFingerprint&&s.sourceFingerprint!==sourceFingerprint(sources.get(s.sourceId))))throw Error('Road source metadata changed. Reload the affected segments before previewing.');
  const {result,records}=buildRoadRoute(route.code,{records:selected.map(s=>s.record),metadata:{adapter:'local-route/2',retrievedAt:row.updated}},boundary);
  if(records.length!==selected.length) throw Error('Selected road segments extend outside the approved boundary.');
  const contribution={code:route.code,routeKey:route.key,scheme:route.scheme,scope:'selected_sections',version:row.version,...row.data};
  delete contribution.segments;
  const feature={...result,identityKey:route.identityKey,displayName:`${route.label} (local contribution)`,
    status:'partially_resolved',method:'local_knowledge_vicmap_match',confidence:'community_supported',
    roadRoute:{...result.roadRoute,contribution,
      names:[...new Set(selected.map(s=>s.record.properties.ezi_road_name || s.record.properties.ezi_road_name_label).filter(Boolean))],
      membershipNotes:selected.filter(s=>s.membership).map(s=>({pfi:s.record.properties.pfi,...s.membership}))},
    warnings:[...result.warnings,'This local contribution covers the selected road sections, not a verified replacement for the full route.',
      'Community-supported candidate; current route signing, turns and endpoints are not independently verified.',row.data.uncertainty],
    evidence:selected.map(s=>{const source=sources.get(s.sourceId);return {sourceId:source.id,sourceName:source.name,sourceUrl:source.url,licence:source.licence,
      attribution:source.attribution,objectId:s.record.id,pfi:s.record.properties.pfi,checksum:s.checksum,sourceVersion:s.retrievedAt,importId:s.snapshotId,role:'contributed_alignment_segment'};})
  };
  const published=baseFeatures(store,route).filter(f=>f.identityKey!==route.identityKey).map(f=>({id:f.id,checksum:sha(f)}));
  const publication={mode:published.length?'alternative':'primary',preservedAlignments:published};
  const used=[...new Set(selected.map(s=>s.sourceId))].map(id=>sources.get(id));
  return {version:row.version,checksum:sha({feature,sources:used,publication}),feature,publication};
}

export function publishLocalRoute(store,code,raw,boundary) {
  const input=z.object({version:z.number().int(),checksum:z.string().length(64),confirmed:z.literal(true)}).strict().parse(raw);
  return inTransaction(store,()=>{
    const row=draft(store,code),preview=previewLocalRoute(store,code,boundary);
    if(row.version!==input.version||preview.checksum!==input.checksum) throw Error('The draft or source changed. Preview it again.');
    const route=localRouteIdentity(code);
    if(row.state==='published') {
      const current=store.feature(row.feature_id);
      if(current?.identityKey!==route.identityKey||current.roadRoute?.contribution?.version!==row.version)throw Error('The active local result changed. Withdraw its publication before publishing again.');
      return localRouteView(store,code);
    }
    const priorJobs=new Set(store.jobs().map(j=>j.id));
    const base=store.request(route.label,'road_route');
    const preserve=store.jobFeatures(base.id).some(f=>f.identityKey!==route.identityKey);
    const job=preserve ? store.request(`${route.label} (local contribution)`,'road_route') : base;
    const existing=store.jobFeatures(job.id);
    if(existing.some(f=>f.identityKey!==preview.feature.identityKey)) throw Error('A different alignment is already published. No result was replaced.');
    if(priorJobs.has(job.id)&&['queued','importing','processing','researching'].includes(job.phase)) throw Error('Wait for active route processing to finish before publishing.');
    const imports=new Map();
    for(const evidence of preview.feature.evidence){
      if(imports.has(evidence.importId))continue;
      const snapshot=JSON.parse(store.db.prepare('SELECT data FROM local_route_roads WHERE id=?').get(evidence.importId).data);
      const importId=store.addImport(evidence.sourceId,job.id,snapshot.checksum,{type:'FeatureCollection',features:snapshot.features},
        {adapter:'local-route-roads/2',retrievedAt:evidence.sourceVersion,bounds:snapshot.bounds,requests:snapshot.requests,
          origin:snapshot.origin || 'live',parentImportId:snapshot.parentImportId,parentChecksum:snapshot.parentChecksum,snapshotId:evidence.importId});
      imports.set(evidence.importId,importId);
    }
    const feature=store.saveFeature(job,{...preview.feature,evidence:preview.feature.evidence.map(e=>({...e,importId:imports.get(e.importId)}))},{inTransaction:true});
    store.setProcessingPolicy(job.id,{allowResearch:false});
    store.updateJob(job.id,'partially_resolved','completed','Local contribution published; route identity remains unverified.',feature.id);
    store.db.prepare("UPDATE local_route_drafts SET state='published',feature_id=? WHERE code=?").run(feature.id,code);
    action(store,code,'published',{version:row.version,featureId:feature.id,checksum:preview.checksum});
    return localRouteView(store,code);
  });
}

export function withdrawLocalRoute(store,code,raw) {
  const input=z.object({version:z.number().int(),reason:z.string().trim().min(5).max(1000)}).strict().parse(raw);
  return inTransaction(store,()=>{
    const row=draft(store,code);
    if(!row||row.version!==input.version) throw Error('Contribution changed. Reload it first.');
    if(row.state==='withdrawn') return localRouteView(store,code);
    if(row.state!=='published') throw Error('This contribution is not published.');
    const route=localRouteIdentity(code),record=store.db.prepare('SELECT job_id,data,active FROM features WHERE id=?').get(row.feature_id);
    const current=record&&JSON.parse(record.data);
    if(!current||current.identityKey!==route.identityKey||current.roadRoute?.contribution?.code!==route.code||
      current.roadRoute.contribution.version!==row.version) throw Error('The local result changed. No geometry was withdrawn.');
    if(record.active) {
      store.db.prepare('UPDATE features SET active=0 WHERE id=?').run(row.feature_id);
      const remaining=store.jobFeatures(record.job_id);
      store.db.prepare("UPDATE jobs SET feature_id=?,status=?,phase=?,message=?,updated=? WHERE id=?")
        .run(remaining.length===1?remaining[0].id:null,remaining.length ? remaining[0].status : 'insufficient_data',
          remaining.length?'completed':'awaiting_data','Local contribution withdrawn; other alignments and archived revisions retained.',now(),record.job_id);
    }
    store.db.prepare("UPDATE local_route_drafts SET state='withdrawn' WHERE code=?").run(code);
    action(store,code,'withdrawn',{version:row.version,reason:input.reason});
    store.event(record.job_id,'contribution_withdrawn',input.reason);
    return localRouteView(store,code);
  });
}
