import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { createApp } from '../server/app.js';
import { enqueueBatch, batchStatus, batchSchema } from '../server/batches.js';

const manifest = (names = ['Test River'], id = 'test-batch') => ({ id, name: 'Test batch', selectionNote: 'Synthetic tests, not real geographic evidence.', references: [], entries: names.map(query => ({ query, type: 'river' })) });
const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const source = { name: 'Synthetic test source', type: 'river', format: 'geojson', url: 'https://example.org/data', nameField: 'name', idField: 'id', completeness: 'complete', licence: 'Test only', attribution: 'Tests' };
const result = query => ({ payload: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: query, id: 1 }, geometry: { type: 'LineString', coordinates: [[1,1],[2,2]] } }] }, metadata: {}, truncated: false, checksum: query });
function approve(store) { const id = store.addSource(source); store.decideSource(id, 'approved', source); }

test('manifest has 20 unique names and preserves its provisional selection caveat', () => {
  const data = batchSchema.parse(JSON.parse(readFileSync(new URL('../scripts/data/victoria-long-rivers.json', import.meta.url))));
  assert.equal(data.entries.length, 20);
  assert.match(data.selectionNote, /not a certified length ranking/);
  assert.ok(data.entries.some(e => e.query === 'Murray River'));
  assert.throws(() => batchSchema.parse(manifest(['Loddon', 'Loddon River'])), /distinct/);
  assert.throws(() => batchSchema.parse({ ...manifest(), id: '../unsafe' }));
});

test('enqueue is atomic and idempotent; changed content is rejected without side effects', () => {
  const store = createStore(':memory:');
  try {
    const first = enqueueBatch(store, manifest(['Loddon', 'Avoca River']));
    assert.equal(first.created, true); assert.equal(first.batch.counts.queued, 2);
    assert.ok(first.batch.items.every(i => i.allowResearch === false));
    const events = store.db.prepare('SELECT COUNT(*) n FROM events').get().n;
    assert.equal(enqueueBatch(store, manifest(['Loddon', 'Avoca River'])).created, false);
    assert.equal(store.jobs().length, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM searches').get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, events);
    assert.throws(() => enqueueBatch(store, manifest(['Different River'])), /different manifest/);
    assert.equal(store.jobs().length, 2);
    const other = enqueueBatch(store, manifest(['Loddon River'], 'other-batch')).batch;
    assert.equal(other.items[0].disposition, 'joined');
    assert.equal(store.jobs().length, 2);
  } finally { store.close(); }
});

test('creation failure rolls back the manifest, jobs, policies, searches and events', () => {
  const store = createStore(':memory:'); const original = store.request;
  store.request = function(query, type) { if (query === 'Fail River') throw Error('Injected failure'); return original.call(this, query, type); };
  try {
    assert.throws(() => enqueueBatch(store, manifest(['First River', 'Fail River'])), /Injected/);
    for (const table of ['batches', 'batch_items', 'jobs', 'job_policies', 'searches', 'events']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  } finally { store.close(); }
});

test('reuse preserves completed and partial geometry/settings; missing results retry once', () => {
  const store = createStore(':memory:');
  try {
    for (const [name, status] of [['Complete River', 'resolved'], ['Partial River', 'partially_resolved']]) {
      const job = store.request(name, 'river'); store.saveFeature(job, { status, lengthKm: 12 });
      store.updateJob(job.id, status, status === 'resolved' ? 'completed' : 'awaiting_data', 'Saved result');
      store.setFeatureSettings(job.id, { aliases: ['Reviewed alias'], preferredSourceId: 'reviewed-source' });
    }
    const missing = store.request('Missing River', 'river'); store.updateJob(missing.id, 'insufficient_data', 'awaiting_review', 'Old report');
    const report = store.report(missing.id, { summary: 'Historical evidence', candidates: [] });
    const before = store.features();
    const data = manifest(['Complete River', 'Partial River', 'Missing River']);
    const batch = enqueueBatch(store, data).batch;
    assert.equal(batch.reused, 2); assert.equal(batch.counts.queued, 1);
    assert.equal(batch.counts.resolved, 1); assert.equal(batch.counts.partial, 1);
    assert.equal(store.getJob(missing.id).attempts, 1);
    assert.equal(store.reports()[0].id, report);
    assert.deepEqual(store.features(), before);
    assert.equal(store.featureSettings(batch.items[0].jobId).preferredSourceId, 'reviewed-source');
    enqueueBatch(store, data);
    assert.equal(store.getJob(missing.id).attempts, 1);
    assert.equal(store.processingPolicy(missing.id).allowResearch, false);
  } finally { store.close(); }
});

test('joining a user request does not override its existing research policy', () => {
  const store = createStore(':memory:');
  try {
    const job = store.request('Test River', 'river'); store.setting(`research:${job.id}`, 'true');
    const batch = enqueueBatch(store, manifest()).batch;
    assert.equal(batch.items[0].disposition, 'joined'); assert.equal(batch.items[0].allowResearch, true);
    assert.equal(store.setting(`research:${job.id}`), 'true');
  } finally { store.close(); }
});

test('file-backed restart requeues all interrupted phases and retains policy and completed geometry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geoxpl-batch-'));
  const path = join(dir, 'test.sqlite'); let store = createStore(path), worker;
  try {
    approve(store);
    const data = manifest(['Done River', 'Import River', 'Process River', 'Research River', 'Waiting River']);
    const batch = enqueueBatch(store, data).batch;
    worker = createWorker(store, { boundary, importer: async (_s, query) => result(query), researcher: async () => assert.fail('AI must stay disabled') }); worker.stop();
    await worker.run(store.getJob(batch.items[0].jobId));
    const saved = store.jobFeatures(batch.items[0].jobId)[0];
    for (const [index, phase] of ['importing', 'processing', 'researching'].entries()) store.updateJob(batch.items[index + 1].jobId, 'pending', phase, 'Interrupted');
    store.updateJob(batch.items[4].jobId, 'pending', 'awaiting_review', 'Needs a decision');
    store.close(); store = createStore(path);
    let calls = 0;
    worker = createWorker(store, { boundary, importer: async (_s, query) => { calls++; return result(query); }, researcher: async () => assert.fail('AI must stay disabled after restart') });
    assert.equal(store.getJob(batch.items[0].jobId).status, 'resolved');
    assert.equal(store.getJob(batch.items[4].jobId).phase, 'awaiting_review');
    for (const item of batch.items.slice(1, 4)) {
      assert.equal(store.getJob(item.jobId).phase, 'queued');
      assert.equal(store.processingPolicy(item.jobId).allowResearch, false);
    }
    for (let i = 0; i < 4; i++) await worker.tick();
    worker.stop();
    assert.equal(calls, 3);
    assert.deepEqual(store.jobFeatures(batch.items[0].jobId)[0], saved);
    const after = batchStatus(store, data.id);
    assert.equal(after.counts.resolved, 4); assert.equal(after.counts.needsAttention, 1);
    assert.equal(after.status, 'completed_with_issues');
    assert.equal(store.reports().length, 0);
    assert.equal(enqueueBatch(store, data).created, false);
    assert.equal(store.jobs().length, 5);
  } finally { worker?.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete imports skip AI/review loops and the queue advances to the next river', async () => {
  const store = createStore(':memory:'); let worker;
  try {
    approve(store);
    const batch = enqueueBatch(store, manifest(['Unavailable River', 'Available River'])).batch;
    worker = createWorker(store, { boundary, importer: async (_s, query) => { if (query.startsWith('Unavailable')) throw Error('Provider offline'); return result(query); }, researcher: async () => assert.fail('Unexpected paid research') });
    await worker.tick(); await worker.tick(); await worker.tick(); worker.stop();
    const after = batchStatus(store, batch.id);
    assert.equal(after.counts.needsAttention, 1); assert.equal(after.counts.resolved, 1);
    assert.equal(after.items[0].phase, 'awaiting_data');
    assert.equal(store.reports().length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE action='research_skipped'").get().n, 1);
    assert.match(store.db.prepare("SELECT detail FROM events WHERE action='research_skipped'").get().detail, /Provider offline/);
  } finally { worker?.stop(); store.close(); }
});

test('explicit new research can override the saved automatic-research restriction', async () => {
  const store = createStore(':memory:'); let worker;
  try {
    const batch = enqueueBatch(store, manifest()).batch; const job = store.getJob(batch.items[0].jobId); let calls = 0;
    worker = createWorker(store, { boundary, researcher: async () => { calls++; return { provider: 'fixture', summary: 'Evidence needed', candidates: [] }; } }); worker.stop();
    await worker.run(job); assert.equal(calls, 0);
    store.setting(`research:${job.id}`, 'true'); store.retry(job.id); await worker.run(job);
    assert.equal(calls, 1); assert.equal(store.processingPolicy(job.id).allowResearch, false);
    assert.equal(store.reports().length, 1);
  } finally { worker?.stop(); store.close(); }
});

test('a failed processing attempt does not stop the remaining batch queue', async () => {
  const store = createStore(':memory:'); let worker;
  try {
    approve(store); const batch = enqueueBatch(store, manifest(['Fail River', 'Good River'])).batch;
    const original = store.saveFeatures;
    store.saveFeatures = function(job, features) { if (job.query === 'Fail River') throw Error('Injected processor failure'); return original.call(this, job, features); };
    worker = createWorker(store, { boundary, importer: async (_s, query) => result(query) });
    await worker.tick(); await worker.tick(); worker.stop();
    const after = batchStatus(store, batch.id);
    assert.equal(after.counts.failed, 1); assert.equal(after.counts.resolved, 1);
    assert.equal(after.status, 'completed_with_issues');
    assert.equal(store.getJob(batch.items[0].jobId).attempts, 0);
  } finally { worker?.stop(); store.close(); }
});

test('repeating a partially committed processing attempt cannot create duplicate feature identities', async () => {
  const store = createStore(':memory:'); let worker;
  try {
    approve(store); const batch = enqueueBatch(store, manifest()).batch; const job = store.getJob(batch.items[0].jobId);
    worker = createWorker(store, { boundary, importer: async (_s, query) => result(query) }); worker.stop();
    await worker.run(job); const id = store.jobFeatures(job.id)[0].id;
    store.updateJob(job.id, 'pending', 'processing', 'Simulated interruption before final status');
    worker = createWorker(store, { boundary, importer: async (_s, query) => result(query) }); worker.stop();
    await worker.run(store.getJob(job.id));
    assert.equal(store.features().length, 1); assert.equal(store.features()[0].id, id);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM imports').get().n, 1);
  } finally { worker?.stop(); store.close(); }
});

test('batch API is authenticated, validates manifests and returns idempotent status', async () => {
  const store = createStore(':memory:'); const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`; let cookie;
  const send = (path, body) => fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await send('/api/admin/batches')).status, 401);
    assert.equal((await send('/api/admin/batches', manifest())).status, 401);
    const setup = await send('/api/admin/setup', { password: 'fixture-batch-password' }); cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await send('/api/admin/batches', manifest(['Loddon', 'Loddon River']))).status, 400);
    assert.equal(store.jobs().length, 0);
    assert.equal((await send('/api/admin/batches', manifest())).status, 201);
    assert.equal((await send('/api/admin/batches', manifest())).status, 200);
    assert.equal((await send('/api/admin/batches', manifest(['Changed River']))).status, 409);
    assert.equal((await (await send('/api/admin/batches/test-batch')).json()).total, 1);
    assert.equal((await (await send('/api/admin/batches')).json()).length, 1);
    assert.equal((await send('/api/admin/batches/missing')).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
