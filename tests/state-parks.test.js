import test from 'node:test';
import assert from 'node:assert/strict';
import {stateParkSource,stateParkVersion,importStatePark,processStatePark} from '../server/state-parks.js';
import {forestSource,importStateForest} from '../server/state-forests.js';
import {createStore,featureSearchTerms} from '../server/store.js';
import {createWorker} from '../server/worker.js';
import {processGeometry} from '../server/processors.js';
import {createApp} from '../server/app.js';
import {sourceSchema,research} from '../server/research.js';

const source={...stateParkSource,id:'state-parks',status:'approved'};
const ring=(x,y,n=.1)=>[[x,y],[x+n,y],[x+n,y+n],[x,y+n],[x,y]];
const parcel=(id=1)=>({type:'Feature',id:`plm25.${id}`,properties:{plm_id:id,name:'BUNYIP S.P.',label:'Bunyip State Park',mmgt_ongen:'STATE PARK',mmtgen:'NATIONAL PARKS ACT AND NATURE CONSERVATION RESERVES',vers_date:'2026-11-03T00:00:00Z'},geometry:{type:'Polygon',coordinates:[ring(145,-38),ring(145.02,-37.98,.02).reverse()]}});
const loader=records=>async url=>{const p=new URL(url).searchParams;assert.equal(p.get('typeNames'),'open-data-platform:plm25');const features=records.slice(Number(p.get('startIndex')),Number(p.get('startIndex'))+Number(p.get('count')));return {type:'FeatureCollection',numberMatched:records.length,numberReturned:features.length,features};};
const snapshot=records=>({source,id:'import',payload:{type:'FeatureCollection',features:records},metadata:{adapter:stateParkVersion,retrievedAt:'2026-11-03'},truncated:false,checksum:'fixture'});

test('state-park names are case-insensitive, suffix-optional and match the published label',async()=>{
 const r=await importStatePark(source,'bunyip',loader([parcel()]));assert.equal(r.payload.features.length,1);assert.deepEqual(r.metadata.publisherNames,['bunyip s.p.']);
 assert.deepEqual(featureSearchTerms('Bunyip State Park','state_park'),['bunyip','bunyip state park']);assert.equal(sourceSchema.safeParse(stateParkSource).success,true);
});
test('state parks require separate approved sources and cannot import forests or national parks',async()=>{
 await assert.rejects(importStatePark({...source,status:'pending'},'Bunyip',loader([])),/approved official/);
 await assert.rejects(importStatePark({...forestSource,id:'forest',status:'approved'},'Bunyip',loader([])),/approved official/);
 for(const type of ['STATE FOREST','NATIONAL PARK']){const r=parcel();r.properties.mmgt_ongen=type;await assert.rejects(importStatePark(source,'Bunyip',loader([r])));assert.throws(()=>processStatePark(snapshot([r])));}
 await assert.rejects(importStateForest({...forestSource,status:'approved'},'Bunyip',loader([parcel()])),/non-state-forest/);
});
test('multipart state-park extents preserve holes and disjoint parcels without interpolation',()=>{
 const a=parcel(),b=parcel(2);b.geometry={type:'Polygon',coordinates:[ring(146,-38)]};
 const r=processGeometry({query:'Bunyip State Park',type:'state_park'},[snapshot([a,b])],null).result;
 assert.equal(r.status,'resolved');assert.equal(r.geometry.type,'MultiPolygon');assert.equal(r.geometry.coordinates.length,2);assert.ok(r.geometry.coordinates.some(p=>p.length===2));
 assert.equal(r.statePark.parcelCount,2);assert.equal(r.forest,undefined);assert.equal(r.park,undefined);assert.equal(r.interpolations,undefined);assert.match(r.identityKey,/plm25:state-park:/);
});
test('shared PLM IDs retain distinct WFS records; repeated WFS IDs fail',async()=>{
 const a=parcel(),b=parcel(2);b.properties.plm_id=1;
 const r=await importStatePark(source,'Bunyip',loader([a,b]));const result=processStatePark({...r,source,id:'import'})[0].result;
 assert.deepEqual(result.evidence.map(e=>e.objectId),['plm25.1','plm25.2']);assert.deepEqual(result.evidence.map(e=>e.plmId),[1,1]);assert.equal(result.evidence[0].role,'state_park_parcel');
 await assert.rejects(importStatePark(source,'Bunyip',loader([a,a])),/duplicated/);
});
test('state-park paging and full-name closure cannot silently omit matching parcels',async()=>{
 const records=Array.from({length:201},(_,i)=>parcel(i+1));const r=await importStatePark(source,'Bunyip',loader(records));assert.equal(r.payload.features.length,201);assert.equal(r.metadata.requests.length,4);
 await assert.rejects(importStatePark(source,'Bunyip',async url=>loader(new URL(url).searchParams.get('cql_filter').includes('strTrim(label)')?[parcel()]:[])(url)),/omitted/);
});
test('other classifications are suggestions only and no-match results cannot supply geometry',async()=>{
 const forest=parcel();forest.properties.mmgt_ongen='STATE FOREST';forest.properties.mmtgen='STATE FOREST';forest.properties.name='BUNYIP STATE FOREST';forest.properties.label='Bunyip State Forest';
 const r=await importStatePark(source,'Bunyip',async url=>loader(new URL(url).searchParams.get('cql_filter').startsWith("mmgt_ongen='STATE PARK'")?[]:[forest])(url));
 assert.equal(r.metadata.noMatch.code,'wrong_feature_type');assert.match(r.metadata.noMatch.message,/No State Park matched/);assert.equal(processStatePark({...r,source,id:'import'}).length,0);
});
test('state parks have their own jobs, saved catalogue type and provenance without changing old forest requests',async()=>{
 const store=createStore(':memory:');let worker;try{
  const old=store.request('Bunyip State Park','state_forest');store.updateJob(old.id,'wrong_feature_type','wrong_feature_type','Classified State Park');
  const id=store.addSource(stateParkSource);store.decideSource(id,'approved',stateParkSource);const job=store.request('Bunyip State Park','state_park');
  worker=createWorker(store,{importer:async()=>snapshot([parcel()]),researcher:()=>{throw Error('No AI');}});await worker.tick();
  assert.equal(store.getJob(job.id).status,'resolved');assert.equal(store.getJob(old.id).status,'wrong_feature_type');assert.equal(store.getJob(old.id).type,'state_forest');
  assert.equal(store.features()[0].type,'state_park');assert.equal(store.features()[0].evidence[0].licence,'CC BY 4.0');assert.equal(store.request('bunyip','state_park').id,job.id);
 }finally{worker?.stop();store.close();}
});
test('state-park connection and validation failures retain the specific actionable outcomes',async()=>{
 for(const connection of [true,false]){const store=createStore(':memory:');let worker;try{
  const id=store.addSource(stateParkSource);store.decideSource(id,'approved',stateParkSource);const job=store.request('Bunyip','state_park');
  worker=createWorker(store,{importer:async()=>{if(connection)throw Error('fetch failed');const r=parcel();r.geometry.coordinates[0].pop();return snapshot([r]);}});await worker.tick();
  assert.equal(store.getJob(job.id).status,connection?'source_unavailable':'import_failed');assert.ok(store.reports()[0].data.diagnostics.stateParkDiagnosis);assert.equal(store.reports()[0].data.provider,'state park diagnostics');
 }finally{worker?.stop();store.close();}}
});
test('state-park public config, searches and catalogue entries work independently',async()=>{
 const store=createStore(':memory:'),job=store.request('Bunyip State Park','state_park');store.saveFeature(job,processStatePark(snapshot([parcel()]))[0].result);store.updateJob(job.id,'resolved','completed','Ready');
 const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{
  const base=`http://127.0.0.1:${server.address().port}/api`;
  assert.ok((await(await fetch(`${base}/config`)).json()).types.includes('state_park'));assert.equal((await(await fetch(`${base}/catalogue`)).json())[0].type,'state_park');
  const response=await fetch(`${base}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'BUNYIP',type:'state_park'})});assert.equal(response.status,200);assert.equal((await response.json()).id,job.id);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
test('state-park research points to the official dataset and never needs AI-generated boundaries',async()=>{
 const r=await research({type:'state_park'},null,'No match');assert.equal(r.provider,'official PLM25 catalogue');assert.equal(r.candidates[0].type,'state_park');assert.equal(r.candidates[0].format,'vic-state-park');
});
