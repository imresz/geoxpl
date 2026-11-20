import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMetroRoute } from '../server/metro-routes.js';
import { pilotRouteCode } from '../server/road-routes.js';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

const snapshot = code => JSON.parse(readFileSync(new URL(`../scripts/data/metropolitan-route-${code}-review.geojson`, import.meta.url)));

test('Metropolitan aliases are exact and do not overlap national or alphanumeric codes', () => {
  for (const prefix of ['', 'Route ', 'State Route ', 'Metropolitan Route ', 'Metro Route ']) {
    assert.equal(pilotRouteCode(prefix + '24'), '24');
    assert.equal(pilotRouteCode(prefix + '26'), '26');
  }
  for (const query of ['C124','National Route 24','Historical National Route 1','Route 1']) {
    assert.equal(pilotRouteCode(query), null);
  }
  assert.equal(pilotRouteCode('M1'), 'M1');
  assert.equal(pilotRouteCode('A1'), 'A1');
});

test('reviewed snapshots remain partial with actual check locations and recorded code discrepancies', () => {
  for (const [code, count, turns] of [['24',284,2], ['26',321,5]]) {
    const input = snapshot(code);
    const { result } = buildMetroRoute(code, input);
    assert.equal(result.status, 'partially_resolved');
    assert.equal(result.geometry.coordinates.length, count);
    assert.equal(result.roadRoute.review.checks.filter(p => p.kind === 'turn').length, turns);
    assert.deepEqual(result.roadRoute.review.checks[0].coordinates, result.geometry.coordinates[0][0]);
    assert.deepEqual(result.roadRoute.review.checks.at(-1).coordinates, result.geometry.coordinates.at(-1).at(-1));
    assert.deepEqual(result.roadRoute.review.codes, code === '26' ? [{code:'ALT1',count:2},{code:'C412',count:134}] : []);
    input.features.splice(1,1);
    assert.throws(() => buildMetroRoute(code, input), /disconnected/);
  }
  assert.throws(() => buildMetroRoute('26', snapshot('24')), /review snapshot/);
});

test('partial metropolitan routes are searchable and listed without creating a historical route job', async () => {
  const store = createStore(':memory:');
  const job = store.request('Metropolitan Route 24', 'road_route');
  const { result } = buildMetroRoute('24', snapshot('24'));
  const feature = store.saveFeature(job, { ...result, evidence: [] });
  store.updateJob(job.id, result.status, 'completed', 'Reviewed', feature.id);
  const server = createApp(store).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const root = `http://127.0.0.1:${server.address().port}/api`;
    const search = query => fetch(`${root}/search`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ query, type:'road_route' }) });
    const match = await search('State Route 24');
    assert.equal(match.status, 200);
    assert.equal((await match.json()).feature.id, feature.id);
    const catalogue = await (await fetch(`${root}/catalogue?status=partially_resolved`)).json();
    assert.equal(catalogue[0].id, feature.id);
    const historical=await (await search('National Route 1')).json();
    assert.equal(historical.routeSearch.offer,null);
    assert.deepEqual(historical.routeSearch.matches,[]);
    assert.equal(store.jobs().length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
