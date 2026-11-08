import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

test('pilot history keeps past geometry and lineage separate from the current revision', async () => {
  const store = createStore(':memory:');
  const avoca = store.request('Avoca', 'river');
  const bunyip = store.request('Bunyip State Park', 'state_park');
  const unrelated = store.request('Bunyip State Park', 'state_forest');
  const first = {
    method: 'geofabric_directed_main_stem', algorithmVersion: 'river/1', status: 'partially_resolved',
    geometry: { type: 'LineString', coordinates: [[144, -36], [145, -36]] },
    evidence: [{ sourceName: 'Geofabric', objectId: 'old-reach', importId: 'old-import', role: 'route_segment' }],
    interpolations: { features: [{ properties: { id: 'gap', label: 'Lake Bael Bael', lengthKm: 0.35 } }] },
    warnings: ['Connection not verified.']
  };
  const river = store.saveFeature(avoca, first);
  const oldId = store.featureRevisions(river.id)[0].id;
  const updated = store.saveFeature(avoca, {
    ...first, algorithmVersion: 'river/2', status: 'resolved', evidence: [], interpolations: undefined, warnings: [],
    geometry: { type: 'LineString', coordinates: [[144, -36], [146, -36]] }
  });
  const park = store.saveFeature(bunyip, { method: 'plm25_named_state_park_parcels', status: 'resolved' });
  const forest = store.saveFeature(unrelated, {});
  const server = createApp(store).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const read = (id, query = '') => fetch(`http://127.0.0.1:${server.address().port}/api/features/${id}/provenance${query}`);
    const current = await (await read(river.id)).json();
    assert.equal(updated.id, river.id);
    assert.equal(current.revisions.length, 2);
    assert.equal(current.lineage.processorVersion, 'river/2');
    assert.equal(current.lineage.estimates, undefined);
    assert.equal(current.lineage.geometry, undefined);
    const old = await (await read(river.id, `?revision=${oldId}`)).json();
    assert.equal(old.revisionId, oldId);
    assert.equal(old.lineage.status, 'partially_resolved');
    assert.equal(old.lineage.evidence[0].objectId, 'old-reach');
    assert.equal(old.lineage.estimates[0].label, 'Lake Bael Bael');
    assert.deepEqual(old.lineage.limitations, first.warnings);
    assert.deepEqual(store.featureRevision(river.id, oldId).geometry, first.geometry);
    assert.deepEqual(store.feature(river.id).geometry, updated.geometry);
    assert.equal((await read(park.id, `?revision=${oldId}`)).status, 404);
    assert.equal((await read(forest.id)).status, 404);
    assert.match((await (await read(park.id)).json()).lineage.description, /PLM25/);
    store.db.prepare('DELETE FROM derivations WHERE feature_id=?').run(park.id);
    assert.deepEqual(await (await read(park.id)).json(), { revisions: [], lineage: null });
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
