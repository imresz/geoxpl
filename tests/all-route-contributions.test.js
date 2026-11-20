import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { buildRoadRoute,routeSource } from '../server/road-routes.js';
import { routeIdentity,routeMembershipReport } from '../server/route-memberships.js';
import { localRouteIdentity,localRouteOptions,localRouteRoads,saveLocalRoute,previewLocalRoute,publishLocalRoute,withdrawLocalRoute,localRouteAlternatives } from '../server/local-routes.js';

const boundary={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[141,-39],[150,-39],[150,-34],[141,-34],[141,-39]]]}};
const bounds=[142.04,-37.61,142.06,-37.59];
const road=(pfi=1,x=142.05)=>({type:'Feature',id:`tr_road.${pfi}`,properties:{pfi,from_ufi:pfi,to_ufi:pfi+1,route_no:'M1',ezi_road_name:'Synthetic Regional Road'},
  geometry:{type:'LineString',coordinates:[[x,-37.60],[x+.001,-37.60]]}});
const page=features=>({type:'FeatureCollection',numberMatched:features.length,numberReturned:features.length,crs:{properties:{name:'EPSG:4326'}},features});
function setup() {
  const store=createStore(':memory:'),sourceId=store.addSource(routeSource);store.decideSource(sourceId,'approved',routeSource);return {store,sourceId};
}
function baseline({store,sourceId},code='M1') {
  const route=localRouteIdentity(code),job=store.request(route.label,'road_route');
  const record=road(),snapshot={records:[record],metadata:{adapter:'synthetic-route/1',retrievedAt:'2025-01-02T00:00:00Z'}};
  const {result}=buildRoadRoute(route.code,snapshot,boundary);
  const importId=store.addImport(sourceId,job.id,'synthetic-checksum',{type:'FeatureCollection',features:[record]},snapshot.metadata);
  const feature=store.saveFeature(job,{...result,evidence:[{sourceId,sourceName:routeSource.name,sourceUrl:routeSource.url,
    licence:'CC BY 4.0',attribution:'Synthetic source',sourceVersion:'2025-01-02T00:00:00Z',objectId:record.id,pfi:1,importId,checksum:'synthetic-checksum'}]});
  store.updateJob(job.id,'resolved','completed','Synthetic baseline.',feature.id);return {job:store.getJob(job.id),feature,importId};
}
async function draft(context,id='M1',origin='catalogue') {
  const roads=await localRouteRoads(context.store,id,{bounds,origin},boundary,async()=>page([road()]));
  saveLocalRoute(context.store,id,{version:0,author:'Synthetic contributor',basis:'local_knowledge',observedAt:'2026-01-02',
    statement:'A local claim for these selected road sections.',uncertainty:'Current signs and route endpoints are unverified.',links:[],
    segments:roads.features.map(f=>({snapshotId:f.snapshotId,recordId:f.id,membership:{statement:'Section-specific local evidence.',uncertainty:'The turning sign needs confirmation.',links:[]}}))});
  const preview=previewLocalRoute(context.store,id,boundary);
  return {roads,preview,input:{version:preview.version,checksum:preview.checksum,confirmed:true}};
}

test('all route schemes are selectable without conflating metropolitan numbers, numeric tags or historical routes',()=>{
  const context=setup(),{store}=context;
  try {
    for(const id of ['M1','A300','B500','C989','24','numbered:24'])store.request(localRouteIdentity(id).label,'road_route');
    const options=localRouteOptions(store);
    for(const id of ['M1','A300','B500','C989','24','numbered:24','20','22'])assert.ok(options.some(r=>r.id===id));
    assert.notEqual(localRouteIdentity('24').key,localRouteIdentity('numbered:24').key);
    for(const id of ['National Route 1','0','../M1','M1/A1','numbered:0'])assert.throws(()=>localRouteIdentity(id));
  } finally {store.close();}
});

test('saved road selection works regionally without the live service and retains source dates and parent imports',async()=>{
  const context=setup(),{store}=context;
  try {
    const base=baseline(context),d=await draft(context);
    assert.equal(d.roads.origin,'catalogue');assert.equal(d.roads.features.length,1);
    assert.equal(d.preview.feature.evidence[0].sourceVersion,'2025-01-02T00:00:00Z');
    assert.equal(d.preview.publication.mode,'alternative');
    const raw=JSON.parse(store.db.prepare('SELECT data FROM local_route_roads WHERE id=?').get(d.roads.features[0].snapshotId).data);
    assert.equal(raw.parentImportId,base.importId);assert.equal(raw.parentChecksum,'synthetic-checksum');
    assert.equal(localRouteOptions(store).find(r=>r.id==='M1').hasSavedRoads,true);
    const empty=await localRouteRoads(store,'M1',{bounds:[143,-37.61,143.02,-37.59],origin:'catalogue'},boundary,()=>{throw Error('Must not fetch');});
    assert.equal(empty.features.length,0);
  } finally {store.close();}
});

test('live roads cover Victoria beyond Melbourne; out-of-state records are omitted without truncating the page',async()=>{
  const context=setup(),{store}=context;
  try {
    const loaded=await localRouteRoads(store,'C989',{bounds},boundary,async()=>page([road(),road(2,140.95)]));
    assert.equal(loaded.features.length,1);assert.equal(loaded.omitted,1);
    await assert.rejects(localRouteRoads(store,'C989',{bounds:[151,-37.61,151.02,-37.59]},boundary,()=>{throw Error('Must not fetch');}),/Victoria/);
    await assert.rejects(localRouteRoads(store,'C989',{bounds},boundary,async()=>page([road(),road()])),/identifiers/);
  } finally {store.close();}
});

test('publishing and withdrawing an alternative never modifies baseline geometry, provenance, status or research policy',async()=>{
  const context=setup(),{store}=context;
  try {
    const base=baseline(context),before=JSON.stringify(store.feature(base.feature.id)),d=await draft(context);
    const published=publishLocalRoute(store,'M1',d.input,boundary);
    assert.notEqual(published.jobId,base.job.id);
    assert.equal(JSON.stringify(store.feature(base.feature.id)),before);
    assert.deepEqual(store.getJob(base.job.id),base.job);
    assert.equal(store.featureRevisions(base.feature.id).length,1);
    assert.equal(store.processingPolicy(base.job.id).allowResearch,true);
    assert.equal(localRouteAlternatives(store,base.job)[0].id,published.feature_id);
    const candidate=store.feature(published.feature_id);
    assert.equal(candidate.status,'partially_resolved');assert.equal(routeIdentity(candidate).key,'vic:alphanumeric:M1');
    const memberships=routeMembershipReport(store.db,candidate.id,store.featureRevisions(candidate.id)[0].id);
    assert.equal(memberships.claims[0].assignmentEvidence[1].statement,'Section-specific local evidence.');
    withdrawLocalRoute(store,'M1',{version:1,reason:'Synthetic withdrawal.'});
    assert.equal(localRouteAlternatives(store,base.job).length,0);
    assert.equal(JSON.stringify(store.feature(base.feature.id)),before);
    publishLocalRoute(store,'M1',d.input,boundary);
    assert.equal(store.featureRevisions(published.feature_id).length,2);
  } finally {store.close();}
});

test('numeric-tag contributions retain their numbering scheme and source revocation or stale baselines prevents publication',async()=>{
  const context=setup(),{store}=context;
  try {
    const d=await draft(context,'numbered:24','live');
    const published=publishLocalRoute(store,'numbered:24',d.input,boundary);
    assert.equal(routeIdentity(store.feature(published.feature_id)).key,'vic:unconfirmed_numeric:24');
    const base=baseline(context),a=await draft(context);
    store.saveFeature(base.job,{...store.feature(base.feature.id),warnings:['Changed baseline evidence.']});
    assert.throws(()=>publishLocalRoute(store,'M1',a.input,boundary),/changed/);
    const source=store.sources()[0];store.decideSource(source.id,'rejected',source);
    await assert.rejects(localRouteRoads(store,'M1',{bounds,origin:'catalogue'},boundary),/approved/);
    assert.throws(()=>previewLocalRoute(store,'M1',boundary),/approved/);
  } finally {store.close();}
});

test('public search offers baseline and local candidates separately; the route picker and publication remain authenticated',async()=>{
  const context=setup(),{store}=context;baseline(context);const d=await draft(context);const published=publishLocalRoute(store,'M1',d.input,boundary);
  const server=createApp(store,{boundary}).listen(0,'127.0.0.1');
  try {
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
    const root=`http://127.0.0.1:${server.address().port}/api`;
    assert.equal((await fetch(root+'/admin/local-routes')).status,401);
    const search=await fetch(root+'/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'M1',type:'road_route'})});
    const result=await search.json();assert.equal(result.selectionRequired,true);assert.equal(result.matches.length,2);assert.equal(result.feature,null);
    assert.equal(result.matches.filter(m=>m.localContribution).length,1);
    assert.equal((await (await fetch(root+`/jobs/${published.jobId}`)).json()).matches.length,1);
    const session=await fetch(root+'/admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Synthetic-test-password-2026'})});
    const cookie=session.headers.get('set-cookie').split(';')[0];
    const options=await (await fetch(root+'/admin/local-routes',{headers:{Cookie:cookie}})).json();assert.ok(options.some(r=>r.id==='M1'));
    const withdrawal=await fetch(root+'/admin/local-routes/M1/withdraw',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({version:1,reason:'Synthetic API withdrawal.'})});
    assert.equal(withdrawal.status,200);
    const after=await (await fetch(root+'/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'M1',type:'road_route'})})).json();
    assert.equal(after.selectionRequired,false);assert.equal(after.feature.displayName,'M1 (Victoria)');
  } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});
