import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extendGeofabric, geofabricStreamUrl, isGeofabric, traceGeofabric } from '../server/geofabric.js';
import { processGeometry } from '../server/processors.js';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';

const boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
const source = { id: 'bom', name: 'Synthetic Geofabric fixture', url: geofabricStreamUrl, type: 'river', format: 'arcgis', nameField: 'name', idField: 'objectid', status: 'approved', completeness: 'unknown', licence: 'Test only', attribution: 'Tests', version: 'fixture' };
const line = (id, from, to, next, coordinates, name = 'TEST RIVER') => ({ type: 'Feature', id, properties: { objectid: id, hydroid: id, from_node: from, to_node: to, nextdownid: next, flowdir: 1, ahgfftype: 1, name }, geometry: { type: 'LineString', coordinates } });
const node = (id, type, coordinates) => ({ type: 'Feature', id: id + 100, properties: { objectid: id + 100, hydroid: id, ahgfftype: type }, geometry: { type: 'Point', coordinates } });
function fixture() {
  return { source, id: 'import', checksum: 'fixture', payload: { type: 'FeatureCollection', features: [
    line(11, 1, 2, 13, [[1,1],[2,1]]),
    line(12, 2, 3, 14, [[2,1],[4,1]]),
    line(13, 2, 5, -1, [[2,1],[2,2]], 'SIDE CREEK'),
    line(14, 3, 4, -1, [[4,1],[4.01,1]], '')
  ] }, metadata: { queryTerms: ['test river'], fields: ['hydroid','from_node','to_node','nextdownid','flowdir','ahgfftype','name'].map(name => ({ name })), geofabric: { version: 'geofabric-network/1', namedIds: [11,12], missingIds: [], nodes: [node(1,9,[1,1]),node(4,5,[4.01,1]),node(5,5,[2,2])], preferences: [], nodesUrl: geofabricStreamUrl.replace('/6','/3'), preferencesUrl: geofabricStreamUrl.replace('/6','/37') } } };
}
const trace = item => traceGeofabric(item, boundary, ['test river']);

test('directed named route overrides an unrelated downstream diversion and includes a published connector', () => {
  const result = trace(fixture());
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.records.map(f => f.properties.hydroid), [11,12,14]);
  assert.deepEqual(result.geometry.coordinates, [[1,1],[2,1],[4,1],[4.01,1]]);
  assert.equal(result.source.nodeId, 1); assert.equal(result.mouth.nodeId, 4);
  assert.equal(result.mainStem.branchDecisions[0].rule, 'named_river_continuity');
  assert.equal(result.mainStem.status, 'published_network');
});

test('against-digitized flow is reversed without changing source coordinates', () => {
  const item = fixture(); item.payload.features[1].geometry.coordinates.reverse(); item.payload.features[1].properties.flowdir = 2;
  assert.equal(trace(item).status, 'resolved');
  assert.deepEqual(trace(item).geometry.coordinates, trace(fixture()).geometry.coordinates);
});

test('published preferred edge resolves a same-name split and records its evidence', () => {
  const item = fixture(); item.payload.features[2].properties.name = 'TEST RIVER';
  item.metadata.geofabric.preferences = [{ objectid: 1000, nodeid: 2, prefedgeid: 12 }];
  const result = trace(item);
  assert.equal(result.status, 'resolved');
  assert.equal(result.mainStem.branchDecisions[0].rule, 'published_preferred_flow');
  assert.equal(result.mainStem.usedPreferences.length, 1);
});

for (const [label, mutate, pattern] of [
  ['coordinate gap', item => { item.payload.features[1].geometry.coordinates[0] = [2.001,1]; }, /coordinate gap/],
  ['unknown direction', item => { item.payload.features[1].properties.flowdir = 3; }, /unknown flow/],
  ['unclassified outlet', item => { item.metadata.geofabric.nodes[1].properties.ahgfftype = 4; }, /terminal node/],
  ['missing referenced record', item => { item.metadata.geofabric.missingIds = [90]; }, /unavailable/],
  ['missing preferred record', item => { item.metadata.geofabric.preferences = [{ nodeid: 2, prefedgeid: 90 }]; }, /preferred segment/],
  ['unknown continuation', item => { item.payload.features[2].properties.name = 'TEST RIVER'; item.payload.features[0].properties.nextdownid = 90; }, /unambiguous/],
  ['wrong terminal location', item => { item.metadata.geofabric.nodes[1].geometry.coordinates = [6,6]; }, /terminal node does not match/],
  ['incomplete source coverage', item => { item.truncated = true; }, /not complete/],
  ['out-of-range coordinate', item => { item.payload.features[1].geometry.coordinates[1] = [400,1]; }, /invalid coordinates/]
]) test(`${label} cannot be published as resolved`, () => {
  const item = fixture(); mutate(item); const result = trace(item);
  assert.equal(result.status, 'partially_resolved'); assert.ok(result.warnings.some(w => pattern.test(w)));
});

test('cycles stop with an explicit failure instead of looping', () => {
  const item = fixture(); item.payload.features[1].properties.to_node = 1; item.payload.features[1].properties.nextdownid = 11;
  item.payload.features[1].geometry.coordinates = [[2,1],[1,1]];
  const result = trace(item); assert.equal(result.status, 'partially_resolved'); assert.match(result.warnings.join(' '), /cycle/);
});

test('an unverified end node is not displayed or attributed as a network terminus', () => {
  const item = fixture(); item.metadata.geofabric.nodes[1].properties.ahgfftype = 4;
  assert.equal(trace(item).mouth, null);
  const result = processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).result;
  assert.equal(result.evidence.filter(e => e.role === 'endpoint').length, 1);
});

test('a long downstream continuation through another river does not become the named feature', () => {
  const item = fixture(); item.payload.features[3].geometry.coordinates[1] = [8,1]; item.metadata.geofabric.nodes[1].geometry.coordinates = [8,1];
  const result = trace(item); assert.equal(result.status, 'partially_resolved'); assert.match(result.warnings.join(' '), /tributary mouth/);
});

test('remote namesakes and unclassified starting points do not supply an in-scope source', () => {
  const item = fixture(); item.metadata.geofabric.nodes[0].properties.ahgfftype = 4;
  assert.match(trace(item).error, /No route/);
  assert.match(traceGeofabric(fixture(), null, ['test river']).error, /boundary/);
  assert.equal(isGeofabric({ ...source, url: source.url.replace('hosting.', 'malicious.') }), false);
});

test('two in-scope named headwaters require identity evidence, not a longest-path guess', () => {
  const item = fixture(); item.payload.features.push(line(15,6,3,14,[[3,2],[4,1]]));
  item.metadata.geofabric.namedIds.push(15); item.metadata.geofabric.nodes.push(node(6,9,[3,2]));
  assert.equal(trace(item).status, 'partially_resolved'); assert.match(trace(item).warnings.join(' '), /ambiguous/);
});

test('import expansion retrieves linked unnamed records and hashes topology evidence', async () => {
  const item = fixture(), original = structuredClone(item); item.payload.features = item.payload.features.slice(0,2);
  let queries = 0;
  const load = async input => {
    const url = new URL(input); queries++;
    if (url.pathname.endsWith('/6/query')) return { features: original.payload.features.slice(2) };
    if (url.pathname.endsWith('/3/query')) return { features: original.metadata.geofabric.nodes };
    if (url.pathname.endsWith('/37/query')) return { features: [] };
    assert.fail('Unexpected URL');
  };
  const expanded = await extendGeofabric(item, load);
  assert.equal(expanded.payload.features.length, 4); assert.equal(queries, 3);
  assert.equal(expanded.metadata.geofabric.missingIds.length, 0);
  assert.equal(trace(expanded).status, 'resolved');
  assert.equal(expanded.checksum, createHash('sha256').update(JSON.stringify({ payload: expanded.payload, trace: expanded.metadata.geofabric })).digest('hex'));
  await assert.rejects(extendGeofabric(item, async () => ({ features: [], exceededTransferLimit: true })), /incomplete/);
});

test('processor carries endpoint and decision provenance; explicit partial coverage stays partial', () => {
  const item = fixture();
  const result = processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).result;
  assert.equal(result.status, 'resolved'); assert.equal(result.method, 'geofabric_directed_main_stem');
  assert.equal(result.confidence, 'derived_published_network');
  assert.equal(result.evidence.filter(e => e.role === 'endpoint').length, 2);
  item.source = { ...source, completeness: 'partial' };
  assert.equal(processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).status, 'partially_resolved');
});

test('directed completion saves a reusable feature without AI research or a review request', async () => {
  const store = createStore(':memory:');
  try {
    const id = store.addSource(source); store.decideSource(id, 'approved', source);
    const job = store.request('Test River', 'river');
    const worker = createWorker(store, { boundary, importer: async () => fixture(), researcher: async () => assert.fail('No research should be needed') }); worker.stop();
    await worker.run(job);
    assert.equal(store.getJob(job.id).status, 'resolved'); assert.equal(store.getJob(job.id).phase, 'completed');
    assert.equal(store.reports().length, 0); assert.equal(store.feature(store.getJob(job.id).feature_id).source.nodeId, 1);
  } finally { store.close(); }
});
