import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { capadSource, capadEndpoint, capadVersion, capadDate, importNationalParks, listVictorianNationalParks, processNationalParks, downloadVictorianNationalParks } from '../server/capad.js';
import { createStore, featureSearchTerms } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { processGeometry } from '../server/processors.js';
import { createApp } from '../server/app.js';
import { enqueueBatch, batchStatus } from '../server/batches.js';
import { sourceSchema } from '../server/research.js';
import { research } from '../server/research.js';

const source={...capadSource,id:'capad-source',status:'approved'};
const ring=(x,y,n=.1)=>[[x,y],[x+n,y],[x+n,y+n],[x,y+n],[x,y]];
const park=(id=1,name='Test',paId='VIC_1')=>({type:'Feature',properties:{OBJECTID:id,NAME:name,PA_ID:paId,PA_PID:`${paId}_${id}`,STATE:'VIC',TYPE:'National Park',TYPE_ABBR:'NP',NRS_PA:'Y',AUTHORITY:'PV',ENVIRON:'T'},geometry:{type:'Polygon',coordinates:[ring(144,-37),ring(144.02,-36.98,.02).reverse()]}});
const meta={description:'Data current for 30 June 2024',geometryType:'esriGeometryPolygon',fields:['OBJECTID','NAME','PA_ID','PA_PID','TYPE','TYPE_ABBR','STATE','NRS_PA'].map(name=>({name}))};
const loader=records=>async url=>{
  const u=new URL(url);if(!u.pathname.endsWith('/query'))return meta;
  const params=u.searchParams,where=params.get('where');
  if(params.has('returnIdsOnly'))return {objectIds:records.filter(f=>!where.includes('UPPER(NAME)')||where.includes(`'${f.properties.NAME.toUpperCase()}'`)).map(f=>f.properties.OBJECTID)};
  const ids=params.get('objectIds').split(',').map(Number),selected=records.filter(f=>ids.includes(f.properties.OBJECTID));
  return {features:params.get('f')==='geojson'?selected:selected.map(f=>({attributes:f.properties}))};
};
const item=(records)=>({source,id:'import',payload:{type:'FeatureCollection',features:records},metadata:{adapter:capadVersion,snapshotDate:capadDate,retrievedAt:'2026-10-14'},truncated:false,checksum:'fixture'});

test('CAPAD importer accepts suffix/case variants and fetches complete parent identity',async()=>{
  const r=await importNationalParks(source,'TEST National Park',loader([park()]));
  assert.equal(r.payload.features.length,1);assert.deepEqual(r.metadata.parentIds,['VIC_1']);assert.equal(r.truncated,false);
  assert.deepEqual(featureSearchTerms('Test National Park','national_park'),['test','test national park']);
  assert.ok(r.metadata.requests.some(u=>new URL(u).searchParams.get('where')?.includes('PA_ID IN')));
});
test('CAPAD rejects unapproved or substituted endpoints and changed editions',async()=>{
  await assert.rejects(importNationalParks({...source,status:'pending'},'Test',loader([])),/approved/);
  await assert.rejects(importNationalParks({...source,url:'https://example.org/0'},'Test',loader([])),/official/);
  await assert.rejects(importNationalParks(source,'Test',async()=>({...meta,description:'30 June 2026'})),/edition changed/);
  assert.equal(sourceSchema.safeParse(capadSource).success,true);
});
test('incomplete IDs, missing, duplicate, unrelated and wrong-CRS records fail closed',async()=>{
  for(const bad of [{objectIds:[1],exceededTransferLimit:true},{objectIds:[1,1]},{objectIds:['1']},{}])await assert.rejects(importNationalParks(source,'Test',async u=>u.includes('/query?')?bad:meta),/object-ID/);
  for(const transform of [()=>({features:[]}),d=>({...d,crs:{name:'EPSG:3857'}}),d=>({...d,features:d.features.map(f=>({...f,properties:{...f.properties,TYPE:'State Park'}}))})]){
    const load=loader([park()]);await assert.rejects(importNationalParks(source,'Test',async u=>{const d=await load(u);return new URL(u).searchParams.get('f')==='geojson'?transform(d):d;}));
  }
});
test('park processing preserves holes and disconnected parts without a convex hull or interpolation',()=>{
  const first=park(),second=park(2);second.geometry={type:'MultiPolygon',coordinates:[[ring(145,-37)],[ring(146,-37)]]};
  const r=processNationalParks(item([first,second]))[0].result;
  assert.equal(r.geometry.type,'MultiPolygon');assert.equal(r.geometry.coordinates.length,3);assert.ok(r.geometry.coordinates.some(p=>p.length===2));
  assert.equal(r.status,'resolved');assert.equal(r.park.paId,'VIC_1');assert.equal(r.park.boundaryDate,'2024-06-30');assert.equal(r.evidence.length,2);
  const output=processGeometry({query:'Test National Park',type:'national_park'},[item([first,second])],null,{estimatedConnections:[{coordinates:[[144,-37],[145,-37]],label:'Do not apply',evidenceUrl:'https://example.org',evidenceRecord:'test'}]});
  assert.equal(output.status,'resolved');assert.equal(output.result.interpolations,undefined);
});
test('same names with different PA_IDs remain distinct selection choices',()=>{
  const output=processGeometry({query:'Test National Park',type:'national_park'},[item([park(),park(2,'Test','VIC_2')])],null);
  assert.equal(output.results.length,2);assert.notEqual(output.results[0].identityKey,output.results[1].identityKey);assert.notEqual(output.results[0].displayName,output.results[1].displayName);
});
test('classification, broken rings and nonfinite geometry cannot publish',()=>{
  for(const changed of [r=>r.properties.STATE='NSW',r=>r.properties.NRS_PA='I',r=>r.properties.TYPE_ABBR='PNPA',r=>r.geometry.coordinates[0].pop(),r=>r.geometry.coordinates[0][1][0]=Infinity]){
    const record=park();changed(record);assert.throws(()=>processNationalParks(item([record])));
  }
});
test('catalogue discovery groups parcels by PA_ID and snapshot cache avoids per-park network calls',async()=>{
  const records=[park(),park(2)],listed=await listVictorianNationalParks(source,loader(records));assert.equal(listed.parks.length,1);assert.equal(listed.parks[0].objectIds.length,2);
  const snapshot=await downloadVictorianNationalParks(source,loader(records));
  const r=await importNationalParks(source,'Test National Park',()=>{throw Error('No request expected');},{},snapshot);assert.equal(r.payload.features.length,2);assert.equal(r.metadata.catalogueChecksum,snapshot.checksum);
  await assert.rejects(importNationalParks(source,'Test',undefined,{}, {...snapshot,checksum:'changed'}),/changed/);
});
test('bulk parks use durable no-AI jobs and published catalogue entries',async()=>{
  const store=createStore(':memory:');let worker;
  try {
    const id=store.addSource(capadSource);store.decideSource(id,'approved',capadSource);
    const snapshot=await downloadVictorianNationalParks({...source,id},loader([park()]));
    store.addImport(id,'capad-victoria-2024',snapshot.checksum,snapshot.payload,snapshot.metadata);
    const manifest={id:'capad-test-batch',name:'CAPAD parks',selectionNote:'Published Victorian national parks fixture',entries:[{query:'Test National Park',type:'national_park'}]};
    enqueueBatch(store,manifest);assert.equal(enqueueBatch(store,manifest).created,false);
    worker=createWorker(store,{researcher:()=>{throw Error('AI must not run');}});await worker.tick();
    assert.equal(batchStatus(store,manifest.id).counts.resolved,1);assert.equal(store.features()[0].type,'national_park');
    assert.equal(store.features()[0].evidence[0].licence,'CC BY 4.0');assert.equal(store.processingPolicy(store.jobs()[0].id).allowResearch,false);
    assert.equal(store.request('test','national_park').id,store.jobs()[0].id);
  } finally {worker?.stop();store.close();}
});
test('public API exposes parks in config, catalogue and case-insensitive cached searches',async()=>{
  const store=createStore(':memory:');const job=store.request('Test National Park','national_park');store.saveFeature(job,processNationalParks(item([park()]))[0].result);store.updateJob(job.id,'resolved','completed','Ready');
  const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const base=`http://127.0.0.1:${server.address().port}/api`;
    assert.ok((await (await fetch(`${base}/config`)).json()).types.includes('national_park'));
    assert.equal((await (await fetch(`${base}/catalogue`)).json())[0].type,'national_park');
    const response=await fetch(`${base}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'TEST',type:'national_park'})});assert.equal(response.status,200);assert.equal((await response.json()).id,job.id);
  } finally {await new Promise(r=>server.close(r));store.close();}
});
test('park research never fabricates boundaries or dispatches an AI request',async()=>{
  const r=await research({type:'national_park'},null,'Unavailable');assert.equal(r.provider,'official CAPAD catalogue');assert.equal(r.candidates[0].url,capadEndpoint);
});
