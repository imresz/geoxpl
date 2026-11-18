import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { booleanPointInPolygon } from '@turf/turf';
import { publicJson } from './network.js';
import { buildRoadRoute, routeSource } from './road-routes.js';
import { now } from './store.js';

const codeSchema = z.enum(['20', '22']);
const refSchema = z.object({ snapshotId:z.string().uuid(), recordId:z.string().min(1).max(100) }).strict();
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
const study = [144.90,-38.02,145.34,-37.79];
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eligibleSource = store => store.sources().find(s => s.status === 'approved' && s.type === 'road_route' &&
  s.format === routeSource.format && s.url === routeSource.url && s.licence?.trim() && s.attribution?.trim());
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
    return {record,snapshotId:ref.snapshotId,retrievedAt:snapshot.created,checksum:snapshot.data.checksum};
  });
}
export function localRouteView(store, code) {
  const row=draft(store,code);
  const history=store.db.prepare('SELECT kind,created FROM local_route_actions WHERE code=? ORDER BY rowid DESC').all(code);
  const jobId=row?.feature_id && store.db.prepare('SELECT job_id FROM features WHERE id=?').get(row.feature_id)?.job_id;
  return row ? {...row,jobId,selected:recordsFor(store,code,row.data.segments).map(r=>({...r.record,snapshotId:r.snapshotId})),history} : null;
}

export async function localRouteRoads(store, code, input, boundary, load=publicJson) {
  codeSchema.parse(code);
  const bounds=z.tuple([z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite()]).parse(input.bounds);
  const [w,s,e,n]=bounds;
  if(w<study[0] || s<study[1] || e>study[2] || n>study[3] || w>=e || s>=n ||
     e-w>.045 || n-s>.035) throw Error('Road coverage requires a closer map view within the Melbourne study area.');
  const source=eligibleSource(store);
  if(!source) throw Error('An approved Vicmap road source is required.');
  const features=[],requests=[],ids=new Set(),pfis=new Set();let total,vertices=0;
  for(let offset=0;offset===0||offset<total;offset=features.length){
    const params=new URLSearchParams({service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:tr_road',
      outputFormat:'application/json',srsName:'EPSG:4326',count:'500',startIndex:String(offset),sortBy:'pfi A',
      propertyName:'geom,pfi,from_ufi,to_ufi,ezi_road_name,feature_type_code',
      cql_filter:`BBOX(geom,${bounds.join(',')},'EPSG:4326') AND feature_type_code IN ('road','bridge','tunnel','connector','roundabout')`});
    const url=`${routeSource.url}?${params}`;requests.push(url);
    let page;
    try {page=await load(url,25_000_000);}
    catch(error) {throw Error(`Vicmap road loading failed: ${error.message} Your saved draft is unchanged; try loading again later.`);}
    if(!Number.isSafeInteger(page.numberMatched)||page.numberMatched<0||page.numberMatched>2000 ||
      (total!==undefined&&total!==page.numberMatched)||page.type!=='FeatureCollection'||!Array.isArray(page.features)||
      page.numberReturned!==page.features.length||page.features.length>500||offset+page.features.length>page.numberMatched||(!page.features.length&&page.numberMatched>offset)||
      !/4326|CRS84/.test(page.crs?.properties?.name||'')) throw Error('Road service returned incomplete or oversized results. Choose a smaller area.');
    total=page.numberMatched;
    for(const f of page.features){
      if(typeof f.id!=='string'||!/^tr_road\.[\w-]+$/.test(f.id)||ids.has(f.id)||!Number.isSafeInteger(f.properties?.pfi)||pfis.has(f.properties.pfi)||
        f.geometry?.type!=='LineString'||!Array.isArray(f.geometry.coordinates)||f.geometry.coordinates.length<2||
        f.geometry.coordinates.some(c=>c.length!==2||!c.every(Number.isFinite)||c[0]<study[0]||c[0]>study[2]||c[1]<study[1]||c[1]>study[3]||
          !booleanPointInPolygon(c,boundary))) throw Error('Road geometry or identifiers failed validation.');
      vertices+=f.geometry.coordinates.length;
      if(vertices>250_000) throw Error('Road geometry is too large. Choose a smaller area.');
      ids.add(f.id);pfis.add(f.properties.pfi);features.push(f);
    }
  }
  if(features.length!==total || eligibleSource(store)?.id!==source.id) throw Error('Road source changed or results were truncated.');
  const id=randomUUID(), created=now(), checksum=sha(features);
  store.db.prepare('INSERT INTO local_route_roads VALUES(?,?,?,?)').run(id,code,JSON.stringify({features,checksum,bounds,requests,sourceId:source.id}),created);
  return {id,features,created};
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
  const source=eligibleSource(store);
  if(!source) throw Error('An approved Vicmap road source is required.');
  const selected=recordsFor(store,code,row.data.segments);
  if(selected.some(s=>JSON.parse(store.db.prepare('SELECT data FROM local_route_roads WHERE id=?').get(s.snapshotId).data).sourceId!==source.id)) throw Error('Selected roads use a different source registration.');
  const {result,records}=buildRoadRoute(code,{records:selected.map(s=>s.record),metadata:{adapter:'local-route/1',retrievedAt:row.updated}},boundary);
  if(records.length!==selected.length) throw Error('Selected road segments extend outside the approved boundary.');
  const contribution={code,version:row.version,...row.data};
  delete contribution.segments;
  const feature={...result,identityKey:`local:metro-route:${code}`,displayName:`Metropolitan Route ${code} (local contribution)`,
    status:'partially_resolved',method:'local_knowledge_vicmap_match',confidence:'community_supported',
    roadRoute:{...result.roadRoute,contribution},
    warnings:[...result.warnings,'Community-supported candidate; current route signing, turns and endpoints are not independently verified.',row.data.uncertainty],
    evidence:selected.map(s=>({sourceId:source.id,sourceName:source.name,sourceUrl:source.url,licence:source.licence,
      attribution:source.attribution,objectId:s.record.id,checksum:s.checksum,sourceVersion:s.retrievedAt,importId:s.snapshotId,role:'contributed_alignment_segment'}))
  };
  return {version:row.version,checksum:sha({feature,source}),feature};
}

export function publishLocalRoute(store,code,raw,boundary) {
  const input=z.object({version:z.number().int(),checksum:z.string().length(64),confirmed:z.literal(true)}).strict().parse(raw);
  return inTransaction(store,()=>{
    const row=draft(store,code),preview=previewLocalRoute(store,code,boundary);
    if(row.version!==input.version||preview.checksum!==input.checksum) throw Error('The draft or source changed. Preview it again.');
    if(row.state==='published') return localRouteView(store,code);
    const priorJobs=new Set(store.jobs().map(j=>j.id));
    const job=store.request(`Metropolitan Route ${code}`,'road_route');
    const existing=store.jobFeatures(job.id);
    if(existing.some(f=>f.identityKey!==preview.feature.identityKey)) throw Error('A different alignment is already published. No result was replaced.');
    if(priorJobs.has(job.id)&&['queued','importing','processing','researching'].includes(job.phase)) throw Error('Wait for active route processing to finish before publishing.');
    const imports=new Map();
    for(const evidence of preview.feature.evidence){
      if(imports.has(evidence.importId))continue;
      const snapshot=JSON.parse(store.db.prepare('SELECT data FROM local_route_roads WHERE id=?').get(evidence.importId).data);
      const importId=store.addImport(evidence.sourceId,job.id,snapshot.checksum,{type:'FeatureCollection',features:snapshot.features},
        {adapter:'local-route-roads/1',retrievedAt:evidence.sourceVersion,bounds:snapshot.bounds,requests:snapshot.requests,snapshotId:evidence.importId});
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
    const current=store.feature(row.feature_id);
    if(!current||current.identityKey!==`local:metro-route:${code}`||current.roadRoute?.contribution?.code!==code||
      current.roadRoute.contribution.version!==row.version) throw Error('The active result changed. No geometry was withdrawn.');
    store.db.prepare('UPDATE features SET active=0 WHERE id=?').run(row.feature_id);
    const job=store.db.prepare('SELECT job_id FROM features WHERE id=?').get(row.feature_id);
    store.db.prepare("UPDATE jobs SET feature_id=NULL,status='insufficient_data',phase='awaiting_data',message=?,updated=? WHERE id=?")
      .run('Local contribution withdrawn; archived revisions retained.',now(),job.job_id);
    store.db.prepare("UPDATE local_route_drafts SET state='withdrawn' WHERE code=?").run(code);
    action(store,code,'withdrawn',{version:row.version,reason:input.reason});
    store.event(job.job_id,'contribution_withdrawn',input.reason);
    return localRouteView(store,code);
  });
}
