import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalize } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createWorker } from '../server/worker.js';

function fixture() {
  const store = createStore(':memory:');
  const current = store.request('Test River', 'river');
  store.saveFeature(current, { status:'resolved', warnings:[] });
  store.updateJob(current.id,'resolved','completed','Ready');
  store.db.prepare('INSERT INTO jobs(id,query,normalized,type,status,phase,message,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('old','Test',normalize('Test'),'river','insufficient_data','awaiting_review','Old evidence needed','2026','2026');
  const report = store.report('old',{summary:'Original report',candidates:[]});
  return {store,current,report};
}

test('superseding preserves reports, features and audit history, and both spellings resolve to the current request', () => {
  const {store,current,report}=fixture();
  try {
    const feature=store.jobFeatures(current.id)[0];
    store.supersedeJob('old',current.id);
    assert.equal(store.getJob('old').status,'superseded');
    assert.equal(store.getJob('old').superseded_by,current.id);
    assert.equal(store.currentJob('old').id,current.id);
    assert.equal(store.request('Test','river').id,current.id);
    assert.equal(store.request('Test River','river').id,current.id);
    assert.equal(store.reports()[0].id,report); assert.deepEqual(store.feature(feature.id),feature);
    assert.equal(store.supersedeJob('old',current.id).status,'superseded');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE action='superseded'").get().n,1);
    assert.throws(()=>store.retry('old'),/superseded/);
  } finally {store.close();}
});

test('replacement must be an equivalent resolved feature, never an unrelated, active or cyclic request', () => {
  const {store,current}=fixture();
  try {
    assert.throws(()=>store.supersedeJob('old','old'),/same named/);
    const other=store.request('Different River','river');
    assert.throws(()=>store.supersedeJob('old',other.id),/same named/);
    store.updateJob(current.id,'partially_resolved','awaiting_data','Incomplete');
    assert.throws(()=>store.supersedeJob('old',current.id),/resolved/);
    store.updateJob(current.id,'resolved','completed','Ready');
    store.updateJob('old','pending','queued','Busy');
    assert.throws(()=>store.supersedeJob('old',current.id),/active processing/);
    store.updateJob('old','partially_resolved','awaiting_data','Partial');
    store.saveFeature(store.getJob('old'),{status:'partially_resolved',warnings:[]});
    assert.throws(()=>store.supersedeJob('old',current.id),/active geometry/);
  } finally {store.close();}
});

test('public old links resolve to current results; admin cannot retry, research or edit a superseded request', async () => {
  const {store,current}=fixture();
  const server=createApp(store).listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const root=`http://127.0.0.1:${server.address().port}`;
  const send=(path,body,cookie,method='POST')=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  try {
    assert.equal((await send('/api/admin/jobs/old/supersede',{replacementJobId:current.id})).status,401);
    const setup=await send('/api/admin/setup',{password:'synthetic-password-123'}),cookie=setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await send('/api/admin/jobs/old/supersede',{replacementJobId:current.id},cookie)).status,200);
    const publicJob=await (await fetch(root+'/api/jobs/old')).json();
    assert.equal(publicJob.id,current.id);assert.equal(publicJob.requestedJobId,'old');assert.equal(publicJob.supersededBy,current.id);
    assert.equal(publicJob.feature.id,store.jobFeatures(current.id)[0].id);
    for(const operation of ['retry','research']) assert.equal((await send(`/api/admin/jobs/old/${operation}`,{},cookie)).status,409);
    assert.equal((await send('/api/admin/jobs/old/settings',{aliases:[],preferredSourceId:null},cookie,'PATCH')).status,409);
    const worker=createWorker(store,{importer:()=>assert.fail('No processing'),researcher:()=>assert.fail('No AI')});worker.stop();
    await worker.run(store.getJob('old'));assert.equal(store.getJob('old').status,'superseded');
    assert.equal(store.reports().length,1);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});
