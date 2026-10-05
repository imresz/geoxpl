import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

test('catalogue separates active partial results while preserving its resolved default',async()=>{
  const store=createStore(':memory:');
  const save=(name,status,type='river',extra={})=>{
    const job=store.request(name,type);
    const feature=store.saveFeature(job,{name,type,status,geometry:{type:'LineString',coordinates:[[144,-37],[145,-38]]},bbox:[144,-38,145,-37],lengthKm:10,areaKm2:null,warnings:[],evidence:[],...extra});
    store.updateJob(job.id,status,'completed','Saved');return {job,feature};
  };
  const resolved=save('Resolved River','resolved');
  const partial=save('Partial River','partially_resolved');
  const estimate=save('Estimated Valley','partially_resolved','valley',{lengthKm:null,areaKm2:5,extentEstimate:{kind:'valley_floor',label:'Estimated valley floor'}});
  const withdrawn=save('Withdrawn River','partially_resolved');store.invalidateFeature(withdrawn.job.id,'Withdrawn evidence');
  save('Unavailable River','insufficient_data');
  const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}`;
  try{
    const get=async path=>(await fetch(root+path)).json();
    assert.deepEqual((await get('/api/catalogue')).map(f=>f.id),[resolved.feature.id]);
    const partials=await get('/api/catalogue?status=partially_resolved');
    assert.deepEqual(new Set(partials.map(f=>f.id)),new Set([partial.feature.id,estimate.feature.id]));
    assert.equal(partials.find(f=>f.id===estimate.feature.id).extentEstimate.label,'Estimated valley floor');
    assert.equal((await get('/api/catalogue?status=all')).length,3);
    assert.equal((await fetch(root+'/api/catalogue?status=pending')).status,400);
    assert.equal((await get(`/api/features/${partial.feature.id}`)).status,'partially_resolved');
    assert.equal((await fetch(root+`/api/features/${withdrawn.feature.id}`)).status,404);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});
