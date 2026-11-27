import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {retainFloodArchive,floodSource,floodDatasetId,floodResourceId,floodArchiveUrl} from '../server/flood-evidence.js';
import {createStore} from '../server/store.js';
import {runTerrainPilot} from '../server/terrain-reasoning.js';
import {drainageFingerprint} from '../server/valley-floor.js';
import {vicmapDemSource} from '../server/vicmap-dem.js';
import {sourceChangeTargets,selectSources} from '../server/source-selection.js';
import {mappingLineage} from '../server/provenance.js';

test('flood archive pins the declared licence and resource; checksummed retries reuse the retained input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'geoxpl-flood-test-')),source={...floodSource,id:'flood',status:'approved'};
  const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0x04034b50);let calls=0;
  const reply={success:true,result:{id:floodDatasetId,private:false,license_id:'cc-by-2.5',license_url:'http://creativecommons.org/licenses/by/2.5/au/',license_title:'CC BY 2.5 AU',resources:[{id:floodResourceId,url:floodArchiveUrl,size:bytes.length,last_modified:'2021-11-21'}]}};
  const options={runtimeDir:root,json:async()=>reply,load:async()=>{calls++;return bytes;}};
  try{
    const first=await retainFloodArchive(source,options),second=await retainFloodArchive(source,options);
    assert.equal(calls,1);assert.equal(first.checksum,second.checksum);
    await writeFile(first.archivePath,Buffer.from('changed'));await retainFloodArchive(source,options);assert.equal(calls,2);
    await assert.rejects(retainFloodArchive({...source,status:'pending'},options),/approved/);
    await assert.rejects(retainFloodArchive({...source,url:'https://example.org/flood.zip'},options),/approved/);
    await assert.rejects(retainFloodArchive({...source,version:'changed'},{...options,json:async()=>({...reply,result:{...reply.result,license_id:'unknown'}})}),/reuse terms/);
  }finally{await rm(root,{recursive:true,force:true});}
});

function seeded(){
  const store=createStore(':memory:'),demId=store.addSource(vicmapDemSource),floodId=store.addSource(floodSource);
  store.decideSource(demId,'approved',vicmapDemSource);store.decideSource(floodId,'approved',floodSource);
  const riverJob=store.request('Loddon River','river');
  const river=store.saveFeature(riverJob,{status:'resolved',geometry:{type:'LineString',coordinates:[[144,-36.7],[144,-36.6]]},method:'geofabric_directed_main_stem',algorithmVersion:'test',warnings:[],evidence:[{sourceId:demId,role:'route_segment'}]});
  const job=store.request('Loddon Valley','valley'),config={sourceId:demId,pilotId:'loddon',drainageFeatureId:river.id,drainageChecksum:drainageFingerprint(river),floodSupport:{sourceId:floodId}};
  store.setFeatureSettings(job.id,{aliases:[],preferredSourceId:null,terrainReasoning:config});
  const old=store.saveFeature(job,{status:'partially_resolved',geometry:{type:'Polygon',coordinates:[[[143.9,-36.7],[144,-36.7],[144,-36.6],[143.9,-36.6],[143.9,-36.7]]]},warnings:[],evidence:[],algorithmVersion:'before'});
  return{store,job,old,config,floodId};
}
test('flood approval and source revisions are checked again before publication; older geometry remains intact',async()=>{
  for(const change of ['approval','version']){
    const {store,job,old,floodId}=seeded();
    try{
      await assert.rejects(runTerrainPilot(store,job,{terrainReasoner:async()=>{
        store.decideSource(floodId,change==='approval'?'rejected':'approved',{...floodSource,version:'changed'});return {};
      }}),/Flood evidence changed/);
      assert.equal(store.jobFeatures(job.id)[0].id,old.id);
      assert.equal(store.db.prepare('SELECT count(*) n FROM derivations WHERE feature_id=?').get(old.id).n,1);
    }finally{store.close();}
  }
});
test('flood sources are explicit support, not automatic valley vectors; source changes target the configured request',()=>{
  const {store,job,floodId}=seeded();
  try{
    assert.equal(selectSources(store,job,store.featureSettings(job.id)).selected.length,0);
    const source=store.sources().find(s=>s.id===floodId);
    store.updateJob(job.id,'partially_resolved','available_estimate','Ready');
    const targets=sourceChangeTargets(store,source,{...source,version:'new'},'approved');assert.deepEqual(targets.retry,[job.id]);
  }finally{store.close();}
});
test('mapping history projects the saved flood study, dates and edge meaning without leaking large geometry',()=>{
  const polygon={type:'Polygon',coordinates:[]},snapshot={method:'flood_supported_multiscale_terrain',geometry:polygon,warnings:[],
    floodSupport:{geometry:polygon,bbox:[143,-37,144,-36],records:[{recordId:'BRID15',properties:{ModifiedDa:20150623}}],archiveDate:'2021-11-21',archiveChecksum:'retained'},
    boundaryEvidence:{estimatedEdges:{type:'FeatureCollection',features:[]},studyCuts:{type:'FeatureCollection',features:[]},studyCutLengthShare:.2,meaning:'processing limit'}};
  const lineage=mappingLineage(snapshot);assert.equal(lineage.floodSupport.geometry,undefined);assert.equal(lineage.floodSupport.archiveDate,'2021-11-21');
  assert.equal(lineage.floodSupport.records[0].properties.ModifiedDa,20150623);assert.equal(lineage.boundaryEvidence.estimatedEdges,undefined);assert.equal(lineage.boundaryEvidence.meaning,'processing limit');
});
