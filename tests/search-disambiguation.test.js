import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

test('type suggestions leave jobs untouched until a user chooses a search', async () => {
  const store = createStore(':memory:');
  const server = createApp(store).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const search = async (type, confirmType = false, query = 'Axe Creek') => {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, type, confirmType })
      });
      return result.json();
    };
    assert.deepEqual((await search('national_park')).alternatives, [{ query: 'Axe Creek', type: 'river', saved: false }]);
    assert.equal(store.jobs().length, 0);
    const river = await search('river', true);
    store.saveFeature(store.getJob(river.id), { status: 'resolved' });
    assert.deepEqual((await search('national_park', false, 'AXE  CREEK')).alternatives, [{ query: 'Axe Creek', type: 'river', saved: true }]);
    assert.equal(store.jobs().length, 1);
    const park = await search('national_park', true);
    assert.equal(park.type, 'national_park');
    assert.equal(park.query, 'Axe Creek');
    store.saveFeature(store.getJob(park.id), { status: 'resolved' });
    assert.equal((await search('national_park')).id, park.id);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
