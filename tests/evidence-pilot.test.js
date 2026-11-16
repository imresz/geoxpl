import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMetroRoute } from '../server/metro-routes.js';
import { isProvenancePilot, mappingLineage } from '../server/provenance.js';
import { drainageFingerprint, eligibleValleyDrainage } from '../server/valley-floor.js';

test('Route 24 exposes independent dated observations separately from mapped records', () => {
  const data = JSON.parse(readFileSync(new URL('../scripts/data/metropolitan-route-24-review.geojson',import.meta.url)));
  const { result } = buildMetroRoute('24',data);
  const route = {...result,type:'road_route',name:'Metropolitan Route 24',evidence:[]};
  assert.ok(isProvenancePilot(route));
  const lineage = mappingLineage(route);
  assert.equal(lineage.status,'partially_resolved');
  assert.equal(lineage.routeReview.publicObservations.length,1);
  assert.match(lineage.routeReview.publicObservations[0].limit,/does not establish the complete alignment/);
  assert.equal(lineage.routeSegments,284);
  assert.deepEqual(lineage.evidence,[]);
});

test('Yarra Valley lineage labels older floor results and the current terrain scale separately', () => {
  const extentEstimate = { kind:'terrain_valley', label:'Estimated valley extent' };
  const valley = { name:'Yarra Valley',type:'valley', extentEstimate, areaKm2:436, valleyFloor:{areaKm2:128},
    terrain:{sensitivity:{intersectionOverUnion:.76,scalesMetres:[750,1000,1250],areaKm2:[420,436,450]}} };
  assert.ok(isProvenancePilot(valley));
  assert.equal(mappingLineage(valley).floorAreaKm2,128);
  assert.equal(mappingLineage(valley).scaleSensitivity.intersectionOverUnion,.76);
  assert.equal(mappingLineage({...valley,terrain:undefined}).scaleSensitivity,undefined);
});

test('partial river reaches require an exact review fingerprint and published Geofabric evidence', () => {
  const river={id:'river',type:'river',status:'partially_resolved',method:'geofabric_directed_main_stem',
    geometry:{type:'LineString',coordinates:[[144,-37],[145,-37]]},evidence:[{role:'route_segment'}]};
  const definition={drainageFeatureId:river.id};
  assert.equal(eligibleValleyDrainage(definition,river),false);
  definition.reviewedPartialDrainageChecksum=drainageFingerprint(river);
  assert.equal(eligibleValleyDrainage(definition,river),true);
  assert.equal(eligibleValleyDrainage(definition,{...river,geometry:{...river.geometry,coordinates:[[144,-37],[146,-37]]}}),false);
  assert.equal(eligibleValleyDrainage(definition,{...river,method:'estimated',evidence:[]}),false);
});
