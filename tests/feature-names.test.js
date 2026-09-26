import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, featureSearchTerms, normalize } from '../server/store.js';
import { createApp } from '../server/app.js';
import { importSource } from '../server/importer.js';

const source = { type: 'river', status: 'approved', format: 'geojson', url: 'https://example.org/rivers.json', nameField: 'name', idField: 'id' };
const record = (name, id) => ({ type: 'Feature', properties: { name, id }, geometry: { type: 'LineString', coordinates: [[1,1],[2,2]] } });

function legacyRequest(store, id, query, status) {
  store.db.prepare('INSERT INTO jobs(id,query,normalized,type,status,phase,message,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, query, normalize(query), 'river', status, 'awaiting_review', 'Legacy request', '2026-01-01', '2026-01-01');
  return store.getJob(id);
}

test('optional River suffix produces stable exact terms, not fuzzy or cross-type matches', () => {
  for (const query of ['Loddon', ' LODDON   River ', '\uff2c\uff4f\uff44\uff44\uff4f\uff4e']) {
    assert.deepEqual(featureSearchTerms(query, 'river'), ['loddon river', 'loddon']);
  }
  assert.deepEqual(featureSearchTerms('Loddon', 'valley'), ['loddon']);
  assert.deepEqual(featureSearchTerms('Loddon Valley', 'valley'), ['loddon valley']);
  assert.deepEqual(featureSearchTerms('River', 'river'), ['river']);
  assert.deepEqual(featureSearchTerms(undefined, 'river'), []);
  assert.deepEqual(featureSearchTerms('Little Loddon River', 'river'), ['little loddon river', 'little loddon']);
  assert.deepEqual(featureSearchTerms('Loddon', 'river', ['Loddon River', 'River Loddon']), ['loddon river', 'loddon', 'river loddon']);
});

test('both search orders reuse one job and preserve original search text', () => {
  for (const queries of [['Loddon', 'Loddon River'], ['Loddon River', 'Loddon']]) {
    const store = createStore(':memory:');
    try {
      const first = store.request(queries[0], 'river'), second = store.request(queries[1], 'river');
      assert.equal(first.id, second.id);
      assert.equal(store.jobs().length, 1);
      assert.deepEqual(store.db.prepare('SELECT query FROM searches ORDER BY id').all().map(r => r.query), queries);
      for (const name of ['Little Loddon River', 'Loddon Creek', 'River Loddon']) assert.notEqual(store.request(name, 'river').id, first.id);
      assert.notEqual(store.request('Loddon', 'valley').id, first.id);
    } finally { store.close(); }
  }
});

test('legacy duplicate requests prefer available geometry without changing history or evidence', () => {
  for (const completedName of ['Loddon', 'Loddon River']) {
    const store = createStore(':memory:');
    try {
      const otherName = completedName === 'Loddon' ? 'Loddon River' : 'Loddon';
      const completed = legacyRequest(store, 'completed', completedName, 'resolved');
      const failed = legacyRequest(store, 'failed', otherName, 'insufficient_data');
      const feature = store.saveFeature(completed, { status: 'resolved', geometry: record('Loddon River', 1).geometry });
      const reportId = store.report(failed.id, { summary: 'Historical research', candidates: [] });
      for (const query of ['Loddon', 'Loddon River']) {
        assert.equal(store.request(query, 'river').id, completed.id);
        assert.equal(store.request(query, 'river').feature_id, feature.id);
      }
      assert.equal(store.jobs().length, 2);
      assert.equal(store.reports()[0].id, reportId);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM derivations').get().n, 1);
      assert.equal(store.getJob(failed.id).status, 'insufficient_data');
      store.invalidateFeature(completed.id, 'Source withdrawn');
      assert.equal(store.jobFeatures(store.request('Loddon', 'river').id).length, 0);
    } finally { store.close(); }
  }
});

test('legacy partial geometry is reusable and completed geometry wins over partial duplicates', () => {
  const store = createStore(':memory:');
  try {
    const partial = legacyRequest(store, 'partial', 'Loddon', 'partially_resolved');
    const full = legacyRequest(store, 'full', 'Loddon River', 'pending');
    store.saveFeature(partial, { status: 'partially_resolved' });
    assert.equal(store.request('Loddon River', 'river').id, partial.id);
    store.saveFeature(full, { status: 'resolved' });
    store.updateJob(full.id, 'resolved', 'completed', 'Ready');
    assert.equal(store.request('Loddon', 'river').id, full.id);
    assert.equal(store.request('Loddon River', 'river').id, full.id);
  } finally { store.close(); }
});

test('GeoJSON import matches both river forms but excludes similarly named rivers', async () => {
  const features = ['Loddon River', 'Loddon', 'Little Loddon River', 'Loddon Creek', 'River Loddon'].map(record);
  for (const query of ['Loddon', 'Loddon River']) {
    const imported = await importSource(source, query, async () => ({ type: 'FeatureCollection', features }));
    assert.deepEqual(imported.payload.features.map(f => f.properties.id), [0,1]);
    assert.deepEqual(imported.metadata.queryTerms, ['loddon river', 'loddon']);
  }
});

test('ArcGIS queries both exact forms and deduplicates overlapping IDs before downloading geometry', async () => {
  const where = [], batches = [];
  const imported = await importSource({ ...source, format: 'arcgis', url: 'https://example.org/FeatureServer/1' }, 'Loddon', async url => {
    const parsed = new URL(url), params = parsed.searchParams;
    if (!parsed.pathname.endsWith('/query')) return { fields: [{ name: 'name' }] };
    if (params.has('returnIdsOnly')) {
      where.push(params.get('where'));
      return { objectIds: where.length === 1 ? [1,2] : [2,3] };
    }
    const ids = params.get('objectIds').split(',').map(Number);
    batches.push(ids);
    return { features: ids.map(id => record('Loddon River', id)) };
  });
  assert.deepEqual(where, ["UPPER(name) IN ('LODDON RIVER')", "UPPER(name) IN ('LODDON')"]);
  assert.deepEqual(batches, [[1,2,3]]);
  assert.equal(imported.payload.features.length, 3);
  assert.equal(imported.truncated, false);
});

test('public search returns the same completed feature for both names without new processing', async () => {
  const store = createStore(':memory:');
  const job = legacyRequest(store, 'completed', 'Loddon River', 'resolved');
  const feature = store.saveFeature(job, { status: 'resolved', geometry: record('Loddon River', 1).geometry });
  legacyRequest(store, 'failed', 'Loddon', 'insufficient_data');
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const query of ['Loddon', 'Loddon River']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, type: 'river' })
      });
      assert.equal(response.status, 200);
      const found = await response.json();
      assert.equal(found.id, job.id); assert.equal(found.feature.id, feature.id);
      assert.equal(found.selectionRequired, false);
    }
    assert.equal(store.jobs().length, 2);
    assert.equal(store.reports().length, 0);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  }
});
