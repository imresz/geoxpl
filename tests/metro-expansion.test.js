import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMetroRoute, metroMapsSource } from '../server/metro-routes.js';
import { metroExpansion } from '../server/metro-expansion.js';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { isProvenancePilot } from '../server/provenance.js';

const reviewed = code => buildMetroRoute(code, JSON.parse(readFileSync(new URL(`../scripts/data/metropolitan-route-${code}-review.geojson`, import.meta.url)))).result;

test('five documented corridors are connected but not promoted to verified signing', () => {
  assert.equal(metroMapsSource.format, 'reference-document');
  for (const [code, segments] of Object.entries({4:128,14:245,17:241,19:246,21:183})) {
    const result = reviewed(code);
    assert.equal(result.roadRoute.segments, segments);
    assert.equal(result.status, 'partially_resolved');
    assert.equal(result.roadRoute.review.checks.length, metroExpansion[code].names.length + 1);
    assert.ok(isProvenancePilot({ ...result, name:code, type:'road_route' }));
  }
});

test('metropolitan route queries never substitute the same bare Vicmap tag', async () => {
  const store = createStore(':memory:');
  const metro = store.request('Metropolitan Route 21','road_route');
  const numbered = store.request('Numbered Route 21','road_route');
  const unreviewed = store.request('Numbered Route 22','road_route');
  for (const [job,result] of [[metro,reviewed('21')],[numbered,{status:'partially_resolved'}]]) {
    const feature = store.saveFeature(job,{...result,evidence:[]});
    store.updateJob(job.id,'partially_resolved','completed','Ready',feature.id);
  }
  store.updateJob(unreviewed.id,'no_match','awaiting_data','No geometry');
  const server = createApp(store).listen(0,'127.0.0.1');
  try {
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
    const search = query => fetch(`http://127.0.0.1:${server.address().port}/api/search`,{
      method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({query,type:'road_route'})
    });
    for(const query of ['State Route 21','Metropolitan Route 21','Route 21','21']) assert.equal((await (await search(query)).json()).id,metro.id);
    assert.equal((await (await search('Numbered Route 21')).json()).id,numbered.id);
    assert.equal((await search('Metropolitan Route 22')).status,404);
  } finally {
    await new Promise(resolve=>server.close(resolve)); store.close();
  }
});
