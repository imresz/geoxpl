import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createWorker } from '../server/worker.js';
import { buildRoadRoute,routeSource } from '../server/road-routes.js';
import { routeQuality,withRouteQuality } from '../server/route-quality.js';
import { roadName,routeSearchInput,namedRouteMatches,lookupRoadLocality,lookupPublicRoute,queueRouteDiscovery,runRouteDiscovery,getRouteDiscovery,routeDiscoveryView,backfillRouteNames } from '../server/route-discovery.js';

const boundary={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[141,-39],[150,-39],[150,-34],[141,-34],[141,-39]]]}};
const page=features=>({type:'FeatureCollection',numberMatched:features.length,numberReturned:features.length,features});
const metadata=pfi=>({type:'Feature',properties:{pfi,ezi_road_name:'MT DANDENONG ROAD',left_locality:'MONTROSE',right_locality:'MONTROSE',route_no:null}});
function save(store,code='M1',pfi=1,name='Mt Dandenong Road') {
  const job=store.request(code,'road_route'),sourceId=store.addSource(routeSource);
  const record={type:'Feature',id:`tr_road.${pfi}`,geometry:{type:'LineString',coordinates:[[145.33,-37.81],[145.34,-37.81]]},
    properties:{pfi,route_no:code,from_ufi:pfi,to_ufi:pfi+1,ezi_road_name:name}};
  const metadata={retrievedAt:'2026-01-01T00:00:00Z'},snapshot={records:[record],metadata};
  const importId=store.addImport(sourceId,job.id,'fixture',{type:'FeatureCollection',features:[record]},metadata);
  const {result}=buildRoadRoute(code,snapshot,boundary);
  const feature=store.saveFeature(job,{...result,evidence:[{sourceId,sourceName:'Fixture',sourceUrl:routeSource.url,importId,checksum:'fixture',objectId:record.id,pfi}]});
  store.updateJob(job.id,'resolved','completed','Ready',feature.id);return feature;
}
const osm=()=>({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[{type:'way',id:123,version:3,timestamp:'2025-12-01T00:00:00Z',
  center:{lon:145.34,lat:-37.81},tags:{highway:'primary',name:'Mt Dandenong Road',ref:'B54',old_ref:'62','proposed:ref':'B54'}}]});

test('road abbreviations are exact equivalents, not fuzzy name merges; schemes and locality keys stay separate',()=>{
  assert.equal(roadName('  MT. Dandenong RD. '),'mount dandenong road');
  assert.notEqual(roadName('Mount Dandenong Tourist Road'),roadName('Mt Dandenong Road'));
  assert.notEqual(routeSearchInput('B54').key,routeSearchInput('B54, Montrose').key);
  assert.notEqual(routeSearchInput('State Route 24').key,routeSearchInput('Numbered Route 24').key);
  assert.equal(routeSearchInput('National Route 1').historical,true);
  assert.throws(()=>routeSearchInput('A road, A place, Another place'));
});

test('indexed names return separate concurrent routes and only active latest geometry; backfill is idempotent',()=>{
  const store=createStore(':memory:');try{
    const a=save(store),b=save(store,'A1'),input=routeSearchInput('Mount Dandenong Rd');
    assert.deepEqual(new Set(namedRouteMatches(store,input).map(f=>f.id)),new Set([a.id,b.id]));
    assert.equal(namedRouteMatches(store,input,[{pfi:2}]).length,0);
    assert.equal(namedRouteMatches(store,input,[{pfi:1}]).length,2);
    const before=store.db.prepare('SELECT data FROM derivations ORDER BY rowid').all();
    store.db.exec('DELETE FROM route_road_names;DELETE FROM route_discovery_indexed');backfillRouteNames(store.db);backfillRouteNames(store.db);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM route_road_names').get().n,2);
    assert.deepEqual(store.db.prepare('SELECT data FROM derivations ORDER BY rowid').all(),before);
    store.db.prepare('UPDATE features SET active=0 WHERE id=?').run(a.id);
    assert.deepEqual(namedRouteMatches(store,input).map(f=>f.id),[b.id]);
  }finally{store.close();}
});

test('locality adapter expands publisher abbreviations, quotes literals and validates exact locality plus complete paging',async()=>{
  let url;
  const result=await lookupRoadLocality(routeSearchInput('Mount Dandenong Rd, montrose'),async u=>{url=new URL(u);return page([metadata(1)]);});
  assert.equal(result.records[0].pfi,1);
  assert.match(url.searchParams.get('cql_filter'),/'MT DANDENONG ROAD'/);
  assert.match(url.searchParams.get('cql_filter'),/left_locality='MONTROSE'/);
  await lookupRoadLocality(routeSearchInput("O'Brien Road, A'B"),async u=>{assert.match(new URL(u).searchParams.get('cql_filter'),/O''BRIEN/);return page([]);});
  await assert.rejects(lookupRoadLocality(routeSearchInput('Mt Dandenong Road, Montrose'),async()=>page([{...metadata(1),properties:{...metadata(1).properties,left_locality:'ELSEWHERE',right_locality:'ELSEWHERE'}}])),/did not match/);
  await assert.rejects(lookupRoadLocality(routeSearchInput('Mt Dandenong Road, Montrose'),async()=>({...page([]),numberMatched:1})),/incomplete/);
  await assert.rejects(lookupRoadLocality(routeSearchInput('Mt Dandenong Road, Montrose'),async()=>page([metadata(1),metadata(1)])),/did not match/);
});

test('public metadata distinguishes reported assignment, proposed and historical tags without publishing geometry',async()=>{
  const result=await lookupPublicRoute(routeSearchInput('B54'),boundary,async u=>{assert.equal(new URL(u).hostname,'overpass.kumi.systems');return osm();});
  assert.equal(result.records[0].claims[0].status,'reported_assignment');
  assert.equal(result.records[0].claims[1].status,'reported_proposed');
  assert.equal(result.records[0].geometry,undefined);
  assert.match(result.note,/not an official/);
  const historic=await lookupPublicRoute(routeSearchInput('62'),boundary,async()=>osm());
  assert.equal(historic.records[0].claims[0].status,'reported_historical');
  const out=osm();out.elements[0].center.lat=-42;
  assert.equal((await lookupPublicRoute(routeSearchInput('B54'),boundary,async()=>out)).records.length,0);
  await assert.rejects(lookupPublicRoute(routeSearchInput('B54'),boundary,async()=>({...osm(),remark:'timed out'})),/incomplete/);
});

test('bounded locality check uses public map JSON, filters route tags and cannot publish unrelated or oversized coverage',async()=>{
  const input=routeSearchInput('B54, Montrose');let calls=0;
  const load=async u=>{calls++;if(new URL(u).hostname==='opendata.maps.vic.gov.au')return {...page([{...metadata(1),geometry:{type:'LineString',coordinates:[[145.33,-37.81],[145.34,-37.80]]}}]),crs:{properties:{name:'EPSG:4326'}}};
    assert.match(u,/map.json/);return {elements:[{type:'node',id:1,lon:145.33,lat:-37.81},{type:'way',id:123,nodes:[1],version:2,tags:{highway:'primary',name:'Example Road',ref:'B54'}}]};};
  const result=await lookupPublicRoute(input,boundary,load);
  assert.equal(calls,2);assert.equal(result.records[0].id,123);assert.equal(result.records[0].geometry,undefined);
  await assert.rejects(lookupPublicRoute(input,boundary,async()=>({...page([]),numberMatched:1001})),/incomplete/);
});

test('research is deduplicated, bounded and never creates a feature or repeats a source failure on an ordinary search',async()=>{
  const store=createStore(':memory:');try{
    const input=routeSearchInput('B54'),queued=queueRouteDiscovery(store,input);
    assert.equal(queueRouteDiscovery(store,input).id,queued.id);
    await runRouteDiscovery(store,queued.id,{boundary,load:async()=>{throw Error('Source returned HTTP 406.');}});
    assert.equal(getRouteDiscovery(store,queued.id).state,'unavailable');
    assert.equal(queueRouteDiscovery(store,input).state,'unavailable');
    await runRouteDiscovery(store,queued.id,{boundary,load:()=>{throw Error('Must not retry');}});
    assert.equal(getRouteDiscovery(store,queued.id).attempts,1);assert.equal(store.features().length,0);assert.equal(store.jobs().length,0);
    assert.throws(()=>queueRouteDiscovery(store,input,{retry:true}),/five minutes/);
    store.db.prepare('UPDATE route_discoveries SET updated=? WHERE id=?').run('2020-01-01T00:00:00Z',queued.id);
    queueRouteDiscovery(store,input,{retry:true});await runRouteDiscovery(store,queued.id,{boundary,load:async()=>osm()});
    assert.equal(getRouteDiscovery(store,queued.id).state,'available');
    assert.equal(routeDiscoveryView(store,getRouteDiscovery(store,queued.id),{history:true}).history.length,4);
    assert.equal(store.features().length,0);
    assert.throws(()=>queueRouteDiscovery(store,routeSearchInput('National Route 1')),/Historical/);
  }finally{store.close();}
});

test('a reboot resumes an interrupted source check, preserves revisions and never invokes AI',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'geoxpl-route-discovery-')),path=join(dir,'test.sqlite');let store=createStore(path),worker;
  try{
    const row=queueRouteDiscovery(store,routeSearchInput('B54'));
    store.db.prepare("UPDATE route_discoveries SET state='running' WHERE id=?").run(row.id);store.close();store=createStore(path);
    worker=createWorker(store,{boundary,routeDiscoveryLoader:async()=>osm(),researcher:()=>{throw Error('No AI');}});
    assert.equal(getRouteDiscovery(store,row.id).state,'queued');await worker.tick();
    assert.equal(getRouteDiscovery(store,row.id).state,'available');
    await worker.tick();assert.equal(getRouteDiscovery(store,row.id).attempts,1);
    assert.equal(store.features().length,0);
  }finally{worker?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('coverage and designation labels are independent projections and do not rewrite stored revisions',()=>{
  const store=createStore(':memory:');try{
    const feature=save(store),before=JSON.stringify(feature);
    const quality=routeQuality(feature);assert.equal(quality.coverage.code,'connected_snapshot');assert.equal(quality.designation.code,'published_assignment');
    assert.match(quality.designation.note,/not been independently/);
    assert.equal(routeQuality({...feature,roadRoute:{...feature.roadRoute,contribution:{author:'Test'}}}).designation.code,'local_claim');
    assert.equal(routeQuality({...feature,status:'partially_resolved',roadRoute:{...feature.roadRoute,review:{}}}).designation.code,'reviewed_candidate');
    assert.equal(withRouteQuality(feature).routeQuality.coverage.code,'connected_snapshot');assert.equal(JSON.stringify(store.feature(feature.id)),before);
  }finally{store.close();}
});

test('public search offers research instead of 404; locality lookup is durable and retries require authentication',async()=>{
  const store=createStore(':memory:'),feature=save(store),server=createApp(store).listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));const root=`http://127.0.0.1:${server.address().port}/api`;
    const post=(path,body)=>fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const search=async query=>(await (await post('/search',{query,type:'road_route'})).json());
    assert.equal((await search('Mount Dandenong Rd')).routeSearch.matches[0].id,feature.id);
    const missing=(await search('B54')).routeSearch;assert.equal(missing.offer.label,'B54');assert.equal(missing.discovery,null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM route_discoveries').get().n,0);
    const named=(await search('Mt Dandenong Road, Montrose')).routeSearch;
    assert.equal(named.discovery.state,'queued');assert.deepEqual(named.matches,[]);
    await runRouteDiscovery(store,named.discovery.id,{boundary,load:async()=>page([metadata(1)])});
    const ready=await (await fetch(root+`/route-discoveries/${named.discovery.id}`)).json();assert.equal(ready.routeSearch.matches[0].id,feature.id);
    const researched=await (await post('/route-discoveries',{query:'B54'})).json();
    assert.equal((await post(`/admin/route-discoveries/${researched.routeSearch.discovery.id}/retry`,{})).status,401);
    const historical=(await search('National Route 1')).routeSearch;assert.equal(historical.offer,null);assert.equal(store.jobs().length,1);
    assert.equal((await search('M1')).feature.routeQuality.designation.code,'published_assignment');
  }finally{await new Promise(r=>server.close(r));store.close();}
});
