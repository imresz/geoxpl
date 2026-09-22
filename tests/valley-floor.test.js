import test from 'node:test';
import assert from 'node:assert/strict';
import { area, feature } from '@turf/turf';
import { importSource } from '../server/importer.js';
import { processGeometry } from '../server/processors.js';
import { landformEndpoint, drainageFingerprint } from '../server/valley-floor.js';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { createApp } from '../server/app.js';

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
const boundary = feature(box(144,-39,147,-36));
const source = { id: 'landforms', name: 'Synthetic GMU250', type: 'valley', format: 'vic-gmu250', url: landformEndpoint, nameField: 'gmu_t3_desc', idField: 'gmu_t3', completeness: 'complete', status: 'approved', licence: 'CC BY 4.0', attribution: 'Synthetic test', version: 'test', aliases: [], notes: '' };
const job = { query: 'Synthetic Valley', type: 'valley' };
const drainage = { id: 'river', name: 'Synthetic River', type: 'river', status: 'resolved', geometry: { type: 'LineString', coordinates: [[145,-37.5],[145.3,-37.5]] }, evidence: [{ sourceId: 'hydro', role: 'route_segment', objectId: 'stream-1' }], warnings: [], algorithmVersion: 'test' };
const settings = { aliases: [], preferredSourceId: source.id, valleyFloor: { sourceId: source.id, drainageFeatureId: drainage.id, recordIds: ['gmu250.1'], scopeNote: 'Synthetic reviewed valley floor, not a full named valley boundary.', evidenceUrl: 'https://example.org/evidence' } };
const record = (id = 'gmu250.1', geometry = box(145,-37.6,145.2,-37.4)) => ({ type: 'Feature', id, properties: { gmu_t3: '1.3.3', lfm_pattern: 'TER', lfm_element: 'TEP' }, geometry });
const fixture = () => ({ source: { ...source }, id: 'import', checksum: 'snapshot', truncated: false, payload: { type: 'FeatureCollection', features: [record()] }, metadata: { adapter: 'vic-gmu250/1' } });
const run = (item = fixture(), config = settings, river = drainage, scope = boundary) => processGeometry(job, [item], scope, config, { drainage: river });
const response = (features = [record()]) => ({ type: 'FeatureCollection', features, numberMatched: features.length, numberReturned: features.length, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } } });

test('GMU250 adapter imports only reviewed IDs with an auditable bounded request', async () => {
  let request;
  const result = await importSource(source, job.query, async url => { request = new URL(url); return response(); }, settings);
  assert.equal(request.searchParams.get('resourceID'), 'gmu250.1');
  assert.equal(request.searchParams.get('srsName'), 'EPSG:4326');
  assert.equal(request.searchParams.get('count'), '2');
  assert.equal(result.metadata.requestUrl, request.href); assert.equal(result.truncated, false);
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
});

test('GMU250 import refuses missing, duplicate, extra, truncated and wrong-CRS records', async () => {
  for (const bad of [response([]), response([record(),record()]), response([record('gmu250.2')]), { ...response(), numberMatched: 2 }, { ...response(), links: [{ rel: 'next' }] }, { ...response(), crs: { properties: { name: 'EPSG:3857' } } }]) {
    await assert.rejects(importSource(source, job.query, async () => bad, settings), /records|WGS84/);
  }
});

test('unapproved, unrelated endpoints and injected record IDs cannot be imported', async () => {
  const load = () => { throw Error('must not fetch'); };
  await assert.rejects(importSource({ ...source, status: 'pending' }, job.query, load, settings), /not approved/);
  await assert.rejects(importSource({ ...source, url: 'https://example.org/wfs' }, job.query, load, settings), /official|approved/);
  await assert.rejects(importSource(source, job.query, load, { ...settings, valleyFloor: { ...settings.valleyFloor, recordIds: ["gmu250.1' OR 1=1"] } }));
});

test('landforms remain partial estimates even when source completeness is complete', () => {
  const result = run().result;
  assert.equal(result.status, 'partially_resolved'); assert.equal(result.confidence, 'estimated');
  assert.equal(result.extentEstimate.kind, 'valley_floor');
  assert.equal(result.principalDrainage.checksum, drainageFingerprint(drainage));
  assert.equal(result.evidence[0].role, 'mapped_landform'); assert.equal(result.evidence[1].role, 'principal_drainage_support');
  assert.equal(result.areaKm2, area(feature(result.geometry)) / 1e6);
  assert.equal(result.lengthKm, null); assert.equal(result.interpolations.features.length, 0);
  assert.match(result.warnings.join(' '), /not the complete ridge-to-ridge/);
});

test('landform boundaries retain holes and are not replaced with a river buffer', () => {
  const item = fixture(); item.payload.features[0].geometry.coordinates.push([[145.02,-37.48],[145.02,-37.42],[145.05,-37.42],[145.05,-37.48],[145.02,-37.48]]);
  const result = run(item).result;
  assert.deepEqual(result.geometry, item.payload.features[0].geometry);
});

test('overlapping mapped units are unioned without double-counting area', () => {
  const item = fixture(); item.payload.features.push(record('gmu250.2', box(145.1,-37.6,145.3,-37.4)));
  const config = { ...settings, valleyFloor: { ...settings.valleyFloor, recordIds: ['gmu250.1','gmu250.2'] } };
  const result = run(item, config).result;
  assert.ok(Math.abs(result.areaKm2 - area(feature(box(145,-37.6,145.3,-37.4))) / 1e6) < 0.0001);
});

test('nonintersecting islands are excluded, but a mismatched reviewed record fails', () => {
  const item = fixture(); item.payload.features[0].geometry = { type: 'MultiPolygon', coordinates: [box(145,-37.6,145.2,-37.4).coordinates, box(146,-38,146.2,-37.8).coordinates] };
  const result = run(item).result;
  assert.equal(result.identity.excludedPolygonParts, 1); assert.ok(result.bbox[2] < 145.3);
  item.payload.features[0].geometry = box(146,-38,146.2,-37.8);
  assert.equal(run(item).result, undefined);
});

test('parks, hills, wrong classifications, invalid geometry and incomplete snapshots cannot stand in for valleys', () => {
  const variants = [r => r.properties.gmu_t3 = 'park', r => r.properties.lfm_pattern = 'HIL', r => r.geometry = { type: 'Point', coordinates: [145,-37.5] }, r => r.geometry.coordinates[0][0][0] = 200];
  for (const mutate of variants) { const item = fixture(); mutate(item.payload.features[0]); assert.equal(run(item).result, undefined); }
  assert.equal(run({ ...fixture(), truncated: true }).result, undefined);
  assert.equal(run({ ...fixture(), metadata: {} }).result, undefined);
});

test('unresolved or wrong drainage, absent boundary and unreviewed association fail closed', () => {
  for (const river of [null, { ...drainage, id: 'other' }, { ...drainage, status: 'partially_resolved' }, { ...drainage, type: 'valley' }]) assert.equal(run(fixture(), settings, river).result, undefined);
  assert.equal(run(fixture(), settings, drainage, null).result, undefined);
  assert.equal(run(fixture(), { ...settings, valleyFloor: undefined }).result, undefined);
});

function seededStore() {
  const store = createStore(':memory:');
  const riverJob = store.request('Synthetic River', 'river');
  const river = store.saveFeature(riverJob, drainage);
  store.updateJob(riverJob.id, 'resolved', 'completed', 'Ready', river.id);
  const sourceId = store.addSource(source); store.decideSource(sourceId, 'approved', source);
  const valleyJob = store.request(job.query, 'valley');
  const config = { ...settings, preferredSourceId: sourceId, valleyFloor: { ...settings.valleyFloor, sourceId, drainageFeatureId: river.id } };
  store.setFeatureSettings(valleyJob.id, config);
  return { store, riverJob, river, valleyJob, config, sourceId };
}

test('worker reuses stable estimate, avoids automatic AI review and public search returns it without claiming resolved', async () => {
  const { store, valleyJob, config, river, sourceId } = seededStore(); let researchCalls = 0;
  const worker = createWorker(store, { boundary, importer: async () => fixture(), researcher: async () => { researchCalls++; return { provider: 'test', summary: 'Explicit research', candidates: [] }; } }); worker.stop();
  const server = createApp(store).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    await worker.run(valleyJob); const id = store.jobFeatures(valleyJob.id)[0].id;
    await worker.run(valleyJob); assert.equal(researchCalls, 0); assert.equal(store.jobFeatures(valleyJob.id)[0].id, id);
    assert.equal(store.getJob(valleyJob.id).phase, 'available_estimate');
    const found = await (await fetch(root + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: job.query.toUpperCase(), type: 'valley' }) })).json();
    assert.equal(found.feature.extentEstimate.kind, 'valley_floor'); assert.equal(found.status, 'partially_resolved');
    const catalogue = await (await fetch(root + '/api/catalogue')).json(); assert.ok(!catalogue.some(f => f.id === id));
    store.setting(`research:${valleyJob.id}`, 'true'); await worker.run(valleyJob); assert.equal(researchCalls, 1);
    assert.equal(store.feature(id).principalDrainage.featureId, river.id); assert.equal(config.valleyFloor.sourceId, sourceId);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('river replacement and withdrawal invalidate dependent estimates but preserve audit history', async () => {
  for (const operation of ['replace', 'withdraw']) {
    const { store, valleyJob, riverJob, river, config, sourceId } = seededStore();
    try {
      const item = fixture(); item.source = { ...source, id: sourceId };
      const estimate = store.saveFeature(valleyJob, run(item, config, river).result);
      if (operation === 'replace') store.saveFeature(riverJob, { ...river, algorithmVersion: 'updated' });
      else store.invalidateFeature(riverJob.id, 'River source withdrawn');
      assert.equal(store.feature(estimate.id), null); assert.equal(store.getJob(valleyJob.id).feature_id, null);
      assert.equal(store.getJob(valleyJob.id).phase, 'awaiting_data');
      assert.match(store.getJob(valleyJob.id).message, /Principal river/);
      assert.ok(store.db.prepare('SELECT COUNT(*) n FROM derivations WHERE feature_id=?').get(estimate.id).n > 0);
    } finally { store.close(); }
  }
});

test('authenticated settings reject unsupported drainage and preserve reviewed association on unchanged edits', async () => {
  const { store, valleyJob, config, river } = seededStore();
  store.updateJob(valleyJob.id, 'partially_resolved', 'available_estimate', 'Estimate available');
  const server = createApp(store).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const path = `/api/admin/jobs/${valleyJob.id}/settings`;
    const call = (body, cookie = '') => fetch(root + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal((await call(config)).status, 401);
    const setup = await fetch(root + '/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-password-only' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await call({ ...config, valleyFloor: { ...config.valleyFloor, drainageFeatureId: 'unknown' } }, cookie)).status, 400);
    assert.equal((await call({ aliases: [], preferredSourceId: config.preferredSourceId }, cookie)).status, 200);
    assert.equal(store.featureSettings(valleyJob.id).valleyFloor.drainageFeatureId, river.id);
    const invalidSource = await fetch(root + '/api/admin/sources', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...source, type: 'river' }) });
    assert.equal(invalidSource.status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
