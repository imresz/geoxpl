import test from 'node:test';
import assert from 'node:assert/strict';
import { mainStemCandidate } from '../server/main-stem.js';
import { processGeometry } from '../server/processors.js';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';

const part = (coordinates, id) => ({ coordinates, records: new Set([id]) });
const branched = [part([[1,1],[2,1]], 0), part([[2,1],[3,1],[4,1]], 1), part([[2,1],[2,1.1]], 2)];
const edgeKey = (a, b) => [JSON.stringify(a), JSON.stringify(b)].sort().join('|');
const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const source = { name: 'Test source', type: 'river', completeness: 'complete', status: 'approved', url: 'https://example.org/river', nameField: 'name', idField: 'id', licence: 'Test', attribution: 'Test' };
const imported = { checksum: 'fixture', metadata: {}, source: { ...source, id: 'test' }, payload: { type: 'FeatureCollection', features: branched.map((p, id) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'LineString', coordinates: p.coordinates } })) } };

test('main-stem candidate removes a side branch and keeps route provenance', () => {
  const result = mainStemCandidate(branched);
  assert.deepEqual(result.geometry.coordinates, [[[1,1],[2,1],[3,1],[4,1]]]);
  assert.deepEqual(result.recordIndices.sort(), [0,1]);
  assert.ok(result.diagnostics.excludedLengthKm > 10);
  assert.equal(result.diagnostics.status, 'candidate');
});

test('braids use shortest existing path, with no invented edges and stable ordering', () => {
  const parts = [part([[0,1],[1,1]], 0), part([[1,1],[2,1],[3,1]], 1), part([[1,1],[2,2],[3,1]], 2), part([[3,1],[4,1]], 3)];
  const result = mainStemCandidate(parts);
  assert.deepEqual(result.geometry.coordinates, [[[0,1],[1,1],[2,1],[3,1],[4,1]]]);
  assert.equal(result.diagnostics.componentRoutes[0].parallelAlternatives, 1);
  const allowed = new Set(parts.flatMap(p => p.coordinates.slice(1).map((point, i) => edgeKey(p.coordinates[i], point))));
  for (const route of result.geometry.coordinates) for (let i = 1; i < route.length; i++) assert.ok(allowed.has(edgeKey(route[i - 1], route[i])));
  const reversed = parts.slice().reverse().map(p => ({ ...p, coordinates: p.coordinates.slice().reverse() }));
  assert.deepEqual(mainStemCandidate(reversed).geometry, result.geometry);
});

test('gaps stay disconnected and closed networks cannot be guessed into a path', () => {
  const result = mainStemCandidate([...branched, part([[6,1],[7,1]], 3)]);
  assert.equal(result.geometry.coordinates.length, 2);
  assert.equal(result.diagnostics.componentRoutes.length, 2);
  assert.match(result.diagnostics.limitations.at(-1), /Disconnected/);
  assert.match(mainStemCandidate([part([[1,1],[2,1],[2,2],[1,1]], 0)]).error, /fewer than two/);
});

test('duplicate reversed reaches are counted once; routing limits fail explicitly', () => {
  const result = mainStemCandidate([part([[1,1],[2,1]], 0), part([[2,1],[1,1]], 1)]);
  assert.equal(result.diagnostics.excludedLengthKm, 0);
  assert.deepEqual(result.recordIndices.sort(), [0,1]);
  const star = Array.from({ length: 129 }, (_, i) => part([[0,0],[1,i / 1000]], i));
  assert.match(mainStemCandidate(star).error, /routing limits/);
});

test('a plausible route is never published as a verified main stem', () => {
  const result = processGeometry({ type: 'river' }, [imported], boundary).result;
  assert.equal(result.status, 'partially_resolved');
  assert.equal(result.method, 'main_stem_candidate');
  assert.equal(result.confidence, 'unverified_candidate');
  assert.equal(result.source, null); assert.equal(result.mouth, null);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.recordedNetwork.recordCount, 3);
  assert.ok(result.recordedNetwork.lengthKm > result.lengthKm);
});

test('candidate processing and retry do not generate repetitive research; explicit research still works', async () => {
  const store = createStore(':memory:');
  try {
    const id = store.addSource(source); store.decideSource(id, 'approved', source);
    const job = store.request('Test River', 'river'); let calls = 0;
    const worker = createWorker(store, { boundary, importer: async () => imported, researcher: async () => { calls++; return { provider: 'test', summary: 'Research requested', candidates: [] }; } }); worker.stop();
    await worker.run(job); await worker.run(job);
    assert.equal(calls, 0); assert.equal(store.reports().length, 0);
    assert.equal(store.getJob(job.id).phase, 'awaiting_data');
    assert.equal(store.getJob(job.id).status, 'partially_resolved');
    store.setting(`research:${job.id}`, 'true'); await worker.run(job);
    assert.equal(calls, 1); assert.equal(store.reports().length, 1);
    await worker.run(job); assert.equal(calls, 1);
  } finally { store.close(); }
});
