import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { enqueueBatch } from '../server/batches.js';
import { batchRouteEntry, registerRouteBatchSources, routeInventory } from '../server/road-route-batch.js';

const boundary = JSON.parse(readFileSync(new URL('../public/victoria.geojson', import.meta.url)));
const manifest = (...queries) => ({id:'vic-road-test',name:'Road route test',selectionNote:'Test audit entries only.',
  entries:queries.map(query=>({query,type:'road_route'}))});

test('audited inventory keeps 423 shared codes, 76 single-source alphanumeric codes and 7 numeric codes', () => {
  const rows = Object.entries(routeInventory().codes);
  assert.equal(rows.length,506);
  assert.equal(rows.filter(([,row])=>row.vicmap&&row.dtp).length,423);
  assert.equal(rows.filter(([code])=>/^\d/.test(code)).length,7);
  for (const value of ['0','National Route 1','ALT1','A8-B5','D140','N','24','26']) assert.equal(batchRouteEntry(value),null);
  assert.equal(batchRouteEntry('State Route 14').query,'Numbered Route 14');
  assert.equal(batchRouteEntry('route c 124').query,'C124');
});

test('DTP-only imports remain partial and recovery after saving does not duplicate a revision', async () => {
  const store=createStore(':memory:');
  const options={boundary,routeLoader:()=>{throw Error('DTP snapshot must not download Vicmap');},researcher:()=>{throw Error('No AI');}};
  let worker;
  try {
    registerRouteBatchSources(store);
    assert.throws(()=>enqueueBatch(store,manifest('State Route 14')));
    const initial=enqueueBatch(store,manifest('M4'));
    assert.equal(initial.batch.counts.queued,1);
    assert.equal(enqueueBatch(store,manifest('M4')).created,false);
    worker=createWorker(store,options);
    await worker.tick();
    const job=store.jobs()[0], feature=store.feature(job.feature_id);
    assert.equal(job.status,'partially_resolved');
    assert.equal(feature.roadRoute.topologyUnavailable,true);
    assert.match(feature.evidence[0].sourceName,/DTP Managed Roads/);
    assert.equal(store.featureRevisions(feature.id).length,1);
    worker.stop();
    store.updateJob(job.id,'pending','importing','Interrupted after geometry saved');
    worker=createWorker(store,options);
    assert.equal(store.getJob(job.id).phase,'queued');
    await worker.tick();
    assert.equal(store.getJob(job.id).status,'partially_resolved');
    assert.equal(store.featureRevisions(feature.id).length,1);
    assert.equal(store.reports().length,0);
  } finally { worker?.stop();store.close(); }
});

test('shared-code roads with inconsistent endpoint positions are marked partial', async () => {
  const store=createStore(':memory:');
  const road=(pfi,from_ufi,to_ufi,x)=>({id:`tr_road.${pfi}`,properties:{pfi,from_ufi,to_ufi,route_no:'C124'},
    geometry:{type:'LineString',coordinates:[[x,-37.6],[x+.001,-37.6]]}});
  const features=[road(1,1,2,145),road(2,2,3,145.02)];
  const worker=createWorker(store,{boundary,routeLoader:async()=>({type:'FeatureCollection',numberMatched:2,numberReturned:2,features,
    crs:{properties:{name:'EPSG:4326'}}})});
  try {
    registerRouteBatchSources(store);
    enqueueBatch(store,manifest('C124'));
    await worker.tick();
    assert.equal(store.features()[0].status,'partially_resolved');
    assert.match(store.features()[0].warnings.join(' '),/shared junction IDs/);
  } finally {worker.stop();store.close();}
});

test('numeric tags outside Victoria settle as no-match without publishing geometry', async () => {
  const store=createStore(':memory:');
  const geometry={type:'LineString',coordinates:[[147.3,-35.1],[147.31,-35.1]]};
  const worker=createWorker(store,{boundary,routeLoader:async()=>({
    type:'FeatureCollection',numberMatched:1,numberReturned:1,crs:{properties:{name:'EPSG:4326'}},
    features:[{id:'tr_road.123',geometry,properties:{pfi:123,from_ufi:1,to_ufi:2,route_no:'14'}}]
  })});
  try {
    registerRouteBatchSources(store);
    enqueueBatch(store,manifest('Numbered Route 14'));
    await worker.tick();
    assert.equal(store.jobs()[0].status,'no_match');
    assert.equal(store.features().length,0);
  } finally {worker.stop();store.close();}
});
