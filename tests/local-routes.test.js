import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { routeSource } from '../server/road-routes.js';
import { localRouteRoads,saveLocalRoute,localRouteView,previewLocalRoute,publishLocalRoute,withdrawLocalRoute } from '../server/local-routes.js';

const boundary={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[144,-39],[146,-39],[146,-37],[144,-37],[144,-39]]]}};
const road=(pfi,from_ufi=1,to_ufi=2,x=145)=>({id:`tr_road.${pfi}`,
  properties:{pfi,from_ufi,to_ufi,ezi_road_name_label:'Fixture road'},geometry:{type:'LineString',coordinates:[[x,-37.85],[x+.001,-37.85]]}});
const page=features=>({type:'FeatureCollection',numberMatched:features.length,numberReturned:features.length,features,crs:{properties:{name:'EPSG:4326'}}});
const body=(roads,extra={})=>({version:0,author:'Test contributor',basis:'local_knowledge',observedAt:'2026-01-02',
  statement:'Test observation at a local road junction.',uncertainty:'The endpoints and signs remain unverified.',
  links:['https://example.org/reference'],segments:roads.features.map(f=>({snapshotId:roads.id,recordId:f.id})),...extra});
function setup(path=':memory:'){
  const store=createStore(path),id=store.addSource(routeSource);
  store.decideSource(id,'approved',routeSource);return store;
}
const load=(store,code='20',features=[road(1),road(2,2,3,145.001)])=>
  localRouteRoads(store,code,{bounds:[144.99,-37.86,145.02,-37.84]},boundary,async()=>page(features));

test('drafts, previews and attribution survive reopening; publication is idempotent and withdrawal reversible',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'geoxpl-local-')),path=join(dir,'test.sqlite');let store=setup(path);
  try{
    const roads=await load(store);
    const first=saveLocalRoute(store,'20',body(roads));
    assert.equal(store.features().length,0);
    const preview=previewLocalRoute(store,'20',boundary);
    assert.equal(preview.feature.status,'partially_resolved');
    assert.equal(preview.feature.roadRoute.components,1);
    assert.equal(preview.feature.roadRoute.contribution.author,'Test contributor');
    store.close();store=createStore(path);
    assert.equal(localRouteView(store,'20').version,first.version);
    assert.equal(previewLocalRoute(store,'20',boundary).checksum,preview.checksum);
    const input={version:preview.version,checksum:preview.checksum,confirmed:true};
    const published=publishLocalRoute(store,'20',input,boundary);
    assert.equal(published.state,'published');
    const feature=store.feature(published.feature_id);
    assert.equal(feature.roadRoute.contribution.statement,body(roads).statement);
    assert.equal(store.db.prepare('SELECT count(*) n FROM imports').get().n,1);
    publishLocalRoute(store,'20',input,boundary);
    assert.equal(store.featureRevisions(feature.id).length,1);
    assert.throws(()=>saveLocalRoute(store,'20',body(roads,{version:first.version})),/Withdraw/);
    withdrawLocalRoute(store,'20',{version:first.version,reason:'Test withdrawal.'});
    assert.equal(store.features().length,0);
    assert.equal(store.featureRevisions(feature.id).length,1);
    assert.equal(store.getJob(published.jobId).feature_id,null);
    publishLocalRoute(store,'20',input,boundary);
    assert.equal(store.features().length,1);
    assert.equal(store.featureRevisions(feature.id).length,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('stale drafts, source revocation, foreign segment refs and unsupported codes cannot publish',async()=>{
  const store=setup();
  try{
    const roads=await load(store);
    saveLocalRoute(store,'20',body(roads));
    assert.throws(()=>saveLocalRoute(store,'22',body(roads)),/does not belong/);
    assert.throws(()=>saveLocalRoute(store,'20',body(roads)),/changed/);
    assert.throws(()=>saveLocalRoute(store,'National Route 1',body(roads)));
    assert.throws(()=>saveLocalRoute(store,'20',body(roads,{version:1,observedAt:'2026-02-30'})),/valid date/);
    const old=previewLocalRoute(store,'20',boundary);
    const saved=saveLocalRoute(store,'20',body(roads,{version:1,statement:'An updated independent observation.'}));
    assert.throws(()=>publishLocalRoute(store,'20',{version:old.version,checksum:old.checksum,confirmed:true},boundary),/changed/);
    const preview=previewLocalRoute(store,'20',boundary);
    assert.equal(saved.version,2);
    const source=store.sources()[0];
    store.decideSource(source.id,'rejected',source);
    assert.throws(()=>publishLocalRoute(store,'20',{version:preview.version,checksum:preview.checksum,confirmed:true},boundary),/approved/);
    assert.equal(store.features().length,0);
  }finally{store.close();}
});

test('disconnected selections stay partial and unsafe or excessive road requests fail closed',async()=>{
  const store=setup();
  try{
    const roads=await load(store,'22',[road(1),road(2,8,9,145.01)]);
    saveLocalRoute(store,'22',body(roads));
    assert.equal(previewLocalRoute(store,'22',boundary).feature.roadRoute.components,2);
    await assert.rejects(localRouteRoads(store,'20',{bounds:[144,-38,146,-37]},boundary,()=>{throw Error('Should not fetch');}),/closer/);
    await assert.rejects(load(store,'20',[road(1),road(1)]),/identifiers/);
    const existing=store.request('Metropolitan Route 22','road_route');
    store.saveFeature(existing,{identityKey:'published-official',status:'resolved',evidence:[]});
    const p=previewLocalRoute(store,'22',boundary);
    const alternative=publishLocalRoute(store,'22',{version:p.version,checksum:p.checksum,confirmed:true},boundary);
    assert.notEqual(alternative.jobId,existing.id);
    assert.equal(store.jobFeatures(existing.id)[0].identityKey,'published-official');
  }finally{store.close();}
});

test('in-flight processing cannot race a publication and withdrawal cannot remove replacement geometry',async()=>{
  const store=setup();
  try{
    const roads=await load(store);
    saveLocalRoute(store,'20',body(roads));
    const p=previewLocalRoute(store,'20',boundary),input={version:p.version,checksum:p.checksum,confirmed:true};
    const job=store.request('Metropolitan Route 20','road_route');
    assert.throws(()=>publishLocalRoute(store,'20',input,boundary),/active route processing/);
    store.updateJob(job.id,'insufficient_data','awaiting_data','Test finished.');
    publishLocalRoute(store,'20',input,boundary);
    const local=localRouteView(store,'20');
    store.saveFeature(job,{identityKey:'replacement-official',status:'resolved',evidence:[]});
    assert.equal(withdrawLocalRoute(store,'20',{version:local.version,reason:'Test withdrawal.'}).state,'withdrawn');
    assert.equal(store.features()[0].identityKey,'replacement-official');
  }finally{store.close();}
});

test('publication rolls back on a late failure',async()=>{
  const store=setup();
  try{
    const roads=await load(store);
    saveLocalRoute(store,'20',body(roads));
    const p=previewLocalRoute(store,'20',boundary);
    store.db.exec("CREATE TRIGGER stop_publish BEFORE INSERT ON local_route_actions WHEN NEW.kind='published' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.throws(()=>publishLocalRoute(store,'20',{version:p.version,checksum:p.checksum,confirmed:true},boundary),/test failure/);
    assert.equal(localRouteView(store,'20').state,'draft');
    assert.equal(store.features().length,0);assert.equal(store.jobs().length,0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM imports').get().n,0);
  }finally{store.close();}
});

test('all contribution endpoints require admin authentication',async()=>{
  const store=setup(),server=createApp(store,{boundary,contributionLoader:async()=>page([road(1)])}).listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
    const root=`http://127.0.0.1:${server.address().port}/api/admin/local-routes/20`;
    for(const [method,path] of [['GET',''],['PUT',''],['POST','/roads'],['POST','/preview'],['POST','/publish'],['POST','/withdraw']]){
      assert.equal((await fetch(root+path,{method,headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})})).status,401);
    }
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
