import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../server/store.js';
import {createWorker} from '../server/worker.js';
import {createApp} from '../server/app.js';
import {sourceChangeTargets,selectSources,contextualSource,sourceKey} from '../server/source-selection.js';
const base='https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/ahgf/Geofabric_V3x_All_Products';
const source={name:'Fixture',type:'river',format:'arcgis',url:base+'/MapServer/6',nameField:'name',idField:'objectid',licence:'Fixture',attribution:'Fixture',version:'3.3',completeness:'unknown',aliases:[],notes:''};
function add(store,data=source,status='approved'){const id=store.addSource(data);store.decideSource(id,status,data);return store.sources().find(s=>s.id===id);}
function settled(store,name,status='partially_resolved'){const j=store.request(name,'river');store.updateJob(j.id,status,status==='resolved'?'completed':'awaiting_data','Fixture');return store.getJob(j.id);}
test('known BoM aliases deduplicate without merging different layers or arbitrary ArcGIS services',()=>{
  assert.equal(sourceKey(source),sourceKey({...source,url:base+'/FeatureServer/6',idField:'hydroid',version:'V3.3'}));
  assert.notEqual(sourceKey(source),sourceKey({...source,url:base+'/FeatureServer/24'}));
  assert.notEqual(sourceKey({...source,url:'https://example.org/MapServer/6'}),sourceKey({...source,url:'https://example.org/FeatureServer/6'}));
});
test('preferred and current source identities win deduplication and contextual layers stay out of imports',()=>{
  const store=createStore(':memory:');try{
    const a=add(store),b=add(store,{...source,url:base+'/FeatureServer/6',idField:'hydroid'}),job=settled(store,'Test River');
    add(store,{...source,url:base+'/MapServer/10'});
    const result=selectSources(store,job,{preferredSourceId:b.id});
    assert.deepEqual(result.selected.map(s=>s.id),[b.id]);assert.equal(result.duplicates.length,1);
    store.saveFeature(job,{status:'partially_resolved',selection:{sourceId:a.id},evidence:[]});
    assert.equal(selectSources(store,job,{}).selected[0].id,a.id);
    assert.equal(contextualSource({...source,url:'https://example.org/MapServer/10'}),false);
  }finally{store.close();}
});
test('contextual waterbody approval never fans out to unrelated river requests',()=>{
  const store=createStore(':memory:');try{
    const s=add(store,{...source,url:base+'/MapServer/10'},'pending'),j=settled(store,'Avoca River');
    store.report(j.id,{candidateIds:[s.id],nextSteps:[]});
    assert.deepEqual(sourceChangeTargets(store,s,s,'approved'),{invalidate:[],retry:[]});
  }finally{store.close();}
});
test('approval queues only a latest recommendation, positive prior match or explicit setting',()=>{
  const store=createStore(':memory:');try{
    const s=add(store,source,'pending'),recommended=settled(store,'Recommended'),matched=settled(store,'Matched'),explicit=settled(store,'Explicit'),unrelated=settled(store,'Unrelated'),resolved=settled(store,'Resolved','resolved'),historical=settled(store,'Historical');
    store.report(recommended.id,{candidateIds:[s.id]});store.report(resolved.id,{candidateIds:[s.id]});
    store.report(historical.id,{candidateIds:[s.id]});store.report(historical.id,{candidateIds:[]});
    store.setFeatureSettings(explicit.id,{aliases:[],preferredSourceId:s.id});
    store.addImport(s.id,matched.id,'fixture',{type:'FeatureCollection',features:[{id:1}]},{});
    store.addImport(s.id,unrelated.id,'empty',{type:'FeatureCollection',features:[]},{});
    assert.deepEqual(new Set(sourceChangeTargets(store,s,s,'approved').retry),new Set([recommended.id,matched.id,explicit.id]));
  }finally{store.close();}
});
test('revocation invalidates published dependents without automatically retrying or researching',()=>{
  const store=createStore(':memory:');try{
    const s=add(store),dependent=settled(store,'Dependent','resolved'),active=store.request('Active','river');
    for(const j of [dependent,active])store.saveFeature(j,{status:'resolved',selection:{sourceId:s.id},evidence:[{sourceId:s.id}]});
    const result=sourceChangeTargets(store,s,s,'rejected');
    assert.deepEqual(new Set(result.invalidate),new Set([dependent.id,active.id]));assert.deepEqual(result.retry,[]);
    assert.deepEqual(sourceChangeTargets(store,s,{...s,name:'New label',notes:'Edited notes'},'approved'),{invalidate:[],retry:[]});
  }finally{store.close();}
});
test('worker performs one import for equivalent sources and excludes waterbody geometry',async()=>{
  const store=createStore(':memory:');let worker;try{
    const a=add(store),b=add(store,{...source,url:base+'/FeatureServer/6'});add(store,{...source,url:base+'/MapServer/10'});
    const job=store.request('Test River','river');store.setFeatureSettings(job.id,{aliases:[],preferredSourceId:b.id});store.setProcessingPolicy(job.id,{allowResearch:false});
    const calls=[];worker=createWorker(store,{importer:async s=>{calls.push(s.id);return {checksum:'empty',payload:{type:'FeatureCollection',features:[]},metadata:{},truncated:false};}});
    await worker.tick();assert.deepEqual(calls,[b.id]);
    assert.ok(store.db.prepare('SELECT action FROM events WHERE job_id=?').all(job.id).some(e=>e.action==='source_duplicate_skipped'));
  }finally{worker?.stop();store.close();}
});
test('authenticated approval queues only related jobs and contextual approval leaves the queue unchanged',async()=>{
  const store=createStore(':memory:'),server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}`;let cookie;
  const send=(path,method,body)=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  try{
    const setup=await send('/api/admin/setup','POST',{password:'fixture-selection-password'});cookie=setup.headers.get('set-cookie').split(';')[0];
    const s=add(store,source,'pending'),related=settled(store,'Related'),unrelated=settled(store,'Unrelated','resolved');
    store.report(related.id,{candidateIds:[s.id]});
    let response=await send(`/api/admin/sources/${s.id}`,'PATCH',{...source,status:'approved'});
    assert.equal(response.status,200);assert.equal((await response.json()).queued,1);
    assert.equal(store.getJob(related.id).phase,'queued');assert.equal(store.getJob(unrelated.id).status,'resolved');
    const context={...source,url:base+'/MapServer/10'},c=add(store,context,'pending');
    response=await send(`/api/admin/sources/${c.id}`,'PATCH',{...context,status:'approved'});
    assert.equal((await response.json()).queued,0);assert.equal(store.getJob(related.id).attempts,1);
    response=await send(`/api/admin/sources/${s.id}`,'PATCH',{...source,name:'Updated label',status:'approved'});
    assert.equal((await response.json()).queued,0);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});
