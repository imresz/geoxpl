import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { importSource } from '../server/importer.js';
import { processGeometry } from '../server/processors.js';
import { publicAddress } from '../server/network.js';
import { createWorker } from '../server/worker.js';
import { createApp } from '../server/app.js';

// Synthetic coordinates, confined to tests; never shipped as geographic evidence.
const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const line = coords => ({ type: 'Feature', properties: { name: 'Test River', OBJECTID: 1 }, geometry: { type: 'LineString', coordinates: coords } });
const source = { id: 'source-test', name: 'Synthetic source', type: 'river', status: 'approved', format: 'geojson', url: 'https://example.org/fixture.json', nameField: 'name', idField: 'OBJECTID', licence: 'Test fixture only', attribution: 'Tests', version: '1', completeness: 'complete', aliases: [], notes: '' };
const imported = features => ({ id: 'import-test', source, checksum: 'fixture', payload: { type: 'FeatureCollection', features } });

test('case and whitespace differences reuse one durable job', () => {
  const store = createStore(':memory:');
  const a = store.request('  Murray   River ', 'river'), b = store.request('murray river', 'river');
  assert.equal(a.id, b.id); assert.equal(store.jobs().length, 1);
  const valley = store.request('Murray River', 'valley'); assert.notEqual(valley.id, a.id);
  assert.equal(store.sources().length, 0); assert.equal(store.features().length, 0); store.close();
});
test('connected complete line resolves with provenance and measurements', () => {
  const r = processGeometry({ type: 'river' }, [imported([line([[1,1],[2,2]]), line([[2,2],[3,3]])])], boundary);
  assert.equal(r.status, 'resolved'); assert.equal(r.result.evidence.length, 2);
  assert.ok(r.result.lengthKm > 300); assert.equal(r.result.source, null); assert.equal(r.result.mouth, null);
});
test('partial coverage, branches and gaps cannot masquerade as complete rivers', () => {
  const disconnected = processGeometry({ type: 'river' }, [imported([line([[1,1],[2,2]]), line([[3,3],[4,4]])])], boundary);
  assert.equal(disconnected.status, 'partially_resolved'); assert.equal(disconnected.result.graph.components, 2);
  const branch = processGeometry({ type: 'river' }, [imported([line([[1,1],[2,2]]), line([[2,2],[3,3]]), line([[2,2],[3,1]])])], boundary);
  assert.equal(branch.status, 'partially_resolved'); assert.equal(branch.result.graph.branchJunctions, 1);
  const item = imported([line([[1,1],[2,2]])]); item.source = { ...source, completeness: 'partial' };
  assert.equal(processGeometry({ type: 'river' }, [item], boundary).status, 'partially_resolved');
});
test('source order does not duplicate reversed lines; invalid coordinates cannot publish', () => {
  const r = processGeometry({ type: 'river' }, [imported([line([[1,1],[2,2]]), line([[2,2],[1,1]])])], boundary);
  assert.equal(r.result.geometry.coordinates.length, 1);
  assert.equal(processGeometry({ type: 'river' }, [imported([line([[400,1],[401,2]])])], boundary).status, 'insufficient_data');
});
test('valley needs a real approved polygon and missing terrain is explicit', () => {
  assert.equal(processGeometry({ type: 'valley' }, [], boundary).status, 'missing_capability');
  const item = imported([{ type: 'Feature', properties: { name: 'Test Valley' }, geometry: { type: 'Polygon', coordinates: [[[1,1],[2,1],[2,2],[1,2],[1,1]]] } }]);
  const r = processGeometry({ type: 'valley' }, [item], boundary);
  assert.equal(r.status, 'resolved'); assert.ok(r.result.areaKm2 > 0);
});
test('import requires approval and uses exact case-insensitive names', async () => {
  await assert.rejects(importSource({ ...source, status: 'pending' }, 'Test River'), /approved/);
  const result = await importSource(source, 'test river', async () => ({ type: 'FeatureCollection', features: [line([[1,1],[2,2]]), { ...line([[2,2],[3,3]]), properties: { name: 'Other River' } }] }));
  assert.equal(result.payload.features.length, 1); assert.equal(result.checksum.length, 64);
});
test('ArcGIS quotes query literals and imports all ID batches', async () => {
  const urls = [];
  const result = await importSource({ ...source, format: 'arcgis', url: 'https://example.org/FeatureServer/4' }, "O'Brien River", async url => {
    urls.push(url); const u = new URL(url);
    if (!u.pathname.endsWith('/query')) return { fields: [{ name: 'name' }], geometryType: 'esriGeometryPolyline' };
    if (u.searchParams.has('returnIdsOnly')) return { objectIds: Array.from({ length: 501 }, (_, i) => i) };
    return { features: u.searchParams.get('objectIds').split(',').map(() => line([[1,1],[2,2]])) };
  });
  assert.equal(result.payload.features.length, 501); assert.equal(result.truncated, false);
  assert.match(new URL(urls[1]).searchParams.get('where'), /O''BRIEN/); assert.equal(urls.length, 9);
});
test('source requests block local, metadata, loopback and mapped private addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:192.168.1.1', 'fc00::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('approval lifecycle persists report and retry resolves without duplicate identity', async () => {
  const store = createStore(':memory:'); const job = store.request('Test River', 'river');
  const worker = createWorker(store, { boundary, importer: async () => ({ ...imported([line([[1,1],[2,2]])]), metadata: {} }), researcher: async () => ({ provider: 'test', summary: 'Needs data', nextSteps: ['Approve source'], evidence: [], candidates: [source] }) }); worker.stop();
  await worker.run(job); assert.equal(store.getJob(job.id).phase, 'awaiting_review'); assert.equal(store.reports().length, 1);
  const proposed = store.sources()[0]; assert.equal(proposed.status, 'pending'); store.decideSource(proposed.id, 'approved', proposed);
  store.retry(job.id); await worker.run(store.getJob(job.id));
  assert.equal(store.getJob(job.id).status, 'resolved'); const id = store.getJob(job.id).feature_id;
  store.retry(job.id); await worker.run(store.getJob(job.id)); assert.equal(store.getJob(job.id).feature_id, id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM derivations').get().n, 2); store.close();
});
test('API protects administration, sets a session, deduplicates and validates', async () => {
  const store = createStore(':memory:'); const app = createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie, method = 'POST') => fetch(root + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(root + '/api/admin/overview')).status, 401);
    assert.equal((await post('/api/search', { query: 'Test', type: 'park' })).status, 400);
    const setup = await post('/api/admin/setup', { password: 'test-password-12345' }); assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0]; assert.ok(cookie.includes('geoxpl_session='));
    assert.equal((await fetch(root + '/api/admin/overview', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post('/api/admin/setup', { password: 'test-password-12345' })).status, 403);
    const a = await (await post('/api/search', { query: 'Test River', type: 'river' })).json();
    const b = await (await post('/api/search', { query: 'TEST RIVER', type: 'river' })).json(); assert.equal(a.id, b.id);
    const created = await (await post('/api/admin/sources', { ...source, licence: '' }, cookie)).json();
    assert.equal((await post(`/api/admin/sources/${created.id}`, { ...source, status: 'approved', licence: '' }, cookie, 'PATCH')).status, 400);
    const cross = await fetch(root + '/api/admin/logout', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' }); assert.equal(cross.status, 403);
    await post('/api/admin/logout', {}, cookie); assert.equal((await fetch(root + '/api/admin/overview', { headers: { Cookie: cookie } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
