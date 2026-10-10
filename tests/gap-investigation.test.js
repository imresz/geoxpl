import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { queueInvestigation,runInvestigation,workflowView,applyInvestigation,changeReportState } from '../server/report-workflow.js';
import { checkGapLayer,assessGap,gapAnchor } from '../server/gap-investigation.js';
import { createWorker } from '../server/worker.js';

const source={name:'Channels',type:'river',format:'arcgis',url:'https://example.org/FeatureServer/1',nameField:'name',idField:'id',licence:'Fixture',attribution:'Fixture',version:'1',completeness:'partial',aliases:[],notes:''};
const polygon={type:'Feature',properties:{id:2,name:'Lake Test'},geometry:{type:'Polygon',coordinates:[[[144.02,-37.01],[144.03,-37.01],[144.03,-36.99],[144.02,-36.99],[144.02,-37.01]]]}};
const channel={type:'Feature',properties:{id:1,name:'Test River'},geometry:{type:'LineString',coordinates:[[144,-37],[144.025,-37]]}};
function fixture(waterbody=true){
  const store=createStore(':memory:'),job=store.request('Test River','river');
  store.saveFeature(job,{name:job.query,status:'partially_resolved',geometry:{type:'LineString',coordinates:[[143.99,-37],[144,-37]]},mouth:{coordinates:[144,-37],classification:'BoM network terminus'},warnings:['Uncertain mouth'],lengthKm:1});
  store.updateJob(job.id,'partially_resolved','awaiting_data','Partial');
  const channelId=store.addSource(source);store.decideSource(channelId,'approved',source);
  if(waterbody){const s={...source,name:'Waterbodies',url:'https://example.org/FeatureServer/2'};const id=store.addSource(s);store.decideSource(id,'approved',s);}
  const reportId=store.report(job.id,{summary:'Fixture',nextSteps:['Check terminal connection'],candidates:[],evidence:[]});
  return {store,job,reportId,channelId};
}
function loader(channels=[]){return async url=>{
  const u=new URL(url),isWater=u.pathname.includes('/2'),records=isWater?[polygon]:channels;
  if (/\/FeatureServer$/.test(u.pathname))return {layers:[]};
  if (!u.pathname.endsWith('/query'))return {objectIdField:'id',geometryType:isWater?'esriGeometryPolygon':'esriGeometryPolyline',fields:[{name:'id',type:'esriFieldTypeOID'},{name:'name'}]};
  if(u.searchParams.has('returnIdsOnly'))return {objectIds:records.map(f=>f.properties.id)};
  return {type:'FeatureCollection',features:records};
};}
const queue=f=>queueInvestigation(f.store,f.reportId,{operation:'gap',targetName:'Lake Test',radiusKm:10,discover:false});

test('gap investigation stores spatial evidence and proposes only a separate estimate',async()=>{
  const f=fixture();try{
    const a=queue(f);await runInvestigation(f.store,a.id,{load:loader()});
    const action=workflowView(f.store,f.reportId).actions[0];
    assert.equal(action.status,'ready');assert.equal(action.result.targets.length,1);assert.equal(action.result.routes.length,0);
    assert.ok(action.result.estimate);assert.equal(action.result.applicable,true);
    assert.equal(f.store.featureSettings(f.job.id).estimatedConnections,undefined);
    assert.equal(f.store.getJob(f.job.id).status,'partially_resolved');assert.equal(f.store.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);
    assert.equal(queue(f).id,a.id,'unchanged results are reused');
  }finally{f.store.close();}
});
test('mapped candidate connection is reported, never automatically appended or certified',async()=>{
  const f=fixture();try{
    const a=queue(f);await runInvestigation(f.store,a.id,{load:loader([channel])});
    const r=workflowView(f.store,f.reportId).actions[0].result;
    assert.equal(r.routes.length,1);assert.equal(r.estimate,undefined);assert.equal(r.applicable,false);
    assert.deepEqual(r.routes[0].recordIds,[1]);assert.equal(f.store.jobFeatures(f.job.id)[0].lengthKm,1);
  }finally{f.store.close();}
});
test('estimated connector application requires explicit review and preserves partial semantics',async()=>{
  const f=fixture();try{
    const a=queue(f);await runInvestigation(f.store,a.id,{load:loader()});
    assert.throws(()=>applyInvestigation(f.store,f.reportId,a.id,{confirmed:true}),/Explicitly/);
    applyInvestigation(f.store,f.reportId,a.id,{confirmed:true,useEstimate:true,note:'Reviewed destination polygon; path remains unknown.'});
    assert.equal(f.store.featureSettings(f.job.id).estimatedConnections.length,1);
    assert.equal(f.store.getJob(f.job.id).phase,'queued');assert.equal(f.store.processingPolicy(f.job.id).allowResearch,false);
    applyInvestigation(f.store,f.reportId,a.id,{confirmed:true,useEstimate:true,note:'Repeat'});
    assert.equal(f.store.featureSettings(f.job.id).estimatedConnections.length,1);
  }finally{f.store.close();}
});
test('new companion waterbody sources remain pending and cannot supply an applied estimate',async()=>{
  const f=fixture(false);try{
    const load=loader();
    const a=queue(f);await runInvestigation(f.store,a.id,{load:async url=>/\/FeatureServer\?/.test(url)?{layers:[{id:2,name:'Waterbodies'}]}:load(url)});
    const r=workflowView(f.store,f.reportId).actions[0].result;
    assert.equal(r.candidateIds.length,1);assert.equal(f.store.sources().find(s=>s.id===r.candidateIds[0]).status,'pending');
    assert.equal(r.targets.length,1);assert.equal(r.applicable,false);
    assert.throws(()=>applyInvestigation(f.store,f.reportId,a.id,{confirmed:true,useEstimate:true,note:'Review'}),/not ready/);
  }finally{f.store.close();}
});
test('restart resumes completed source checks without fetching them again',async()=>{
  const f=fixture();let worker;try{
    const a=queue(f),anchor=gapAnchor(f.store,f.job),s=f.store.sources().find(s=>s.id===f.channelId);
    const checked=await checkGapLayer(s,{targetName:'Lake Test',radiusKm:10},anchor,loader());
    f.store.db.prepare('UPDATE report_actions SET status=?,result=? WHERE id=?').run('running',JSON.stringify({version:'terminal-gap/1',anchor,checks:[checked],discovered:[],serviceChecks:[],research:null}),a.id);
    const load=loader();worker=createWorker(f.store,{investigationLoader:async url=>{assert.ok(!url.includes('/1'),'completed source re-fetched');return load(url);}});
    await worker.tick();assert.equal(workflowView(f.store,f.reportId).actions[0].status,'ready');
  }finally{worker?.stop();f.store.close();}
});
test('cancellation and changed geometry prevent publishing or applying findings',async()=>{
  const f=fixture();try{
    const a=queue(f);let once=false;const load=loader();
    await runInvestigation(f.store,a.id,{load:async url=>{if(!once){once=true;changeReportState(f.store,f.reportId,{state:'deferred',reason:'Cancel'});}return load(url);}});
    assert.equal(workflowView(f.store,f.reportId).actions.find(x=>x.id===a.id).status,'cancelled');
  }finally{f.store.close();}
});
test('partial spatial results, wrong object IDs and invalid geometry are rejected',async()=>{
  const f=fixture();try{
    const s=f.store.sources().find(s=>s.id===f.channelId),anchor=gapAnchor(f.store,f.job),load=loader([channel]);
    await assert.rejects(()=>checkGapLayer(s,{targetName:'Lake Test',radiusKm:10},anchor,async url=>url.includes('returnIdsOnly')?{objectIds:[1],exceededTransferLimit:true}:load(url)),/Incomplete/);
    await assert.rejects(()=>checkGapLayer(s,{targetName:'Lake Test',radiusKm:10},anchor,async url=>url.includes('objectIds=')?{features:[{...channel,properties:{id:3}}]}:load(url)),/requested IDs/);
    assert.throws(()=>queueInvestigation(f.store,f.reportId,{operation:'gap',targetName:'Lake Test',radiusKm:99}));
    assert.throws(()=>queueInvestigation(f.store,f.reportId,{operation:'retry',targetName:'Lake Test'}));
  }finally{f.store.close();}
});
test('AI discovery runs once, preserves citations and does not approve candidates',async()=>{
  const f=fixture(false);try{
    const a=queueInvestigation(f.store,f.reportId,{operation:'gap',targetName:'Lake Test'});let calls=0;
    await runInvestigation(f.store,a.id,{load:loader(),researcher:async()=>{calls++;return {provider:'fixture',summary:'Found source',evidence:[{title:'Official lake',url:'https://example.org/evidence'}],nextSteps:[],candidates:[{...source,name:'Waterbodies',url:'https://example.org/FeatureServer/2'}]};}});
    const r=workflowView(f.store,f.reportId).actions[0].result;assert.equal(calls,1);assert.equal(r.research.evidence.length,1);
    assert.equal(f.store.sources().find(s=>s.id===r.candidateIds[0]).status,'pending');
    assert.equal(queueInvestigation(f.store,f.reportId,{operation:'gap',targetName:'Lake Test'}).id,a.id);
  }finally{f.store.close();}
});
test('withdrawing current geometry makes a gap proposal stale without breaking report viewing',async()=>{
  const f=fixture();try{
    const a=queue(f);await runInvestigation(f.store,a.id,{load:loader()});
    f.store.invalidateFeature(f.job.id,'Withdrawn');
    const view=workflowView(f.store,f.reportId);
    assert.equal(view.actions.find(x=>x.id===a.id).stale,true);
    assert.throws(()=>applyInvestigation(f.store,f.reportId,a.id,{confirmed:true,useEstimate:true,note:'Review'}),/changed/);
  }finally{f.store.close();}
});
test('multiple distinct destination polygons cannot choose an estimated anchor automatically',()=>{
  const f=fixture();try{
    const anchor=gapAnchor(f.store,f.job);
    const s=f.store.sources().find(s=>s.url.endsWith('/2'));
    const second={...polygon,properties:{id:3,name:'Lake Test'},geometry:{type:'Polygon',coordinates:[[[144.04,-37.01],[144.05,-37.01],[144.05,-36.99],[144.04,-36.99],[144.04,-37.01]]]}};
    const result=assessGap([{source:s,status:'checked',kind:'waterbody',requests:['https://example.org/query'],records:[polygon,second]}],anchor,{targetName:'Lake Test',radiusKm:10});
    assert.equal(result.targets.length,2);assert.equal(result.estimate,undefined);
  }finally{f.store.close();}
});
