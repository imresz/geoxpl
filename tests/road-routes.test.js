import test from 'node:test';
import assert from 'node:assert/strict';
import { importRoadRoute, buildRoadRoute, pilotRouteCode } from '../server/road-routes.js';

const boundary = { type:'Feature', properties:{}, geometry:{ type:'Polygon', coordinates:[[[141,-39],[149,-39],[149,-34],[141,-34],[141,-39]]] } };
const road = (pfi, from_ufi, to_ufi, a, b) => ({
  id: `tr_road.${pfi}`, properties:{ pfi, from_ufi, to_ufi, route_no:'M1', ezi_road_name_label:'Example Freeway' },
  geometry:{ type:'LineString', coordinates:[a,b] }
});
const page = features => ({ type:'FeatureCollection', numberMatched:features.length, numberReturned:features.length, crs:{ properties:{ name:'EPSG:4326' } }, features });

test('only exact current pilot codes are accepted', () => {
  assert.equal(pilotRouteCode(' Route m 1 '), 'M1');
  assert.equal(pilotRouteCode('A1'), 'A1');
  assert.equal(pilotRouteCode('National Route 1'), null);
  assert.equal(pilotRouteCode('Route 1'), null);
});

test('continuity uses junction IDs, excludes out-of-state lines and does not bridge breaks', async () => {
  const a=road(1,1,2,[144,-37],[145,-37]), b=road(2,2,3,[145,-37],[146,-37]);
  const c=road(3,4,5,[146,-37],[147,-37]), outside=road(4,5,6,[148,-37],[150,-37]);
  const snapshot=await importRoadRoute('M1', async () => page([a,b,c,outside]));
  const { records, result }=buildRoadRoute('M1', snapshot, boundary);
  assert.equal(result.status,'partially_resolved');
  assert.equal(result.roadRoute.components,2);
  assert.equal(result.roadRoute.largestComponent,2);
  assert.deepEqual(result.geometry.coordinates,[a,b,c].map(f=>f.geometry.coordinates));
  assert.deepEqual(records,[a,b,c]);
  assert.equal(buildRoadRoute('M1', {...snapshot,records:[a,b]}, boundary).result.status,'resolved');
  await assert.rejects(importRoadRoute('A1',async()=>page([a])), /Unexpected/);
  await assert.rejects(importRoadRoute('M1',async()=>page([a,a])), /duplicate/);
});
