import test from 'node:test';
import assert from 'node:assert/strict';
import { forestSource,forestVersion,importStateForest,processStateForest,listStateForests } from '../server/state-forests.js';
import { createStore,featureSearchTerms } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { processGeometry } from '../server/processors.js';
import { createApp } from '../server/app.js';
import { research,sourceSchema } from '../server/research.js';

const source={...forestSource,id:'official',status:'approved'};
const ring=(x,y,n=.1)=>[[x,y],[x+n,y],[x+n,y+n],[x,y+n],[x,y]];
const parcel=(id=1)=>({type:'Feature',id:`plm25.${id}`,properties:{plm_id:id,name:'TEST STATE FOREST',label:'Test State Forest',mmgt_ongen:'STATE FOREST',mmtgen:'STATE FOREST',vers_date:'2026-10-29T00:00:00Z'},geometry:{type:'Polygon',coordinates:[ring(144,-37),ring(144.02,-36.98,.02).reverse()]}});
const loader=records=>async url=>{const p=new URL(url).searchParams;assert.equal(p.get('typeNames'),'open-data-platform:plm25');assert.equal(p.get('srsName'),'EPSG:4326');const features=records.slice(Number(p.get('startIndex')),Number(p.get('startIndex'))+Number(p.get('count')));return {type:'FeatureCollection',numberMatched:records.length,numberReturned:features.length,features};};
const imported=records=>({source,id:'snapshot',payload:{type:'FeatureCollection',features:records},metadata:{adapter:forestVersion,retrievedAt:'2026-11-01'},truncated:false,checksum:'test'});

test('state forest searches are case-insensitive, suffix-optional and safely escaped',async()=>{
  const r=await importStateForest(source,"Test",loader([parcel()]));assert.equal(r.payload.features.length,1);assert.ok(r.metadata.requests[0].includes('cql_filter='));
  assert.deepEqual(featureSearchTerms('TEST STATE FOREST','state_forest'),['test','test state forest']);
  await importStateForest(source,"O'Brien",async url=>{assert.ok(new URL(url).searchParams.get('cql_filter').includes("O''BRIEN"));return {type:'FeatureCollection',numberMatched:0,numberReturned:0,features:[]};});
  assert.equal(sourceSchema.safeParse(forestSource).success,true);
});
test('WFS paging retains every matching parcel and records exact queries',async()=>{
  const records=Array.from({length:201},(_,i)=>parcel(i+1));const r=await importStateForest(source,'Test',loader(records));assert.equal(r.payload.features.length,201);assert.equal(r.metadata.requests.length,2);
  const listed=await listStateForests(source,loader(records));assert.deepEqual(listed.names,['Test State Forest']);assert.equal(listed.recordCount,201);
});
test('source approval, endpoint and configured identity fields are required',async()=>{
  for(const bad of [{status:'pending'},{url:'https://example.org'},{idField:'name'},{licence:''}])await assert.rejects(importStateForest({...source,...bad},'Test',loader([])),/approved official/);
});
test('incomplete pages, changing counts, duplicates and non-WGS84 data fail closed',async()=>{
  for(const d of [{type:'FeatureCollection',features:[],numberMatched:null,numberReturned:0},{type:'FeatureCollection',features:[],numberMatched:1,numberReturned:0},{type:'FeatureCollection',features:[parcel(),parcel()],numberMatched:2,numberReturned:2},{type:'FeatureCollection',features:[parcel()],numberMatched:1,numberReturned:1,crs:{name:'EPSG:3857'}}])await assert.rejects(importStateForest(source,'Test',async()=>d));
  const load=loader(Array.from({length:201},(_,i)=>parcel(i+1)));await assert.rejects(importStateForest(source,'Test',async u=>{const d=await load(u);if(new URL(u).searchParams.get('startIndex')==='200')d.numberMatched=202;return d;}),/inconsistent/);
});
test('unnamed, differently named, plantation or park parcels cannot masquerade as a state forest',async()=>{
  for(const change of [p=>p.name=' ',p=>p.name='OTHER STATE FOREST',p=>p.mmtgen='PLANTATION',p=>p.mmgt_ongen='NATIONAL PARK']){const r=parcel();change(r.properties);await assert.rejects(importStateForest(source,'Test',loader([r])));}
});
test('forest assembly preserves holes and disjoint polygons, with no interpolated joins',()=>{
  const second=parcel(2);second.geometry={type:'Polygon',coordinates:[ring(145,-37)]};
  const output=processGeometry({query:'Test State Forest',type:'state_forest'},[imported([parcel(),second])],null);
  assert.equal(output.status,'resolved');const r=output.result;assert.equal(r.geometry.type,'MultiPolygon');assert.equal(r.geometry.coordinates.length,2);assert.ok(r.geometry.coordinates.some(p=>p.length===2));assert.equal(r.interpolations,undefined);
  assert.equal(r.forest.parcelCount,2);assert.deepEqual(r.forest.sourceVersionDates,['2026-10-29T00:00:00Z']);assert.equal(r.evidence[0].licence,'CC BY 4.0');
});
test('invalid geometry and duplicate parcel identities cannot publish',()=>{
  const r=parcel();r.geometry.coordinates[0].pop();assert.throws(()=>processStateForest(imported([r])),/unclosed/);
  assert.throws(()=>processStateForest(imported([parcel(),parcel()])),/identifier/);
});
test('blank labels fall back to the published name and unnamed land is not manufactured',async()=>{
  const r=parcel();r.properties.label=' ';const result=processStateForest(imported([r]))[0].result;assert.equal(result.displayName,'TEST STATE FOREST');assert.match(result.forest.limitations[0],/Unnamed forest land/);
});
test('worker saves the new feature type and repeated suffix searches reuse its catalogue entry',async()=>{
  const store=createStore(':memory:');let worker;try{
    const id=store.addSource(forestSource);store.decideSource(id,'approved',forestSource);const job=store.request('Test State Forest','state_forest');
    const snapshot=await importStateForest({...source,id},'Test',loader([parcel()]));worker=createWorker(store,{importer:async()=>snapshot,researcher:()=>{throw Error('No AI');}});await worker.tick();
    assert.equal(store.getJob(job.id).status,'resolved');assert.equal(store.features()[0].type,'state_forest');assert.equal(store.request('test','state_forest').id,job.id);
    assert.equal((await research({type:'state_forest'},null,'Missing')).provider,'official PLM25 catalogue');
  }finally{worker?.stop();store.close();}
});
test('public config, catalogue, search and feature endpoints include state forests',async()=>{
  const store=createStore(':memory:'),job=store.request('Test State Forest','state_forest');const f=store.saveFeature(job,processStateForest(imported([parcel()]))[0].result);store.updateJob(job.id,'resolved','completed','Ready');
  const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{
    const base=`http://127.0.0.1:${server.address().port}/api`;assert.ok((await(await fetch(`${base}/config`)).json()).types.includes('state_forest'));
    assert.equal((await(await fetch(`${base}/catalogue`)).json())[0].type,'state_forest');assert.equal((await(await fetch(`${base}/features/${f.id}`)).json()).forest.parcelCount,1);
    const response=await fetch(`${base}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'test',type:'state_forest'})});assert.equal(response.status,200);
  }finally{await new Promise(r=>server.close(r));store.close();}
});
