import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHeadwaters, investigateHeadwaters, headwaterAnchor } from '../server/headwater-investigation.js';
import { createStore } from '../server/store.js';
import { geofabricStreamUrl } from '../server/geofabric.js';
import { queueInvestigation, runInvestigation, workflowView, investigationSchema, applyInvestigation } from '../server/report-workflow.js';

const line = (id,name='',from=id)=>({type:'Feature',properties:{hydroid:id,from_node:from,to_node:20,nextdownid:30,flowdir:1,name},geometry:{type:'LineString',coordinates:[[144+id/10000,-37.01],[144,-37]]}});
const anchor={nodeId:20,downstreamHydroId:30,coordinates:[144,-37]};
const branch = r=>({records:[r],continuity:{status:'published_headwater',allSameName:!!r.properties.name}});
test('unnamed alternatives remain ambiguous regardless of length, elevation or downstream preference',()=>{
  const r=assessHeadwaters(anchor,[branch(line(1)),branch(line(2))],[],[{nodeid:20,prefedgeid:30}],['test river'],{profiles:[{hydroId:1,status:'sampled',dropMetres:1000}]});
  assert.equal(r.assessment,'ambiguous');assert.equal(r.preferredCandidateHydroId,null);assert.equal(r.applicable,false);assert.equal(r.alternatives.length,2);
  assert.equal(r.alternatives[0].publishedPreferences[0].prefedgeid,30);
});
test('different named tributaries are excluded and same-name continuity is only a reviewed candidate',()=>{
  const r=assessHeadwaters(anchor,[branch(line(1,'TEST RIVER')),branch(line(2,'OTHER CREEK'))],[],[],['test river']);
  assert.equal(r.alternatives[1].excludedNamedTributary,true);assert.equal(r.assessment,'identity_supported_candidate');assert.equal(r.applicable,false);
  const broken=assessHeadwaters({...anchor,downstreamHydroId:999},[branch(line(1,'TEST RIVER'))],[],[],['test river']);
  assert.equal(broken.assessment,'ambiguous');assert.equal(broken.alternatives[0].continuity.joinsNamedStart,false);
});
test('approved spatial names corroborate a branch but cannot certify identity; pending names are ignored',()=>{
  const r=line(1),check={status:'checked',kind:'channels',source:{id:'map',url:'https://example.org',status:'approved',nameField:'name',idField:'hydroid'},records:[{...r,properties:{...r.properties,name:'TEST RIVER'}}]};
  const result=assessHeadwaters(anchor,[branch(r)],[check],[],['test river']);
  assert.equal(result.alternatives[0].namedMapping,'spatial_name_corroboration');assert.equal(result.assessment,'ambiguous');
  assert.equal(assessHeadwaters(anchor,[branch(r)],[{...check,source:{...check.source,status:'pending'}}],[],['test river']).alternatives[0].corroboration.length,0);
});

function fixture(){
  const store=createStore(':memory:'),sourceId=store.addSource({name:'BoM',type:'river',format:'arcgis',url:geofabricStreamUrl,nameField:'name',idField:'hydroid',licence:'CC BY',attribution:'BoM'});
  store.decideSource(sourceId,'approved',store.sources().find(s=>s.id===sourceId));
  const job=store.request('Test river','river');
  const context={nodeId:20,incoming:[line(1),line(2)]};
  const importId=store.addImport(sourceId,job.id,'checksum',{type:'FeatureCollection',features:[]},{geofabric:{headwaterContexts:[context]}});
  store.saveFeature(job,{geometry:line(1).geometry,status:'partially_resolved',warnings:[],evidence:[{role:'named_start',importId}],mainStem:{namedStart:{nodeId:20,coordinates:[144,-37]},selectedHydroIds:[30]}});
  store.updateJob(job.id,'partially_resolved','awaiting_data','Partial');
  const reportId=store.report(job.id,{summary:'Review headwater',nextSteps:['Assess alternatives'],candidates:[],evidence:[]});
  return {store,job:store.getJob(job.id),reportId};
}
const load=async url=>{
  const u=new URL(url),where=u.searchParams.get('where');
  if(u.pathname.endsWith('/3/query')){const id=Number(where.match(/\((\d+)/)[1]);return {features:[{type:'Feature',properties:{hydroid:id,ahgfftype:9},geometry:{type:'Point',coordinates:line(id).geometry.coordinates[0]}}]};}
  if(u.pathname.endsWith('/37/query'))return {features:[{attributes:{nodeid:20,prefedgeid:30}}]};
  throw Error('Unexpected request');
};
test('headwater workflow is durable, evidence-only and redacts raw snapshots from browser polling',async()=>{
  const f=fixture();try{
    const a=queueInvestigation(f.store,f.reportId,{operation:'headwaters'});
    await runInvestigation(f.store,a.id,{load,sampleTerrain:async()=>{throw Error('No terrain source');}});
    const view=workflowView(f.store,f.reportId),result=view.actions[0].result;
    assert.equal(view.actions[0].status,'ready');assert.equal(result.alternatives.length,2);assert.equal(result.applicable,false);
    assert.equal(result.branches,undefined);assert.equal(result.anchor.context,undefined);assert.equal(result.terrain.status,'unavailable');
    assert.equal(f.store.jobFeatures(f.job.id)[0].status,'partially_resolved');
    assert.equal(queueInvestigation(f.store,f.reportId,{operation:'headwaters'}).id,a.id);
    assert.throws(()=>applyInvestigation(f.store,f.reportId,a.id,{confirmed:true,note:'Reviewed evidence'}),/not ready/);
  }finally{f.store.close();}
});
test('restart checkpoints reuse completed branch evidence and unavailable terrain is explicit',async()=>{
  const f=fixture();try{
    let checkpoint;
    await investigateHeadwaters(f.store,f.job,null,async s=>{checkpoint=JSON.parse(JSON.stringify(s));},{load,sampleTerrain:async()=>({status:'unavailable',message:'No DEM'})});
    const r=await investigateHeadwaters(f.store,f.job,checkpoint,async()=>{},{load:async()=>{throw Error('Must not refetch');},sampleTerrain:async()=>{throw Error('Must not repeat');}});
    assert.equal(r.alternatives.length,2);assert.equal(r.alternatives[0].terrain.message,'No DEM');
    const source=headwaterAnchor(f.store,f.job).source;
    f.store.decideSource(source.id,'rejected',source);
    assert.throws(()=>headwaterAnchor(f.store,f.job),/approved/);
  }finally{f.store.close();}
});
test('headwater operation rejects unrelated gap settings and unknown geometry',()=>{
  assert.equal(investigationSchema.safeParse({operation:'headwaters',discover:true}).success,false);
  assert.throws(()=>assessHeadwaters(anchor,[branch({...line(1),properties:{...line(1).properties,flowdir:0}})],[],[],['test river']),/undirected/);
});
