import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { area, feature } from '@turf/turf';
import { coverageRequest, deriveTerrainValley, terrainSchema, terrainVersion, demEndpoint } from '../server/terrain.js';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { createApp } from '../server/app.js';
import { landformEndpoint } from '../server/valley-floor.js';

const box = (w,s,e,n) => ({ type:'Polygon', coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
const geometry = box(145,-37.6,145.1,-37.5);
const floor = { geometry, bbox:[145,-37.6,145.1,-37.5], areaKm2:area(feature(geometry))/1e6, evidence:[], extentEstimate:{kind:'valley_floor',coverage:'partial'}, warnings:[] };
const source = {id:'dem',name:'Test DEM',type:'valley',format:'ga-dem',url:demEndpoint,status:'approved',licence:'CC BY 4.0',attribution:'Geoscience Australia',nameField:'coverage',idField:'coverage',completeness:'partial',aliases:[],notes:'',version:'2024'};
const config = {sourceId:source.id,analysisScaleMetres:1000};
const calculated = () => ({geometry:box(144.99,-37.61,145.11,-37.49),algorithmVersion:terrainVersion,diagnostics:{sensitivity:{intersectionOverUnion:0.8}}});
const bytes = Buffer.from('49492a0000000000','hex');

test('DEM request uses bounded raw WCS heights and caps extract size', () => {
  const request=coverageRequest(floor), url=new URL(request.url);
  assert.equal(url.origin,'https://services.ga.gov.au'); assert.equal(url.searchParams.get('coverage'),'1');
  assert.equal(url.searchParams.get('format'),'GeoTIFF'); assert.ok(request.cells<1200000);
  assert.throws(()=>coverageRequest({...floor,bbox:[114,-43,153,-11]}),/million|coverage/);
  for(const scale of [0,500,2500,NaN]) assert.equal(terrainSchema.safeParse({...config,analysisScaleMetres:scale}).success,false);
});

test('terrain retains original floor, provenance, sensitivity and partial status; duplicate raster snapshots work', async () => {
  const runtimeDir=await mkdtemp(join(tmpdir(),'geoxpl-terrain-'));
  try {
    let calls=0;
    const options={runtimeDir,load:async()=>bytes,run:async()=>calculated(),saveImport:()=>{calls++;return 'raster-import';}};
    for(let i=0;i<2;i++) {
      const result=await deriveTerrainValley(floor,source,config,options);
      assert.deepEqual(result.valleyFloor.geometry,floor.geometry);assert.equal(result.extentEstimate.kind,'terrain_valley');
      assert.equal(result.status,'partially_resolved');assert.equal(result.evidence[0].importId,'raster-import');
      assert.match(result.warnings.join(' '),/not a probability/);assert.ok(result.areaKm2>floor.areaKm2);
    }
    assert.equal(calls,2);
  }finally{await rm(runtimeDir,{recursive:true,force:true});}
});

test('terrain rejects unapproved endpoints, images, malformed output and omitted floor', async () => {
  const runtimeDir=await mkdtemp(join(tmpdir(),'geoxpl-terrain-'));
  try {
    const options={runtimeDir,load:async()=>bytes,run:async()=>calculated()};
    for(const bad of [{...source,status:'pending'},{...source,url:'https://example.org/dem'}]) await assert.rejects(deriveTerrainValley(floor,bad,config,options),/approved/);
    await assert.rejects(deriveTerrainValley(floor,source,config,{...options,load:async()=>Buffer.from('not a tiff')}),/GeoTIFF/);
    for(const mutate of [o=>o.algorithmVersion='other',o=>o.geometry=box(140,-38,141,-37),o=>o.diagnostics.sensitivity.intersectionOverUnion=NaN,o=>o.geometry=box(144.99,-37.61,145.11,-37.51)]) {
      const output=calculated();mutate(output);
      await assert.rejects(deriveTerrainValley(floor,source,config,{...options,run:async()=>output}));
    }
  }finally{await rm(runtimeDir,{recursive:true,force:true});}
});

function seed() {
  const store=createStore(':memory:');
  const riverJob=store.request('Test River','river');
  const river=store.saveFeature(riverJob,{type:'river',status:'resolved',geometry:{type:'LineString',coordinates:[[145,-37.55],[145.1,-37.55]]},evidence:[],warnings:[],algorithmVersion:'test'});
  store.updateJob(riverJob.id,'resolved','completed','Ready',river.id);
  const landform={name:'Test floor',type:'valley',format:'vic-gmu250',url:landformEndpoint,nameField:'gmu_t3_desc',idField:'gmu_t3',licence:'test',attribution:'test',completeness:'partial',aliases:[],version:'test',notes:''};
  const floorId=store.addSource(landform);store.decideSource(floorId,'approved',landform);
  const demId=store.addSource(source);store.decideSource(demId,'approved',source);
  const job=store.request('Test Valley','valley');
  const settings={aliases:[],preferredSourceId:floorId,valleyFloor:{sourceId:floorId,drainageFeatureId:river.id,recordIds:['gmu250.1'],evidenceUrl:'https://example.org/evidence',scopeNote:'Reviewed synthetic valley-floor association only.'},terrain:{...config,sourceId:demId}};
  store.setFeatureSettings(job.id,settings);
  const importer=async s=>{assert.equal(s.format,'vic-gmu250');return{checksum:'test',truncated:false,metadata:{adapter:'vic-gmu250/1'},payload:{type:'FeatureCollection',features:[{type:'Feature',id:'gmu250.1',properties:{gmu_t3:'1.3.3',lfm_pattern:'TER',lfm_element:'TEP'},geometry}]}};};
  return{store,job,settings,demId,riverJob,importer};
}

test('worker publishes terrain, falls back on failure, and rejects changed approval or drainage without AI', async () => {
  for(const mode of ['success','failure','approval','drainage']) {
    const {store,job,demId,riverJob,importer}=seed();let called=0;
    const worker=createWorker(store,{boundary:feature(box(144,-39,147,-36)),importer,researcher:()=>{throw Error('AI should not run');},terrainProcessor:async f=>{
      called++;
      if(mode==='failure')throw Error('Missing elevations');
      if(mode==='approval')store.decideSource(demId,'rejected',source);
      if(mode==='drainage')store.invalidateFeature(riverJob.id,'Source withdrawn');
      return{...f,extentEstimate:{...f.extentEstimate,kind:'terrain_valley',label:'Estimated valley extent'},valleyFloor:{geometry:f.geometry}};
    }});worker.stop();
    try{
      await worker.run(job);assert.equal(called,1);
      if(['approval','drainage'].includes(mode)){assert.equal(store.jobFeatures(job.id).length,0);assert.equal(store.getJob(job.id).phase,'awaiting_review');}
      else {const f=store.jobFeatures(job.id)[0];assert.equal(f.extentEstimate.kind,mode==='success'?'terrain_valley':'valley_floor');assert.equal(store.getJob(job.id).phase,'available_estimate');if(mode==='failure')assert.match(f.warnings.join(' '),/Missing elevations/);}
    }finally{store.close();}
  }
});

test('terrain settings require a reviewed floor, approved DEM and admin; omitted settings are preserved', async()=>{
  const {store,job,settings}=seed();store.updateJob(job.id,'partially_resolved','available_estimate','Ready');
  const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}/api`;
  try{
    const setup=await fetch(root+'/admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-terrain-test'})});
    const cookie=setup.headers.get('set-cookie').split(';')[0];
    const call=(body,auth=cookie)=>fetch(root+`/admin/jobs/${job.id}/settings`,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:auth},body:JSON.stringify(body)});
    assert.equal((await call(settings,'')).status,401);
    assert.equal((await call({...settings,valleyFloor:null})).status,400);
    assert.equal((await call({...settings,terrain:{...settings.terrain,sourceId:'missing'}})).status,400);
    const {terrain,...omitted}=settings;assert.equal((await call(omitted)).status,200);assert.deepEqual(store.featureSettings(job.id).terrain,terrain);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});
