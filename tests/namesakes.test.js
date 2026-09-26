import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createWorker } from '../server/worker.js';
import { processGeometry } from '../server/processors.js';
import { geofabricStreamUrl, traceGeofabricMatches } from '../server/geofabric.js';

const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const source = { id: 'bom', name: 'Synthetic namesake source', url: geofabricStreamUrl, type: 'river', format: 'arcgis', nameField: 'name', idField: 'objectid', status: 'approved', completeness: 'unknown', licence: 'Test only', attribution: 'Tests', aliases: [], notes: '' };
const job = { query: 'Test River', type: 'river' };
const node = (id, type, coordinates) => ({ type: 'Feature', id, properties: { hydroid: id, objectid: id, ahgfftype: type }, geometry: { type: 'Point', coordinates } });
const line = (id, from, to, coordinates) => ({ type: 'Feature', id, properties: { hydroid: id, objectid: id, from_node: from, to_node: to, nextdownid: -1, flowdir: 1, ahgfftype: 1, name: 'TEST RIVER' }, geometry: { type: 'LineString', coordinates } });
function fixture() {
  return { id: 'import', source, checksum: 'fixture', payload: { type: 'FeatureCollection', features: [line(11,1,2,[[1,1],[2,1]]), line(22,3,4,[[2.001,1],[3,1]])] }, metadata: { geofabric: { version: 'geofabric-network/3', namedIds: [11,22], missingIds: [], preferences: [], nodes: [node(1,9,[1,1]),node(2,5,[2,1]),node(3,9,[2.001,1]),node(4,5,[3,1])], namedStartIds: [1,3], nodesUrl: geofabricStreamUrl.replace('/6','/3') } } };
}

test('distinct same-named directed networks produce two labelled features, never a gap between rivers', () => {
  const result = processGeometry(job, [fixture()], boundary);
  assert.equal(result.results.length, 2); assert.equal(result.result, null); assert.equal(result.status, 'resolved');
  assert.equal(new Set(result.results.map(r => r.identityKey)).size, 2);
  assert.equal(new Set(result.results.map(r => r.displayName)).size, 2);
  for (const feature of result.results) {
    assert.equal(feature.mainStem.selectedHydroIds.length, 1);
    assert.equal(feature.interpolations.features.length, 0);
    assert.equal(feature.evidence.filter(e => e.role === 'route_segment').length, 1);
  }
});

test('omitting River still traces and distinguishes both same-named Geofabric networks', () => {
  const full = processGeometry(job, [fixture()], boundary);
  const short = processGeometry({ ...job, query: 'Test' }, [fixture()], boundary);
  assert.equal(short.status, full.status);
  assert.equal(short.results.length, 2);
  assert.deepEqual(short.results.map(r => r.identityKey), full.results.map(r => r.identityKey));
  assert.deepEqual(short.results.map(r => r.geometry), full.results.map(r => r.geometry));
});

test('network identities and ordering survive reversed imports and equivalent source endpoints', () => {
  const a = fixture(), b = fixture();
  b.payload.features.reverse(); b.metadata.geofabric.nodes.reverse();
  b.source = { ...source, id: 'other-bom', url: source.url.replace('/MapServer/', '/FeatureServer/') };
  const original = processGeometry(job, [a], boundary);
  const reversed = processGeometry(job, [b,a], boundary);
  assert.equal(reversed.results.length, 2);
  assert.deepEqual(reversed.results.map(r => r.identityKey), original.results.map(r => r.identityKey));
  assert.deepEqual(reversed.results.map(r => r.geometry), original.results.map(r => r.geometry));
});

test('two alternative headwaters joining the same named river are one partial identity', () => {
  const item = fixture();
  item.payload.features[0].properties.nextdownid = 33;
  item.payload.features[1] = line(22,3,2,[[2.001,1],[2,1]]);
  item.payload.features[1].properties.nextdownid = 33;
  item.payload.features.push(line(33,2,4,[[2,1],[3,1]]));
  item.metadata.geofabric.namedIds.push(33);
  item.metadata.geofabric.nodes[1].properties.ahgfftype = 4;
  const result = traceGeofabricMatches(item, boundary, ['test river']);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].status, 'partially_resolved');
  assert.match(result.results[0].warnings.join(' '), /headwater identity is ambiguous/);
});

test('out-of-scope namesakes do not become selection choices', () => {
  const item = fixture();
  item.payload.features[1].geometry.coordinates = [[20,20],[21,20]];
  item.metadata.geofabric.nodes[2].geometry.coordinates = [20,20]; item.metadata.geofabric.nodes[3].geometry.coordinates = [21,20];
  assert.equal(processGeometry(job, [item], boundary).results.length, 1);
});

test('publisher identity groups keep fragments together but keep other namesakes separate', () => {
  const item = fixture(); item.source = { ...source, url: 'https://example.org/river.json', format: 'geojson', completeness: 'complete' };
  item.payload.features.push(line(33,5,6,[[2.003,1],[4,1]]));
  item.payload.features.forEach((r, i) => { r.properties.named_feature_id = i === 2 ? 200 : 100; });
  const result = processGeometry(job, [item], boundary);
  assert.equal(result.results.length, 2); assert.equal(result.results[0].interpolations.features.length, 1);
  assert.equal(result.results[1].interpolations.features.length, 0);
  assert.equal(result.results[0].evidence.length, 2);
  assert.equal(result.results[1].evidence.length, 1);
});

test('same-named valley polygons with published identities also get separate results', () => {
  const item = fixture(); item.source = { ...source, url: 'https://example.org/valley.json', format: 'geojson', type: 'valley', completeness: 'complete' };
  item.payload.features = [1,6].map(n => ({ type: 'Feature', id: n, properties: { vicnames_id: n }, geometry: { type: 'Polygon', coordinates: [[[n,1],[n+1,1],[n+1,2],[n,2],[n,1]]] } }));
  const result = processGeometry({ query: 'Test Valley', type: 'valley' }, [item], boundary);
  assert.equal(result.results.length, 2); assert.ok(result.results.every(r => r.status === 'resolved' && r.areaKm2 > 0));
});

test('automatic selection uses identity evidence, without silently overriding an explicit source choice', () => {
  const combined = fixture(); combined.source = { ...source, id: 'combined', format: 'geojson', url: 'https://example.org/all.json', completeness: 'complete' };
  combined.payload.features = [line(99,1,4,[[1,1],[9,1]])];
  assert.equal(processGeometry(job, [combined,fixture()], boundary).results.length, 2);
  assert.equal(processGeometry(job, [combined,fixture()], boundary, { preferredSourceId: 'combined' }).results.length, 1);
  assert.equal(processGeometry(job, [fixture()], boundary, { preferredSourceId: 'missing' }).status, 'insufficient_data');
});

test('legacy single-feature databases migrate without losing IDs, data or derivation history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geoxpl-namesakes-')), path = join(dir, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE features(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL); CREATE TABLE derivations(id TEXT PRIMARY KEY,feature_id TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL);');
  const data = JSON.stringify({ id: 'old', name: 'Old River', status: 'resolved', warnings: [] });
  legacy.prepare('INSERT INTO features VALUES(?,?,?,?)').run('old','job',data,'yesterday');
  legacy.prepare('INSERT INTO derivations VALUES(?,?,?,?)').run('history','old',data,'yesterday'); legacy.close();
  try {
    for (let i = 0; i < 2; i++) {
      const store = createStore(path);
      assert.equal(store.feature('old').name, 'Old River'); assert.equal(store.features().length, 1);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n, 1); store.close();
    }
  } finally { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); rmdirSync(dir); }
});

test('reprocessing updates both stable IDs atomically and retires obsolete combined geometry', () => {
  const store = createStore(':memory:');
  try {
    const savedJob = store.request(job.query, job.type), results = processGeometry(job, [fixture()], boundary).results;
    const legacy = store.saveFeature(savedJob, { ...results[0], identityKey: undefined });
    const first = store.saveFeatures(savedJob, results);
    assert.equal(store.feature(legacy.id), null); assert.equal(store.getJob(savedJob.id).feature_id, null);
    const second = store.saveFeatures(savedJob, [...results].reverse());
    assert.deepEqual(second.map(r => r.id).sort(), first.map(r => r.id).sort());
    assert.equal(store.features().length, 2);
    assert.throws(() => store.saveFeatures(savedJob, [results[0],results[0]]), /distinct stable/);
    assert.equal(store.jobFeatures(savedJob.id).length, 2);
    const history = store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n;
    assert.throws(() => store.saveFeatures(savedJob, [results[0], { ...results[1], invalid: 1n }]), /BigInt/);
    assert.deepEqual(store.jobFeatures(savedJob.id).map(f => f.id).sort(), first.map(f => f.id).sort());
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n, history);
    store.saveFeatures(savedJob, [results[1]]);
    assert.equal(store.feature(first[0].id), null); assert.equal(store.getJob(savedJob.id).feature_id, first[1].id);
    store.saveFeatures(savedJob, results);
    assert.deepEqual(store.jobFeatures(savedJob.id).map(r => r.id).sort(), first.map(r => r.id).sort());
    store.invalidateFeature(savedJob.id, 'Source changed');
    assert.equal(store.features().length, 0); assert.equal(store.jobFeatures(savedJob.id).length, 0);
    assert.ok(first.every(f => store.feature(f.id) === null));
  } finally { store.close(); }
});

test('worker stores both choices without repeated AI research and public API returns summaries', async () => {
  const store = createStore(':memory:'); let calls = 0;
  const id = store.addSource(source); store.decideSource(id, 'approved', source);
  const item = fixture(); item.metadata.geofabric.nodes[3].properties.ahgfftype = 4;
  const savedJob = store.request(job.query, job.type);
  const worker = createWorker(store, { boundary, importer: async () => item, researcher: async (_j, _s, _reason, diagnostics) => { calls++; assert.equal(diagnostics.matches.length, 2); return { provider: 'test', summary: 'Partial endpoint', candidates: [] }; } }); worker.stop();
  const server = createApp(store).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    await worker.run(savedJob); const firstIds = store.features().map(f => f.id).sort();
    await worker.run(savedJob); assert.equal(calls, 0); assert.equal(store.features().length, 2);
    assert.equal(store.getJob(savedJob.id).status, 'partially_resolved');
    const response = await fetch(root + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'TEST RIVER', type: 'river' }) });
    const found = await response.json();
    assert.equal(found.selectionRequired, true); assert.equal(found.feature, null); assert.equal(found.matches.length, 2);
    assert.ok(found.matches.every(m => !m.geometry && m.displayName));
    assert.deepEqual(found.matches.map(f => f.id).sort(), firstIds);
    const shortName = await (await fetch(root + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Test', type: 'river' }) })).json();
    assert.equal(shortName.id, found.id); assert.equal(shortName.selectionRequired, true);
    assert.deepEqual(shortName.matches, found.matches);
    const polled = await (await fetch(root + `/api/jobs/${savedJob.id}`)).json(); assert.deepEqual(polled.matches, found.matches);
    const full = await (await fetch(root + `/api/features/${found.matches[0].id}`)).json(); assert.ok(full.geometry);
    const catalogue = await (await fetch(root + '/api/catalogue')).json(); assert.equal(catalogue.length, 1); assert.equal(catalogue[0].status, 'resolved');
    store.setting(`research:${savedJob.id}`, 'true'); await worker.run(savedJob); assert.equal(calls, 1); assert.equal(store.features().length, 2);
    await worker.run(savedJob); assert.equal(calls, 1);
    store.invalidateFeature(savedJob.id, 'Unapproved source');
    assert.equal((await fetch(root + `/api/features/${full.id}`)).status, 404);
    assert.equal((await (await fetch(root + `/api/jobs/${savedJob.id}`)).json()).matches.length, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); }
});
