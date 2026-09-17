import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createWorker } from '../server/worker.js';
import { importSource } from '../server/importer.js';
import { processGeometry } from '../server/processors.js';

const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const source = { name: 'Synthetic source', type: 'river', format: 'geojson', url: 'https://example.org/data', nameField: 'name', idField: 'id', licence: 'Test only', attribution: 'Tests', version: '', completeness: 'complete', aliases: ['Unrelated River'], notes: '' };
const record = (coordinates, name = 'Test River', id = 1) => ({ type: 'Feature', properties: { name, id }, geometry: { type: 'LineString', coordinates } });
const imported = (features, extra = {}) => ({ id: 'import', source: { ...source, id: 'source-a', status: 'approved', ...extra }, checksum: 'fixture', payload: { type: 'FeatureCollection', features }, metadata: {}, truncated: false });
const job = { query: 'Test River', type: 'river' };

test('remote homonyms are removed, but connected interstate reaches are not clipped', () => {
  const data = imported([record([[1,1],[9,9],[11,11]]), record([[11,11],[14,14]], 'Test River', 2), record([[115,-33],[116,-33]], 'Test River', 3)]);
  const output = processGeometry(job, [data], boundary).result;
  assert.equal(output.status, 'resolved');
  assert.equal(output.identity.excludedRecords, 1);
  assert.deepEqual(output.bbox, [1,1,14,14]);
  assert.equal(output.evidence.length, 2);
});

test('nearby continuation identity does not invent a connecting line or hide a gap', () => {
  const first = [[1,1],[11,11]], continuation = [[11.0001,11],[14,14]];
  const output = processGeometry(job, [imported([record(first), record(continuation, 'Alternate name', 2)])], boundary).result;
  assert.equal(output.identity.associatedComponents, 1);
  assert.equal(output.graph.components, 2);
  assert.equal(output.status, 'partially_resolved');
  assert.deepEqual(output.geometry.coordinates, [first, continuation]);
});

test('multipart source records cannot carry remote namesakes into the selected geometry', () => {
  const multi = { ...record([[1,1],[2,2]]), geometry: { type: 'MultiLineString', coordinates: [[[1,1],[2,2]], [[115,-33],[116,-33]]] } };
  const result = processGeometry(job, [imported([multi])], boundary).result;
  assert.deepEqual(result.bbox, [1,1,2,2]);
  assert.equal(result.identity.excludedComponents, 1);
  assert.equal(result.geometry.coordinates.length, 1);
});

test('one source supplies geometry; comparison sources cannot duplicate length or change its completeness', () => {
  const a = imported([record([[1,1],[4,4]])], { id: 'a', completeness: 'partial' });
  const b = imported([record([[1.0001,1],[4.0001,4]])], { id: 'b', completeness: 'complete' });
  const alone = processGeometry(job, [a], boundary).result;
  const result = processGeometry(job, [a,b], boundary, { preferredSourceId: 'a' }).result;
  assert.equal(result.lengthKm, alone.lengthKm);
  assert.equal(result.status, 'partially_resolved');
  assert.deepEqual(result.evidence.map(e => e.sourceId), ['a']);
  assert.equal(result.selection.comparisons.length, 2);
  assert.equal(processGeometry(job, [a,b], boundary).result.selection.sourceId, 'b');
  assert.equal(processGeometry(job, [a], boundary, { preferredSourceId: 'missing' }).result, undefined);
});

test('feature aliases are scoped to the request, never taken from the global source registry', async () => {
  const records = [record([[1,1],[2,2]]), record([[2,2],[3,3]], 'River Test'), record([[3,3],[4,4]], 'Unrelated River')];
  const approved = { ...source, status: 'approved' };
  const load = async () => ({ type: 'FeatureCollection', features: records });
  assert.equal((await importSource(approved, 'Test River', load)).payload.features.length, 1);
  const result = await importSource(approved, 'test river', load, { aliases: ['River Test'] });
  assert.equal(result.payload.features.length, 2);
  assert.deepEqual(result.metadata.queryTerms, ['test river','river test']);
});

test('ArcGIS aliases union IDs and all geometry requests stay within gateway limits', async () => {
  let pages = 0;
  const result = await importSource({ ...source, status: 'approved', format: 'arcgis', url: 'https://example.org/FeatureServer/4' }, "O'Brien River", async url => {
    const u = new URL(url);
    if (!u.pathname.endsWith('/query')) return { fields: [{ name: 'name' }] };
    if (u.searchParams.has('returnIdsOnly')) {
      assert.ok(u.searchParams.get('where').includes("O''BRIEN") || u.searchParams.get('where').includes('RIVER TEST'));
      return { objectIds: Array.from({ length: 251 }, (_, i) => 2000000000 + i) };
    }
    assert.ok(url.length <= 1800);
    const ids = u.searchParams.get('objectIds').split(','); assert.ok(ids.length <= 100); pages++;
    return { features: ids.map(id => record([[1,1],[2,2]], 'Test', id)) };
  }, { aliases: ['River Test'] });
  assert.equal(result.payload.features.length, 251); assert.equal(pages, 3); assert.equal(result.truncated, false);
});

test('unchanged processing reuses research and snapshots; changed aliases or explicit research refresh it', async () => {
  const store = createStore(':memory:');
  try {
    const id = store.addSource({ ...source, completeness: 'partial' }); store.decideSource(id, 'approved', { ...source, completeness: 'partial' });
    const saved = store.request('Test River', 'river'); let calls = 0;
    const worker = createWorker(store, { boundary, importer: async () => imported([record([[1,1],[2,2]])]), researcher: async (_job, _store, _reason, diagnostics) => { calls++; assert.ok(diagnostics.comparisons.length); return { provider: 'test research', summary: 'Needs review', candidates: [] }; } }); worker.stop();
    await worker.run(saved); store.retry(saved.id); await worker.run(saved);
    assert.equal(calls, 1); assert.equal(store.reports().length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM imports').get().n, 1);
    store.setFeatureSettings(saved.id, { aliases: ['river test'], preferredSourceId: null }); await worker.run(saved); assert.equal(calls, 2);
    store.setting(`research:${saved.id}`, 'true'); await worker.run(saved); assert.equal(calls, 3);
    await worker.run(saved); assert.equal(calls, 3);
  } finally { store.close(); }
});

test('failed comparison source does not prevent a complete selected source from resolving', async () => {
  const store = createStore(':memory:');
  try {
    const good = store.addSource(source); store.decideSource(good, 'approved', source);
    const bad = store.addSource({ ...source, name: 'Failed comparison' }); store.decideSource(bad, 'approved', { ...source, name: 'Failed comparison' });
    const saved = store.request('Test River', 'river');
    store.setFeatureSettings(saved.id, { aliases: [], preferredSourceId: good });
    const worker = createWorker(store, { boundary, importer: async s => { if (s.id === bad) throw Error('Unavailable'); return imported([record([[1,1],[2,2]])]); }, researcher: async () => assert.fail('Resolved geometry must not trigger research') }); worker.stop();
    await worker.run(saved); assert.equal(store.getJob(saved.id).status, 'resolved');
    assert.equal(store.features()[0].selection.importFailures.length, 1);
  } finally { store.close(); }
});

test('review decisions do not retry or overwrite jobs; only changed feature settings queue processing', async () => {
  const store = createStore(':memory:'); const app = createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const send = (path, data, method = 'POST') => fetch(root + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  try {
    const setup = await send('/api/admin/setup', { password: 'synthetic-password-123' }); cookie = setup.headers.get('set-cookie').split(';')[0];
    const saved = store.request('Test River', 'river'); store.updateJob(saved.id, 'partially_resolved', 'awaiting_review', 'Needs review');
    const reportId = store.report(saved.id, { summary: 'Recommendation', candidates: [] });
    for (const status of ['approved', 'rejected']) {
      assert.equal((await send(`/api/admin/reports/${reportId}`, { status, notes: '' }, 'PATCH')).status, 200);
      assert.equal(store.getJob(saved.id).attempts, 0); assert.equal(store.getJob(saved.id).phase, 'awaiting_review');
    }
    const sourceId = store.addSource(source);
    assert.equal((await send(`/api/admin/jobs/${saved.id}/settings`, { aliases: [], preferredSourceId: sourceId }, 'PATCH')).status, 400);
    const settings = { aliases: [' River Test ', 'river test'], preferredSourceId: null };
    assert.equal((await send(`/api/admin/jobs/${saved.id}/settings`, settings, 'PATCH')).status, 200);
    assert.deepEqual(store.featureSettings(saved.id).aliases, ['river test']); assert.equal(store.getJob(saved.id).attempts, 1);
    assert.equal((await send(`/api/admin/jobs/${saved.id}/settings`, settings, 'PATCH')).status, 409);
    store.updateJob(saved.id, 'partially_resolved', 'awaiting_review', 'Needs review');
    assert.equal((await send(`/api/admin/jobs/${saved.id}/settings`, settings, 'PATCH')).status, 200);
    assert.equal(store.getJob(saved.id).attempts, 1);
    assert.equal((await send(`/api/admin/jobs/${saved.id}/research`, {})).status, 200);
    assert.equal(store.setting(`research:${saved.id}`), 'true');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); }
});
