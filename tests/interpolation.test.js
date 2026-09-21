import test from 'node:test';
import assert from 'node:assert/strict';
import { withInterpolations, estimatedConnectionsSchema } from '../server/interpolation.js';
import { processGeometry } from '../server/processors.js';
import { createStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { createApp } from '../server/app.js';

const base = geometry => ({ geometry, bbox: [1,1,2,2], status: 'partially_resolved', confidence: 'review_required', warnings: [], lengthKm: 100, areaKm2: null, source: null, mouth: null });
const line = coordinates => ({ type: 'LineString', coordinates });
const geometry = { type: 'MultiLineString', coordinates: [[[1,1],[2,2]],[[2.001,2],[3,3]]] };
const anchor = { coordinates: [[1,1],[0.99,1]], label: 'Possible source connection', evidenceUrl: 'https://example.org/evidence', evidenceRecord: 'record-123' };

test('gaps get a separate dotted-overlay contract without changing recorded geometry or length', () => {
  const original = base(geometry), result = withInterpolations(original, {id:'snapshot'});
  assert.equal(result.interpolations.features.length,1);
  const gap = result.interpolations.features[0];
  assert.deepEqual(gap.geometry.coordinates,[[2,2],[2.001,2]]);
  assert.equal(gap.properties.certainty,'unverified');
  assert.equal(gap.properties.method,'straight_line_interpolation');
  assert.equal(gap.properties.importId,'snapshot');
  assert.deepEqual(result.geometry,original.geometry);
  assert.equal(result.lengthKm,100); assert.equal(result.status,'partially_resolved');
  assert.deepEqual(result.bbox,original.bbox); assert.deepEqual(result.displayBbox,[1,1,3,3]);
  assert.equal(original.interpolations,undefined);
});

test('connected features have no estimated connections, including interior vertex junctions', () => {
  for(const g of [line([[1,1],[2,2],[3,3]]),{type:'MultiLineString',coordinates:[[[1,1],[2,2],[3,3]],[[2,2],[2,3]]]}]) {
    const result=withInterpolations({...base(g),status:'resolved'});
    assert.equal(result.interpolations.features.length,0); assert.equal(result.status,'resolved');
  }
});

test('automatic gap filling is bounded, deterministic and cannot create a cycle', () => {
  const g={type:'MultiLineString',coordinates:[[[1,1],[1.01,1]],[[1.011,1],[1.02,1]],[[1.021,1],[1.03,1]]]};
  const a=withInterpolations(base(g)),b=withInterpolations(base({...g,coordinates:[...g.coordinates].reverse().map(c=>[...c].reverse())}));
  assert.equal(a.interpolations.features.length,2);
  const keys=r=>r.interpolations.features.map(f=>f.geometry.coordinates.map(JSON.stringify).sort().join(':')).sort();
  assert.deepEqual(keys(a),keys(b));
  const distant=withInterpolations(base({type:'MultiLineString',coordinates:[[[1,1],[2,2]],[[8,8],[9,9]]]}));
  assert.equal(distant.interpolations.features.length,0); assert.match(distant.interpolationSummary.notes.join(' '),/5 km/);
});

test('all located upstream alternatives are dotted, with none promoted to a verified headwater', () => {
  const original={...base(line([[1,1],[2,2]])),mainStem:{namedStart:{nodeId:4,coordinates:[1,1]}}};
  const item={id:'import',metadata:{geofabric:{nodesUrl:'https://example.org/3',headwaterContexts:[{nodeId:4,incoming:[{properties:{hydroid:11,from_node:1,to_node:4}},{properties:{hydroid:12,from_node:2,to_node:4}}]}],upstreamNodes:[{properties:{hydroid:1},geometry:{type:'Point',coordinates:[0.99,1]}},{properties:{hydroid:2},geometry:{type:'Point',coordinates:[1,0.99]}}]}}};
  const result=withInterpolations(original,item);
  assert.equal(result.interpolations.features.length,2); assert.equal(result.source,null);
  assert.ok(result.interpolations.features.every(f=>f.properties.alternativeGroup==='headwater-4'));
  assert.deepEqual(result.interpolations.features.map(f=>f.properties.hydroId),[11,12]);
  assert.equal(result.lengthKm,original.lengthKm); assert.deepEqual(result.geometry,original.geometry);
});

test('evidence-located anchors work for lines and polygon features without inventing area', () => {
  const polygon={type:'Polygon',coordinates:[[[1,1],[2,1],[2,2],[1,2],[1,1]]]};
  for(const g of [line([[1,1],[2,2]]),polygon]) {
    const original={...base(g),status:'resolved',areaKm2:20};
    const result=withInterpolations(original,null,{estimatedConnections:[anchor]});
    assert.equal(result.interpolations.features.length,1); assert.equal(result.status,'partially_resolved');
    assert.equal(result.areaKm2,20); assert.equal(result.lengthKm,100);
    assert.equal(result.interpolations.features[0].properties.evidenceRecord,'record-123');
    assert.equal(result.displayBbox[0],0.99);
  }
  const disconnectedAreas={type:'MultiPolygon',coordinates:[polygon.coordinates,[[[4,4],[5,4],[5,5],[4,4]]]]};
  assert.equal(withInterpolations(base(disconnectedAreas)).interpolations.features.length,0);
});

test('stale anchors, duplicate lines and invalid coordinates cannot silently create estimates', () => {
  const result=withInterpolations(base(line([[1,1],[2,2]])),null,{estimatedConnections:[anchor,anchor,{...anchor,label:'Stale',coordinates:[[20,20],[21,21]]}]});
  assert.equal(result.interpolations.features.length,1); assert.match(result.interpolationSummary.notes[0],/no longer matches/);
  assert.equal(estimatedConnectionsSchema.safeParse([{...anchor,coordinates:[[181,1],[1,1]]}]).success,false);
  assert.equal(estimatedConnectionsSchema.safeParse([{...anchor,evidenceUrl:'http://example.org'}]).success,false);
});

const source={name:'Test',type:'river',format:'geojson',url:'https://example.org/data',nameField:'name',idField:'id',licence:'Test',attribution:'Test',version:'1',completeness:'complete',aliases:[],notes:''};
const item={id:'import',source:{...source,id:'test'},metadata:{},checksum:'test',payload:{type:'FeatureCollection',features:geometry.coordinates.map((coordinates,id)=>({type:'Feature',properties:{name:'Test river',id},geometry:line(coordinates)}))}};
const boundary={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}};

test('processor and worker retain estimates without requesting repetitive research', async () => {
  const result=processGeometry({query:'Test river',type:'river'},[item],boundary).result;
  assert.equal(result.interpolations.features.length,1);
  const store=createStore(':memory:');
  try {
    const id=store.addSource(source);store.decideSource(id,'approved',source);
    const job=store.request('Test river','river');
    const worker=createWorker(store,{boundary,importer:async()=>item,researcher:async()=>assert.fail('Unexpected AI request')});worker.stop();
    await worker.run(job);
    assert.equal(store.getJob(job.id).phase,'awaiting_data');
    assert.equal(store.getJob(job.id).status,'partially_resolved');
    assert.match(store.getJob(job.id).message,/dotted/);
    assert.equal(store.reports().length,0);
  }finally{store.close();}
});

test('authenticated feature settings validate and preserve reviewed anchors on an ordinary settings save', async () => {
  const store=createStore(':memory:'),app=createApp(store),server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,cookie,method='POST')=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  try {
    const setup=await request('/api/admin/setup',{password:'test-password-12345'});
    const cookie=setup.headers.get('set-cookie').split(';')[0];
    const job=store.request('Test river','river');store.updateJob(job.id,'partially_resolved','awaiting_data','Test');
    const path=`/api/admin/jobs/${job.id}/settings`;
    const settings={aliases:[],preferredSourceId:null,estimatedConnections:[anchor]};
    assert.equal((await request(path,settings,null,'PATCH')).status,401);
    assert.equal((await request(path,{...settings,estimatedConnections:[{...anchor,evidenceUrl:'javascript:alert(1)'}]},cookie,'PATCH')).status,400);
    assert.equal((await request(path,settings,cookie,'PATCH')).status,200);
    store.updateJob(job.id,'partially_resolved','awaiting_data','Test');
    assert.equal((await request(path,{aliases:[],preferredSourceId:null},cookie,'PATCH')).status,200);
    assert.deepEqual(store.featureSettings(job.id).estimatedConnections,[anchor]);
    assert.equal((await request(path,{aliases:['Alternate'],preferredSourceId:null},cookie,'PATCH')).status,200);
    assert.equal(store.featureSettings(job.id).estimatedConnections,undefined);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
