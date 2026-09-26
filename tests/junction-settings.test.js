import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

test('junction evidence requires authentication and river type; ordinary saves retain it while identity changes clear it', async () => {
  const store=createStore(':memory:');
  const server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}`;
  const call=(path,body,cookie,method='PATCH')=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const review={nodeId:1,tributaryHydroId:2,joiningHydroId:3,downstreamHydroId:4,joiningName:'Other Creek',downstreamName:'New River',evidenceUrl:'https://example.org/naming',note:'Synthetic reviewed confluence naming evidence.'};
  const settings={aliases:[],preferredSourceId:null,formationJunctions:[review]};
  try {
    const job=store.request('Test River','river'),valley=store.request('Test Valley','valley');
    for(const id of [job.id,valley.id])store.updateJob(id,'partially_resolved','awaiting_data','Needs evidence');
    const path=`/api/admin/jobs/${job.id}/settings`;
    assert.equal((await call(path,settings)).status,401);
    const setup=await call('/api/admin/setup',{password:'synthetic-password-123'},null,'POST'),cookie=setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(`/api/admin/jobs/${valley.id}/settings`,settings,cookie)).status,400);
    assert.equal((await call(path,{...settings,formationJunctions:[{...review,evidenceUrl:'http://example.org'}]},cookie)).status,400);
    assert.equal((await call(path,settings,cookie)).status,200);
    assert.deepEqual(store.featureSettings(job.id).formationJunctions,[review]);
    store.updateJob(job.id,'partially_resolved','awaiting_data','Ready');
    assert.equal((await call(path,{aliases:[],preferredSourceId:null},cookie)).status,200);
    assert.deepEqual(store.featureSettings(job.id).formationJunctions,[review]);
    assert.equal((await call(path,{aliases:['River Test'],preferredSourceId:null},cookie)).status,200);
    assert.equal(store.featureSettings(job.id).formationJunctions,undefined);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});
