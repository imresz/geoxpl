import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/store.js';
import {createWorker} from '../server/worker.js';
import {elevationPlan,validateElevationService,retainVicmapElevation,vicmapDemSource,sha} from '../server/vicmap-dem.js';
import {pilotInput,runTerrainPilot} from '../server/terrain-reasoning.js';
import {drainageFingerprint} from '../server/valley-floor.js';
import {mappingLineage,isProvenancePilot} from '../server/provenance.js';
import {selectSources} from '../server/source-selection.js';
const scope=[145.45,-37.72,145.46,-37.71];
function metadata(plan){return {serviceDataType:'esriImageServiceDataTypeElevation',bandCount:1,pixelType:'F32',
  tileInfo:{format:'LERC',rows:256,cols:256,lercError:.1,spatialReference:{wkid:3857},origin:{x:plan.origin[0],y:plan.origin[1]},lods:[{level:plan.level,resolution:plan.resolution}]}};}
test('numeric elevation metadata rejects shaded relief, wrong compression and unbounded requests',()=>{
  const plan=elevationPlan(scope);assert.ok(plan.count<1200);assert.equal(validateElevationService(metadata(plan),plan).bandCount,1);
  for(const change of [{serviceDataType:'esriImageServiceDataTypeGeneric'},{bandCount:3},{pixelType:'U8'}])assert.throws(()=>validateElevationService({...metadata(plan),...change},plan),/numeric/);
  assert.throws(()=>validateElevationService({...metadata(plan),tileInfo:{...metadata(plan).tileInfo,lercError:5}},plan));
  for(const bad of [[140,-38,150,-35],[145,-38,146,-37],[],[NaN,-38,145,-37]])assert.throws(()=>elevationPlan(bad));
});
test('elevation downloads resume by checksum and repair one corrupt tile',async()=>{
  const root=await mkdtemp(join(tmpdir(),'geoxpl-dem-test-')),plan=elevationPlan(scope),source={...vicmapDemSource,id:'dem',status:'approved'};
  let calls=0;const load=async()=>{calls++;return Buffer.concat([Buffer.from('CntZImage '),Buffer.alloc(70)]);};
  const options={runtimeDir:root,load,json:async()=>metadata(plan)};
  try{
    const first=await retainVicmapElevation(source,scope,options);assert.equal(calls,plan.count);
    const second=await retainVicmapElevation(source,scope,options);assert.equal(calls,plan.count);assert.equal(first.checksum,second.checksum);
    await writeFile(first.manifest.entries[0].path,Buffer.from('corrupt'));
    await retainVicmapElevation(source,scope,options);assert.equal(calls,plan.count+1);
    assert.equal(sha(await readFile(first.manifest.entries[0].path)),first.manifest.entries[0].checksum);
    await assert.rejects(retainVicmapElevation({...source,status:'pending'},scope,options),/Approved/);
  }finally{await rm(root,{recursive:true,force:true});}
});
function seed(){
  const store=createStore(':memory:'),sourceId=store.addSource(vicmapDemSource);store.decideSource(sourceId,'approved',vicmapDemSource);
  const riverSource={name:'Synthetic Geofabric',type:'river',url:'https://example.org/river',format:'geojson'};
  const riverSourceId=store.addSource(riverSource);store.decideSource(riverSourceId,'approved',riverSource);
  const riverJob=store.request('Yarra River','river');
  const river=store.saveFeature(riverJob,{geometry:{type:'LineString',coordinates:[[145.4,-37.7],[145.6,-37.75]]},status:'partially_resolved',method:'geofabric_directed_main_stem',algorithmVersion:'test',evidence:[{sourceId:riverSourceId,role:'route_segment'}],warnings:[]});
  const job=store.request('Yarra Valley','valley'),config={sourceId,pilotId:'yarra',drainageFeatureId:river.id,drainageChecksum:drainageFingerprint(river)};
  store.setFeatureSettings(job.id,{aliases:[],preferredSourceId:null,terrainReasoning:config});
  const polygon={type:'Polygon',coordinates:[[[145.4,-37.8],[145.6,-37.8],[145.6,-37.7],[145.4,-37.7],[145.4,-37.8]]]};
  const old=store.saveFeature(job,{identityKey:'existing-yarra',geometry:polygon,status:'partially_resolved',evidence:[],warnings:[],algorithmVersion:'older'});
  const result={geometry:polygon,status:'partially_resolved',confidence:'estimated',method:'drainage_constrained_multiscale_terrain',algorithmVersion:'terrain-reasoning/1.0.0',warnings:[],evidence:[],
    principalDrainage:{featureId:river.id,checksum:config.drainageChecksum},terrainReasoning:{inputFingerprint:'fixed',stableCore:{geometry:polygon,areaKm2:5},outerEnvelope:{geometry:polygon,areaKm2:8},rules:['Synthetic rule'],limitations:['Synthetic limitation'],diagnostics:{intersectionOverUnion:.6}}};
  return{store,sourceId,riverSourceId,riverSource,river,job,old,config,result};
}
test('terrain pilots retain feature identity and immutable revisions; idempotent reruns avoid extra revisions and AI',async()=>{
  const {store,job,old,result}=seed();
  const worker=createWorker(store,{terrainReasoner:async()=>result,importer:()=>{throw Error('No vector import');},researcher:()=>{throw Error('No AI');}});worker.stop();
  try{
    assert.equal(selectSources(store,job,store.featureSettings(job.id)).selected.length,0);
    await worker.run(job);assert.equal(store.jobFeatures(job.id)[0].id,old.id);assert.equal(store.getJob(job.id).phase,'available_estimate');
    const count=()=>store.db.prepare('SELECT count(*) AS n FROM derivations WHERE feature_id=?').get(old.id).n;
    assert.equal(count(),2);await worker.run(job);assert.equal(count(),2);
    store.invalidateFeature(job.id,'Synthetic input refresh');await worker.run(job);assert.equal(store.jobFeatures(job.id)[0].id,old.id);assert.equal(count(),3);
    const current=store.jobFeatures(job.id)[0];assert.equal(isProvenancePilot(current),true);
    const lineage=mappingLineage(current);assert.equal(lineage.terrainReasoning.stableCore.geometry,undefined);assert.deepEqual(lineage.terrainReasoning.rules,['Synthetic rule']);
  }finally{store.close();}
});
test('changed source approval, drainage or settings cannot publish a terrain revision',async()=>{
  for(const mode of ['source','drainage','settings','support']){
    const {store,job,config,river,old,result,sourceId,riverSourceId,riverSource}=seed();
    try{
      await assert.rejects(runTerrainPilot(store,job,{terrainReasoner:async()=>{
        if(mode==='source')store.decideSource(sourceId,'rejected',vicmapDemSource);
        if(mode==='drainage')store.db.prepare("UPDATE features SET data=json_set(data,'$.algorithmVersion','changed') WHERE id=?").run(river.id);
        if(mode==='settings')store.setFeatureSettings(job.id,{aliases:['changed'],preferredSourceId:null,terrainReasoning:config});
        if(mode==='support')store.decideSource(riverSourceId,'rejected',riverSource);
        return result;
      }}),/changed/);
      assert.equal(store.jobFeatures(job.id)[0].id,old.id);assert.equal(store.db.prepare('SELECT count(*) AS n FROM derivations WHERE feature_id=?').get(old.id).n,1);
    }finally{store.close();}
  }
});
test('pilot river identity and saved revision must match explicitly',()=>{
  const {store,river,config}=seed();try{pilotInput(config,river);for(const change of [{name:'Other River'},{geometry:{type:'Point',coordinates:[145,-37]}},{algorithmVersion:'changed'},{evidence:[]}])assert.throws(()=>pilotInput(config,{...river,...change}));}finally{store.close();}
});
