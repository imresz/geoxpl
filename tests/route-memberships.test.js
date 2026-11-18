import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { buildRoadRoute,routeSource } from '../server/road-routes.js';
import { indexRouteRevision,routeMembershipReport,routeIdentity } from '../server/route-memberships.js';
import { localRouteRoads,saveLocalRoute,previewLocalRoute,publishLocalRoute,withdrawLocalRoute } from '../server/local-routes.js';

const boundary={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[144,-39],[146,-39],[146,-37],[144,-37],[144,-39]]]}};
const coordinates=[[145,-37.85],[145.001,-37.85]];
const record=(pfi=1,code='A1',coords=coordinates)=>({type:'Feature',id:`tr_road.${pfi}`,properties:{pfi,route_no:code,
  from_ufi:1,to_ufi:2,ezi_road_name:'Synthetic Shared Road'},geometry:{type:'LineString',coordinates:coords}});
function setup(path=':memory:') {
  const store=createStore(path),sourceId=store.addSource(routeSource);
  store.decideSource(sourceId,'approved',routeSource);return {store,sourceId};
}
function saved({store,sourceId},code,{pfi=1,coords=coordinates,metro=false,name,sourceCode=code}={}) {
  const road=record(pfi,sourceCode,coords),job=store.request(name || (metro ? `Metropolitan Route ${code}` : code),'road_route');
  const snapshot={records:[road],metadata:{adapter:'synthetic-route/1',retrievedAt:'2026-01-02T00:00:00Z'}};
  const {result}=buildRoadRoute(code,snapshot,boundary);
  if(metro) {
    result.identityKey=`vicmap:metro-route:${code}`;result.method='vicmap_2015_metro_corridor_match';result.status='partially_resolved';
    result.roadRoute.review={baseline:'https://example.org/2015-map.pdf',signage:'Synthetic candidate: current signed turns are unverified.'};
  }
  const checksum=createHash('sha256').update(JSON.stringify(road)).digest('hex');
  const importId=store.addImport(sourceId,job.id,checksum,{type:'FeatureCollection',features:[road]},snapshot.metadata);
  const evidence=[{sourceId,sourceName:routeSource.name,sourceUrl:routeSource.url,licence:'CC BY 4.0',attribution:'Synthetic source credit',
    pfi,objectId:road.id,importId,checksum,sourceVersion:'2026-01-02'}];
  const feature=store.saveFeature(job,{...result,displayName:metro ? `Metropolitan Route ${code}` : code,evidence});
  store.updateJob(job.id,feature.status,'completed','Synthetic saved route.',feature.id);
  const revision=store.featureRevisions(feature.id)[0].id;
  return {feature,revision,job};
}
const report=(store,result)=>routeMembershipReport(store.db,result.feature.id,result.revision);
async function local(context,code,{version=0,author=`Contributor ${code}`,note=`Evidence for route ${code}.`}={}) {
  const {store}=context;
  const roads=await localRouteRoads(store,code,{bounds:[144.99,-37.86,145.02,-37.84]},boundary,async()=>({type:'FeatureCollection',
    numberMatched:1,numberReturned:1,crs:{properties:{name:'EPSG:4326'}},features:[record(1,'A1')]}));
  saveLocalRoute(store,code,{version,author,basis:'local_knowledge',observedAt:'2026-01-02',statement:`Synthetic local route ${code} candidate.`,
    uncertainty:`Global route ${code} uncertainty.`,links:[],segments:[{snapshotId:roads.id,recordId:roads.features[0].id,
      membership:{statement:note,uncertainty:`Section ${code} signs are unverified.`,links:[`https://example.org/route-${code}`]}}]});
  const preview=previewLocalRoute(store,code,boundary);
  const published=publishLocalRoute(store,code,{version:preview.version,checksum:preview.checksum,confirmed:true},boundary);
  return {feature:store.feature(published.feature_id),revision:store.featureRevisions(published.feature_id)[0].id,published};
}

test('shared source segments retain independent published and candidate memberships, including reversed geometry',()=>{
  const context=setup(),{store}=context;
  try {
    const tagged=saved(context,'A1'),candidate=saved(context,'24',{metro:true,sourceCode:'A1',coords:[...coordinates].reverse()});
    const first=report(store,tagged),second=report(store,candidate);
    assert.equal(first.claims.length,1);assert.equal(second.claims.length,1);
    assert.equal(first.claims[0].certainty,'published_assignment');assert.equal(second.claims[0].certainty,'candidate');
    assert.equal(first.claims[0].assignmentEvidence[0].field,'route_no');
    assert.equal(second.claims[0].assignmentEvidence[0].kind,'reviewed_reference');
    assert.notEqual(first.claims[0].geometryEvidence.importId,second.claims[0].geometryEvidence.importId);
    assert.equal(first.shared.groups[0].sections[0].geometryMatches,true);
    assert.equal(second.claims[0].sourceRoadTag,'A1');
    assert.equal(store.feature(tagged.feature.id).status,'resolved');
    assert.equal(store.feature(candidate.feature.id).status,'partially_resolved');
  } finally {store.close();}
});

test('three route memberships coexist; local section evidence, withdrawal and archived revisions stay independent',async()=>{
  const context=setup(),{store}=context;
  try {
    saved(context,'A1');const twenty=await local(context,'20'),twentyTwo=await local(context,'22');
    const before=report(store,twentyTwo),ownJson=JSON.stringify(before.claims);
    assert.equal(before.shared.groups.length,2);
    assert.equal(before.claims[0].assignmentEvidence[0].author,'Contributor 22');
    assert.equal(before.claims[0].assignmentEvidence[1].statement,'Evidence for route 22.');
    assert.ok(before.claims[0].uncertainty.includes('Section 22 signs are unverified.'));
    assert.ok(!before.claims[0].uncertainty.includes('Section 20 signs are unverified.'));
    withdrawLocalRoute(store,'20',{version:1,reason:'Synthetic withdrawal.'});
    assert.equal(report(store,twentyTwo).shared.groups.length,1);
    const revised=await local(context,'20',{version:1,note:'New section evidence for the second revision.'});
    assert.equal(report(store,twentyTwo).shared.groups.length,2);
    assert.equal(JSON.stringify(report(store,twentyTwo).claims),ownJson);
    const old=routeMembershipReport(store.db,twenty.feature.id,twenty.revision);
    assert.equal(old.shared,null);assert.equal(old.claims[0].assignmentEvidence[1].statement,'Evidence for route 20.');
    assert.equal(report(store,revised).claims[0].assignmentEvidence[1].statement,'New section evidence for the second revision.');
  } finally {store.close();}
});

test('same segment IDs with changed coordinates are flagged, while coordinate-only crossings cannot create concurrency',()=>{
  const context=setup(),{store}=context;
  try {
    const a=saved(context,'A1');
    saved(context,'24',{metro:true,sourceCode:'A1',coords:[[145,-37.85],[145.0011,-37.85]]});
    saved(context,'26',{metro:true,pfi:2,sourceCode:'A1'});
    const result=report(store,a);
    assert.equal(result.shared.groups.length,1);
    assert.equal(result.shared.groups[0].sections[0].geometryMatches,false);
    assert.equal(result.shared.groups[0].route.code,'24');
  } finally {store.close();}
});

test('metropolitan, unconfirmed numeric and historical identities stay separate; aliases are not concurrency',()=>{
  assert.notEqual(routeIdentity({name:'Numbered Route 24',roadRoute:{code:'24'}}).key,
    routeIdentity({name:'Metropolitan Route 24',roadRoute:{code:'24'}}).key);
  assert.notEqual(routeIdentity({name:'National Route 1',roadRoute:{code:'1'}}).key,
    routeIdentity({name:'A1',roadRoute:{code:'A1'}}).key);
  const context=setup(),{store}=context;
  try {
    const a=saved(context,'A1');saved(context,'A1',{name:'Route A1'});
    assert.equal(report(store,a).shared.groups.length,0);
  } finally {store.close();}
});

test('backfill is restart-safe and does not rewrite geometry or original provenance',()=>{
  const dir=mkdtempSync(join(tmpdir(),'geoxpl-memberships-')),path=join(dir,'test.sqlite');
  let context=setup(path),store=context.store;
  try {
    const a=saved(context,'A1');
    const original=store.db.prepare('SELECT data FROM derivations WHERE id=?').get(a.revision).data;
    store.db.prepare('DELETE FROM route_memberships WHERE revision_id=?').run(a.revision);
    store.db.prepare('DELETE FROM route_membership_revisions WHERE revision_id=?').run(a.revision);
    store.close();store=createStore(path);
    assert.equal(indexRouteRevision(store.db,a.revision,'saved_inputs_backfill'),true);
    assert.equal(indexRouteRevision(store.db,a.revision,'saved_inputs_backfill'),false);
    assert.equal(report(store,a).origin,'saved_inputs_backfill');
    assert.equal(store.db.prepare('SELECT data FROM derivations WHERE id=?').get(a.revision).data,original);
    assert.equal(store.featureRevisions(a.feature.id).length,1);
    store.close();store=createStore(path);
    assert.equal(report(store,a).claims.length,1);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('DTP assignments are retained without conflating OBJECTID with a Vicmap PFI',()=>{
  const context=setup(),{store,sourceId}=context;
  try {
    saved(context,'A1');
    const job=store.request('M4','road_route'),native={...record(),id:'1',properties:{OBJECTID:1,SRNS:'M4',RD_NAME:'Synthetic Shared',RD_TYPE:'Road'}};
    const importId=store.addImport(sourceId,job.id,'synthetic-dtp',{type:'FeatureCollection',features:[native]},
      {adapter:'dtp-srns-snapshot/1'});
    const feature=store.saveFeature(job,{identityKey:'dtp:road-route:M4',method:'dtp_exact_srns_code',status:'partially_resolved',
      roadRoute:{code:'M4',segments:1},geometry:{type:'MultiLineString',coordinates:[coordinates]},warnings:['Topology is unavailable.'],
      evidence:[{sourceId,objectId:'1',importId,sourceName:'Synthetic DTP input'}]});
    const r=routeMembershipReport(store.db,feature.id,store.featureRevisions(feature.id)[0].id);
    assert.equal(r.claims[0].segmentKey,'dtp:managed-road:1');
    assert.equal(r.claims[0].assignmentEvidence[0].field,'SRNS');
    assert.equal(r.shared.groups.length,0);
  } finally {store.close();}
});

test('unrecoverable records and assignments never manufacture memberships; late indexing failures roll back publication',()=>{
  const context=setup(),{store}=context;
  try {
    const incomplete=saved(context,'A1',{sourceCode:'A10'});
    assert.equal(report(store,incomplete).claims.length,0);
    assert.equal(report(store,incomplete).coverage.unlinked,1);
    store.db.exec("CREATE TRIGGER stop_membership BEFORE INSERT ON route_memberships BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END");
    const before=store.features().length,derivations=store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n;
    assert.throws(()=>saved(context,'M1'),/synthetic index failure/);
    assert.equal(store.features().length,before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n,derivations);
  } finally {store.close();}
});

test('public provenance exposes both membership claims but cannot attach another feature revision',async()=>{
  const context=setup(),{store}=context;
  const a=saved(context,'A1'),b=saved(context,'24',{metro:true,sourceCode:'A1'});
  const server=createApp(store).listen(0,'127.0.0.1');
  try {
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
    const root=`http://127.0.0.1:${server.address().port}/api/features/${a.feature.id}/provenance`;
    const response=await fetch(root);assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.routeMemberships.shared.groups[0].route.code,'24');
    assert.equal(body.routeMemberships.shared.groups[0].sections[0].membership.certainty,'candidate');
    assert.equal((await fetch(root+`?revision=${b.revision}`)).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});
