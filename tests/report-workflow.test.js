import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createWorker } from '../server/worker.js';
import { queueInvestigation,runInvestigation,workflowView,applyInvestigation,changeReportState,updateRecommendation,probeSource } from '../server/report-workflow.js';

const sourceData={name:'Fixture source',url:'https://example.org/FeatureServer/1',type:'river',format:'arcgis',nameField:'name',idField:'id',licence:'Test only',attribution:'Fixture',completeness:'partial',version:'1',aliases:[],notes:''};
function fixture(type='river',path=':memory:'){
  const store=createStore(path),job=store.request(type==='river'?'Test River':'Test Valley',type);
  store.updateJob(job.id,'insufficient_data','awaiting_review','Needs evidence');
  const sourceId=store.addSource({...sourceData,type});store.decideSource(sourceId,'approved',{...sourceData,type});
  const reportId=store.report(job.id,{summary:'Fixture research',provider:'test',nextSteps:['Check source records.','Review feature scope.'],candidates:[],evidence:[]});
  return {store,job,sourceId,reportId};
}
const record=(name='Test River')=>({type:'Feature',properties:{id:1,name},geometry:{type:'LineString',coordinates:[[144,-37],[144.5,-37.2]]}});
const loader=async url=>{const u=new URL(url);if(!u.pathname.endsWith('/query'))return {fields:[{name:'name'},{name:'id'}]};if(u.searchParams.has('returnIdsOnly'))return {objectIds:[1]};return {features:[record()]};};
const planSource=(f,extra={})=>queueInvestigation(f.store,f.reportId,{operation:'source',sourceId:f.sourceId,...extra});

test('source investigation is read-only; preview and exact query evidence are retained',async()=>{
  const f=fixture();try{
    const action=planSource(f);assert.equal(action.status,'queued');
    assert.throws(()=>planSource(f),/already queued/);
    await runInvestigation(f.store,action.id,{load:loader});
    const view=workflowView(f.store,f.reportId),result=view.actions[0].result;
    assert.equal(view.actions[0].status,'ready');assert.equal(result.total,1);assert.equal(result.preview.collection.features.length,1);
    assert.equal(result.requests.length,4);assert.deepEqual(result.terms,['test river','test']);
    assert.equal(f.store.features().length,0);assert.equal(f.store.getJob(f.job.id).phase,'awaiting_review');
    assert.equal(f.store.sources()[0].status,'approved');assert.equal(f.store.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);
  }finally{f.store.close();}
});

test('apply requires confirmation, affects only the report feature and is idempotent',async()=>{
  const f=fixture();try{
    const other=f.store.request('Other River','river');f.store.updateJob(other.id,'resolved','completed','Ready');
    const action=planSource(f);await runInvestigation(f.store,action.id,{load:loader});
    assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{}));
    applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useSource:true});
    assert.equal(f.store.featureSettings(f.job.id).preferredSourceId,f.sourceId);
    assert.equal(f.store.getJob(f.job.id).phase,'queued');assert.equal(f.store.processingPolicy(f.job.id).allowResearch,false);
    assert.equal(f.store.getJob(other.id).status,'resolved');
    const attempts=f.store.getJob(f.job.id).attempts;
    applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useSource:true});
    assert.equal(f.store.getJob(f.job.id).attempts,attempts);
    const view=workflowView(f.store,f.reportId);assert.equal(view.actions.filter(a=>a.kind==='apply').length,1);
    assert.equal(view.actions[0].outcome.phase,'queued');assert.equal(view.actions[0].result.before.status,'insufficient_data');
  }finally{f.store.close();}
});

test('pending source can be inspected but never approved or applied automatically',async()=>{
  const f=fixture();try{
    f.store.decideSource(f.sourceId,'pending',sourceData);
    const action=planSource(f);await runInvestigation(f.store,action.id,{load:loader});
    assert.equal(workflowView(f.store,f.reportId).actions[0].result.applicable,false);
    assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useSource:true}),/not ready/);
    assert.equal(f.store.sources()[0].status,'pending');assert.equal(f.store.jobs().length,1);
  }finally{f.store.close();}
});

test('changed settings, source approvals or feature outcomes invalidate the preview',async()=>{
  for(const change of ['settings','source','job']){
    const f=fixture();try{
      const action=planSource(f);await runInvestigation(f.store,action.id,{load:loader});
      if(change==='settings')f.store.setFeatureSettings(f.job.id,{aliases:['different'],preferredSourceId:null});
      if(change==='source')f.store.decideSource(f.sourceId,'rejected',sourceData);
      if(change==='job')f.store.updateJob(f.job.id,'failed','failed','Changed outcome');
      assert.equal(workflowView(f.store,f.reportId).actions[0].stale,true);
      assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{confirmed:true}),/changed/);
      assert.notEqual(f.store.getJob(f.job.id).phase,'queued');
    }finally{f.store.close();}
  }
});

test('changes during a running source check invalidate its result',async()=>{
  const f=fixture();try{
    const action=planSource(f);let changed=false;
    await runInvestigation(f.store,action.id,{load:async url=>{if(!changed){changed=true;f.store.setFeatureSettings(f.job.id,{aliases:['alternate'],preferredSourceId:null});}return loader(url);}});
    assert.equal(workflowView(f.store,f.reportId).actions[0].status,'stale');
  }finally{f.store.close();}
});

test('alias application requires an identity decision and preserves geographic reviews',async()=>{
  const f=fixture();try{
    let action=planSource(f,{aliases:['Alternate River']});await runInvestigation(f.store,action.id,{load:loader});
    assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useAliases:true}),/why/);
    applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useAliases:true,note:'Reviewed naming evidence.'});
    assert.deepEqual(f.store.featureSettings(f.job.id).aliases,['alternate river']);
    f.store.updateJob(f.job.id,'partially_resolved','awaiting_data','Partial');
    f.store.setFeatureSettings(f.job.id,{aliases:[],preferredSourceId:null,formationJunctions:[{nodeId:1}]});
    action=planSource(f);await runInvestigation(f.store,action.id,{load:loader});
    assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useSource:true}),/geographic reviews/);
    assert.equal(f.store.featureSettings(f.job.id).formationJunctions.length,1);
    assert.equal(f.store.featureSettings(f.job.id).preferredSourceId,null);
  }finally{f.store.close();}
});

test('prerequisite river is explicitly named, deduplicated and never auto-associated with the valley',async()=>{
  const f=fixture('valley');try{
    const action=queueInvestigation(f.store,f.reportId,{operation:'prerequisite',query:'King River',stepIndex:0});
    await runInvestigation(f.store,action.id);
    assert.equal(f.store.jobs().length,1);
    applyInvestigation(f.store,f.reportId,action.id,{confirmed:true});
    const river=f.store.request('King','river');assert.equal(f.store.jobs().length,2);
    assert.equal(f.store.processingPolicy(river.id).allowResearch,false);
    assert.equal(f.store.featureSettings(f.job.id).valleyFloor,undefined);
    assert.equal(f.store.getJob(f.job.id).phase,'awaiting_review');
    applyInvestigation(f.store,f.reportId,action.id,{confirmed:true});assert.equal(f.store.jobs().length,2);
  }finally{f.store.close();}
});

test('existing prerequisite requests retain their policy and resolved results are reused',async()=>{
  for(const status of ['pending','resolved']){
    const f=fixture('valley');try{
      const river=f.store.request('King','river');
      if(status==='resolved'){f.store.saveFeature(river,{status:'resolved',lengthKm:10});f.store.updateJob(river.id,'resolved','completed','Ready');}
      const action=queueInvestigation(f.store,f.reportId,{operation:'prerequisite',query:'King River'});await runInvestigation(f.store,action.id);
      applyInvestigation(f.store,f.reportId,action.id,{confirmed:true});
      assert.equal(f.store.getJob(river.id).attempts,0);assert.equal(f.store.processingPolicy(river.id).allowResearch,true);
      assert.equal(f.store.jobs().length,2);
    }finally{f.store.close();}
  }
});

test('deferral cancels queued investigations, requires a reason and leaves job/source outcomes alone',async()=>{
  const f=fixture();try{
    const action=planSource(f);
    assert.throws(()=>changeReportState(f.store,f.reportId,{state:'deferred',reason:''}),/reason/);
    let view=changeReportState(f.store,f.reportId,{state:'deferred',reason:'Need scope advice.'});
    assert.equal(view.state,'deferred');assert.equal(view.actions.find(a=>a.id===action.id).status,'cancelled');
    assert.throws(()=>planSource(f),/Resume/);
    assert.equal(f.store.getJob(f.job.id).phase,'awaiting_review');assert.equal(f.store.sources()[0].status,'approved');
    await runInvestigation(f.store,action.id,{load:()=>assert.fail('Cancelled action executed')});
    view=changeReportState(f.store,f.reportId,{state:'active',reason:'Scope advice available.'});assert.equal(view.state,'active');
    const next=planSource(f);assert.notEqual(next.id,action.id);
  }finally{f.store.close();}
});

test('defer during investigation cannot publish a late ready result',async()=>{
  const f=fixture();try{
    const action=planSource(f);let once=false;
    await runInvestigation(f.store,action.id,{load:async url=>{if(!once){once=true;changeReportState(f.store,f.reportId,{state:'deferred',reason:'Wait for evidence.'});}return loader(url);}});
    assert.equal(workflowView(f.store,f.reportId).actions.find(a=>a.id===action.id).status,'cancelled');
  }finally{f.store.close();}
});

test('recommendation responsibility and evidence persist without resolving the feature',()=>{
  const f=fixture();try{
    assert.throws(()=>updateRecommendation(f.store,f.reportId,9,{owner:'decision',status:'open',note:''}),/not found/);
    assert.throws(()=>updateRecommendation(f.store,f.reportId,0,{owner:'geoxpl',status:'handled',note:''}),/reason/);
    const view=updateRecommendation(f.store,f.reportId,0,{owner:'specialist',status:'deferred',note:'Needs a new landform adapter.'});
    assert.equal(view.steps[0].owner,'specialist');assert.equal(view.steps[0].status,'deferred');
    assert.equal(f.store.getJob(f.job.id).status,'insufficient_data');assert.equal(view.actions[0].kind,'recommendation');
  }finally{f.store.close();}
});

test('historical and superseded reports cannot execute workflow operations',()=>{
  const f=fixture();try{
    f.store.report(f.job.id,{summary:'New report',nextSteps:[],candidates:[]});
    assert.match(workflowView(f.store,f.reportId).readOnlyReason,/historical/);
    assert.throws(()=>planSource(f),/historical/);
    assert.throws(()=>changeReportState(f.store,f.reportId,{state:'dismissed',reason:'Old'}),/historical/);
  }finally{f.store.close();}
});

test('worker recovers persisted interrupted investigations after reopening the database',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'geoxpl-reports-'));const path=join(dir,'test.sqlite');let f=fixture('river',path),worker;
  try{
    const action=planSource(f);f.store.db.prepare('UPDATE report_actions SET status=? WHERE id=?').run('running',action.id);f.store.close();f.store=createStore(path);
    worker=createWorker(f.store,{investigationLoader:loader});await worker.tick();worker.stop();
    assert.equal(workflowView(f.store,f.reportId).actions[0].status,'ready');
    assert.equal(f.store.getJob(f.job.id).phase,'awaiting_review');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);
  }finally{worker?.stop();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('source checks reject unsafe metadata, wrong names, invalid geometry and arbitrary operations',async()=>{
  const f=fixture();try{
    assert.throws(()=>queueInvestigation(f.store,f.reportId,{operation:'execute_code',code:'whatever'}));
    assert.throws(()=>queueInvestigation(f.store,f.reportId,{operation:'source',sourceId:f.sourceId,url:'https://example.org/other'}));
    await assert.rejects(()=>probeSource({...sourceData,status:'approved'},'Test River','river',[],async()=>({fields:[]})),/missing/);
    await assert.rejects(()=>probeSource({...sourceData,status:'approved'},'Test River','river',[],async url=>url.includes('objectIds=')?{features:[record('Wrong River')]}:loader(url)),/names/);
    const result=await probeSource({...sourceData,status:'approved'},'Test River','river',[],async url=>url.includes('objectIds=')?{features:[{...record(),geometry:{type:'LineString',coordinates:[[999,999],[2,2]]}}]}:loader(url));
    assert.equal(result.applicable,false);assert.match(result.previewError,/WGS84/);
  }finally{f.store.close();}
});

test('workflow API requires authentication and persists review audit history',async()=>{
  const f=fixture();const server=createApp(f.store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}`;let cookie;
  const send=(path,method='GET',body)=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try{
    assert.equal((await send(`/api/admin/reports/${f.reportId}/workflow`)).status,401);
    const setup=await send('/api/admin/setup','POST',{password:'synthetic-report-password'});cookie=setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await send(`/api/admin/reports/${f.reportId}/investigate`,'POST',{operation:'shell'})).status,400);
    assert.equal((await send(`/api/admin/reports/${f.reportId}/investigate`,'POST',{operation:'source',sourceId:f.sourceId})).status,200);
    assert.equal((await send(`/api/admin/reports/${f.reportId}`,'PATCH',{status:'approved',notes:'Read the evidence.'})).status,200);
    const view=await(await send(`/api/admin/reports/${f.reportId}/workflow`)).json();assert.ok(view.actions.some(a=>a.kind==='review'));
    assert.equal((await send(`/api/admin/reports/${f.reportId}/state`,'POST',{state:'deferred',reason:'Await evidence.'})).status,200);
    assert.equal((await send(`/api/admin/reports/${f.reportId}`,'PATCH',{status:'approved',notes:'Cannot resume implicitly.'})).status,409);
    assert.equal(workflowView(f.store,f.reportId).state,'deferred');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();}
});

test('failed application rolls back feature settings, processing policy and action history',async()=>{
  const f=fixture();try{
    const action=planSource(f);await runInvestigation(f.store,action.id,{load:loader});
    const original=f.store.retry;f.store.retry=()=>{throw Error('Synthetic queue failure');};
    assert.throws(()=>applyInvestigation(f.store,f.reportId,action.id,{confirmed:true,useSource:true}),/queue failure/);f.store.retry=original;
    assert.equal(f.store.featureSettings(f.job.id).preferredSourceId,null);
    assert.equal(f.store.processingPolicy(f.job.id).allowResearch,true);
    const view=workflowView(f.store,f.reportId);assert.equal(view.actions[0].status,'ready');assert.equal(view.actions.filter(a=>a.kind==='apply').length,0);
    assert.equal(f.store.getJob(f.job.id).phase,'awaiting_review');
  }finally{f.store.close();}
});
