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
    if (url.pathname.endsWith('/6/query')) {
      const field = url.searchParams.get('where').split(' ')[0];
      return { features: field === 'hydroid' ? original.payload.features.slice(2) : original.payload.features.filter(f => f.properties[field] === 3) };
    }
    if (url.pathname.endsWith('/3/query')) return { features: original.metadata.geofabric.nodes };
    if (url.pathname.endsWith('/37/query')) return { features: [] };
    assert.fail('Unexpected URL');
  };
  const expanded = await extendGeofabric(item, load);
  assert.equal(expanded.payload.features.length, 4); assert.equal(queries, 5);
  assert.equal(expanded.metadata.geofabric.missingIds.length, 0);
  assert.equal(trace(expanded).status, 'resolved');
  assert.equal(expanded.checksum, createHash('sha256').update(JSON.stringify({ payload: expanded.payload, trace: expanded.metadata.geofabric })).digest('hex'));
  await assert.rejects(extendGeofabric(item, async () => ({ features: [], exceededTransferLimit: true })), /incomplete/);
});

function tributary() {
  const item = fixture();
  const last = item.payload.features[1]; last.properties.nextdownid = 21;
  const downstream = line(21,3,4,-1,[[4,1],[8,1]],'RECEIVING RIVER');
  const upstream = line(20,6,3,21,[[4,3],[4,1]],'RECEIVING RIVER');
  item.payload.features[3] = downstream;
  item.metadata.geofabric.version = 'geofabric-network/2';
  item.metadata.geofabric.nodes[1].geometry.coordinates = [8,1];
  item.metadata.geofabric.nodes.push(node(3,4,[4,1]));
  item.metadata.geofabric.junctions = [{ nodeId: 3, incoming: [last,upstream], outgoing: [downstream] }];
  return item;
}

test('tributary ends at a published receiving-river junction, without adding receiving geometry', () => {
  const item = tributary(), result = trace(item);
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.records.map(f => f.properties.hydroid), [11,12]);
  assert.deepEqual(result.geometry.coordinates, [[1,1],[2,1],[4,1]]);
  assert.equal(result.mouth.nodeId, 3);
  assert.equal(result.mouth.classification, 'BoM river confluence');
  assert.equal(result.mouth.receivingRiver, 'RECEIVING RIVER');
  assert.deepEqual(result.confluenceRecords.map(f => f.properties.hydroid), [20,21]);
  const processed = processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).result;
  assert.equal(processed.mainStem.termination.rule, 'published_receiving_river_continuity');
  assert.equal(processed.mainStem.termination.receivingUpstreamHydroId, 20);
  assert.equal(processed.evidence.filter(e => e.role === 'route_segment').length, 2);
  assert.deepEqual(processed.evidence.filter(e => e.role === 'confluence_support').map(e => e.hydroId), [20,21]);
  assert.ok(processed.evidence.every(e => e.importId === 'import' && e.checksum === 'fixture'));
  assert.ok(!('confluenceRecords' in processed));
});

for (const [label, mutate] of [
  ['missing junction', item => { item.metadata.geofabric.nodes.pop(); }],
  ['non-junction node', item => { item.metadata.geofabric.nodes.at(-1).properties.ahgfftype = 7; }],
  ['missing upstream receiver', item => { item.metadata.geofabric.junctions[0].incoming.pop(); }],
  ['receiving name mismatch', item => { item.metadata.geofabric.junctions[0].incoming[1].properties.name = 'ANOTHER RIVER'; }],
  ['wrong tributary flow link', item => { item.payload.features[1].properties.nextdownid = 13; }],
  ['wrong receiving flow link', item => { item.metadata.geofabric.junctions[0].incoming[1].properties.nextdownid = 13; }],
  ['unknown receiving direction', item => { item.metadata.geofabric.junctions[0].incoming[1].properties.flowdir = 3; }],
  ['receiving geometry gap', item => { item.metadata.geofabric.junctions[0].incoming[1].geometry.coordinates[1] = [4.001,1]; }],
  ['junction point gap', item => { item.metadata.geofabric.nodes.at(-1).geometry.coordinates = [4.001,1]; }],
  ['ambiguous downstream branches', item => { item.metadata.geofabric.junctions[0].outgoing.push(line(22,3,7,-1,[[4,1],[4,5]],'SECOND RIVER')); }],
  ['ambiguous incoming receiver', item => { item.metadata.geofabric.junctions[0].incoming.push(line(23,7,3,21,[[5,4],[4,1]],'RECEIVING RIVER')); }],
  ['inconsistent snapshot', item => { const copy = structuredClone(item.payload.features[1]); copy.properties.from_node = 90; item.metadata.geofabric.junctions[0].incoming[0] = copy; }],
  ['inconsistent receiving snapshot', item => { const copy = structuredClone(item.payload.features[3]); copy.geometry.coordinates[1] = [7,1]; item.metadata.geofabric.junctions[0].outgoing[0] = copy; }],
  ['wrong receiving node ID', item => { item.metadata.geofabric.junctions[0].incoming[1].properties.to_node = 99; }]
]) test(`${label} cannot verify a tributary mouth`, () => {
  const item = tributary(); mutate(item); const result = trace(item);
  assert.equal(result.status, 'partially_resolved');
  assert.notEqual(result.mainStem.termination.kind, 'confluence');
});

test('against-digitized receiving records can prove a confluence', () => {
  const item = tributary();
  for (const f of [item.metadata.geofabric.junctions[0].incoming[1], item.metadata.geofabric.junctions[0].outgoing[0]]) {
    f.properties.flowdir = 2; f.geometry.coordinates.reverse();
  }
  assert.equal(trace(item).status, 'resolved');
  assert.equal(trace(item).mainStem.termination.kind, 'confluence');
});

test('a short name transition is not mistaken for a receiving-river confluence', () => {
  const item = tributary(); item.metadata.geofabric.junctions[0].incoming.pop();
  item.payload.features[3].geometry.coordinates[1] = [4.001,1];
  item.metadata.geofabric.nodes[1].geometry.coordinates = [4.001,1];
  assert.equal(trace(item).status, 'resolved');
  assert.equal(trace(item).mainStem.termination.kind, 'network_terminus');
  assert.deepEqual(trace(item).mainStem.selectedHydroIds, [11,12,21]);
});

test('a through-river or approved alias continues past a junction instead of being truncated', () => {
  for (const continuationName of ['TEST RIVER', 'RIVER TEST']) {
    const item = tributary(), continuation = line(22,3,7,-1,[[4,1],[5,2]],continuationName);
    item.payload.features.push(continuation);
    item.metadata.geofabric.junctions[0].outgoing.push(continuation);
    item.metadata.geofabric.nodes.push(node(7,5,[5,2]));
    item.payload.features[1].properties.nextdownid = 22;
    const result = traceGeofabric(item, boundary, ['test river','river test']);
    assert.equal(result.status, 'resolved');
    assert.equal(result.mainStem.termination.kind, 'network_terminus');
    assert.deepEqual(result.mainStem.selectedHydroIds, [11,12,22]);
    assert.equal(result.confluenceRecords.length, 0);
  }
});

test('confluence imports retain complete adjacent evidence separately and checksum it', async () => {
  const full = tributary(), seeds = structuredClone(full);
  seeds.payload.features = seeds.payload.features.slice(0,2);
  const all = [...full.payload.features, full.metadata.geofabric.junctions[0].incoming[1]];
  const calls = [];
  const load = async input => {
    const url = new URL(input), where = url.searchParams.get('where'); calls.push(url);
    const [field] = where.split(' '), ids = where.match(/\((.*)\)/)[1].split(',').map(Number);
    if (url.pathname.endsWith('/6/query')) return { features: all.filter(f => ids.includes(f.properties[field])) };
    if (url.pathname.endsWith('/3/query')) return { features: full.metadata.geofabric.nodes.filter(f => ids.includes(f.properties.hydroid)) };
    if (url.pathname.endsWith('/37/query')) return { features: [] };
    assert.fail('Unexpected URL');
  };
  const imported = await extendGeofabric(seeds, load);
  assert.equal(imported.metadata.geofabric.version, 'geofabric-network/3');
  assert.ok(calls.some(url => url.searchParams.get('where') === 'to_node IN (3)'));
  assert.ok(calls.some(url => url.searchParams.get('where') === 'from_node IN (3)'));
  assert.ok(!imported.payload.features.some(f => f.properties.hydroid === 20));
  assert.equal(trace(imported).status, 'resolved');
  const altered = structuredClone(imported.metadata.geofabric);
  altered.junctions[0].incoming[1].properties.flowdir = 3;
  assert.notEqual(imported.checksum, createHash('sha256').update(JSON.stringify({ payload: imported.payload, trace: altered })).digest('hex'));
  await assert.rejects(extendGeofabric(seeds, async input => new URL(input).searchParams.get('where').startsWith('to_node') ? { features: [], exceededTransferLimit: true } : load(input)), /incomplete/);
});

test('old snapshots cannot claim confluence evidence they never imported', () => {
  const item = tributary(); delete item.metadata.geofabric.junctions;
  item.metadata.geofabric.version = 'geofabric-network/1';
  assert.equal(trace(item).status, 'partially_resolved');
  assert.notEqual(trace(item).mainStem.termination.kind, 'confluence');
});

test('worker publishes a confluence result without requesting another review', async () => {
  const store = createStore(':memory:');
  try {
    const id = store.addSource(source); store.decideSource(id, 'approved', source);
    const job = store.request('Test River', 'river');
    const worker = createWorker(store, { boundary, importer: async () => tributary(), researcher: async () => assert.fail('A verified confluence must not request AI research') });
    worker.stop(); await worker.run(job);
    const completed = store.getJob(job.id), saved = store.feature(completed.feature_id);
    assert.equal(completed.phase, 'completed'); assert.equal(completed.status, 'resolved');
    assert.equal(saved.mouth.classification, 'BoM river confluence');
    assert.equal(saved.mainStem.selectedHydroIds.length, 2);
    assert.equal(store.reports().length, 0);
  } finally { store.close(); }
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

test('only official equivalent stream endpoints invoke directed processing', () => {
  assert.equal(isGeofabric(source), true);
  const item = fixture(); item.source = { ...source, url: source.url.replace('/MapServer/', '/FeatureServer/') + '/' };
  assert.equal(isGeofabric(item.source), true);
  assert.equal(processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).result.method, 'geofabric_directed_main_stem');
  for (const url of [source.url.replace('/6', '/24'), source.url + '?f=json', source.url.replace('https:', 'http:'), source.url.replace('bom.gov.au', 'bom.gov.au.example.com')]) assert.equal(isGeofabric({ ...source, url }), false);
});

async function namedReachFixture() {
  const original = fixture(); original.metadata.geofabric.nodes[0].properties.ahgfftype = 4;
  const incoming = [line(31, 7, 1, 11, [[0.5,1],[1,1]], ''), line(32, 8, 1, 11, [[1,0.5],[1,1]], '')];
  const streams = [...original.payload.features, ...incoming];
  const nodes = [...original.metadata.geofabric.nodes, node(7,9,[0.5,1]), node(8,9,[1,0.5])];
  const seeds = structuredClone(original); seeds.payload.features = seeds.payload.features.slice(0,2);
  const load = async input => {
    const url = new URL(input), where = url.searchParams.get('where');
    const [field] = where.split(' '), ids = where.match(/\((.*)\)/)[1].split(',').map(Number);
    if (url.pathname.endsWith('/6/query')) return { features: streams.filter(f => ids.includes(f.properties[field])) };
    if (url.pathname.endsWith('/3/query')) return { features: nodes.filter(f => ids.includes(f.properties.hydroid)) };
    if (url.pathname.endsWith('/37/query')) return { features: [] };
    assert.fail('Unexpected URL');
  };
  return extendGeofabric(seeds, load);
}

test('an upstream identity gap produces a partial directed named reach, never an invented headwater', async () => {
  const item = await namedReachFixture(), result = trace(item);
  assert.equal(result.status, 'partially_resolved');
  assert.equal(result.source, null); assert.equal(result.mouth.nodeId, 4);
  assert.deepEqual(result.mainStem.selectedHydroIds, [11,12,14]);
  assert.equal(result.mainStem.namedStart.nodeId, 1);
  assert.equal(result.mainStem.headwater.status, 'unverified_named_start');
  assert.deepEqual(result.mainStem.headwater.upstreamHydroIds, [31,32]);
  assert.match(result.warnings.join(' '), /2 upstream stream\(s\).*none has been appended/);
  assert.equal(item.payload.features.length, 4);
  assert.equal(result.headwaterNodes.length, 2);
  assert.equal(item.checksum, createHash('sha256').update(JSON.stringify({ payload: item.payload, trace: item.metadata.geofabric })).digest('hex'));
  const processed = processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).result;
  assert.deepEqual(processed.evidence.filter(e => e.role === 'headwater_identity_support').map(e => e.hydroId), [31,32]);
  assert.equal(processed.evidence.filter(e => e.role === 'upstream_node_support').length, 2);
  assert.equal(processed.evidence.filter(e => e.role === 'endpoint').length, 1);
  assert.equal(processed.evidence.filter(e => e.role === 'named_start').length, 1);
  assert.ok(!('headwaterRecords' in processed));
  item.source = { ...source, completeness: 'complete' };
  assert.equal(processGeometry({ query: 'Test River', type: 'river' }, [item], boundary).status, 'partially_resolved');
});

test('one unnamed upstream branch still requires identity evidence; absent start evidence cannot be claimed', async () => {
  const item = await namedReachFixture(); item.metadata.geofabric.headwaterContexts[0].incoming.pop();
  assert.equal(trace(item).status, 'partially_resolved'); assert.equal(trace(item).source, null);
  item.metadata.geofabric.headwaterContexts = [];
  assert.match(trace(item).error, /No route/);
});

test('partial named-reach processing waits for specific evidence without repeating AI review', async () => {
  const item = await namedReachFixture(), store = createStore(':memory:');
  try {
    const id = store.addSource(source); store.decideSource(id, 'approved', source);
    const job = store.request('Test River', 'river');
    const worker = createWorker(store, { boundary, importer: async () => item, researcher: async () => assert.fail('No repeated AI report') });
    worker.stop(); await worker.run(job);
    assert.equal(store.getJob(job.id).phase, 'awaiting_data');
    assert.equal(store.getJob(job.id).status, 'partially_resolved');
    assert.match(store.getJob(job.id).message, /upstream stream/);
    assert.equal(store.reports().length, 0);
  } finally { store.close(); }
});
