import { createStore } from '../server/store.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildRoadRoute, importRoadRoute, routeSource } from '../server/road-routes.js';

if (!process.argv.includes('--approve-source')) throw Error('Review the Vicmap CC BY 4.0 source before using --approve-source.');
const imports = [];
const boundaryData = readFileSync(new URL('../public/victoria.geojson', import.meta.url));
const boundary = JSON.parse(boundaryData);
const boundaryChecksum = createHash('sha256').update(boundaryData).digest('hex');
for (const code of ['M1', 'A1']) {
  const snapshot = await importRoadRoute(code);
  snapshot.metadata.boundaryChecksum = boundaryChecksum;
  const { result, records } = buildRoadRoute(code, snapshot, boundary);
  imports.push({ code, snapshot, result, records });
  const { names, ...audit } = result.roadRoute;
  console.log(JSON.stringify({ status: result.status, ...audit, excluded: snapshot.records.length - records.length }));
}
if (process.argv.includes('--check-only')) process.exit(0);
const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
try {
  const old = store.sources().find(s => s.type === routeSource.type && s.url === routeSource.url && s.format === routeSource.format);
  if (old?.status === 'rejected') throw Error('The Vicmap route source is rejected.');
  const id = old?.id || store.addSource(routeSource);
  if (old?.status !== 'approved') store.decideSource(id, 'approved', routeSource);
  for (const { code, snapshot, result, records } of imports) {
    const job = store.request(code, 'road_route');
    store.setProcessingPolicy(job.id, { allowResearch: false });
    const importId = store.addImport(id, job.id, snapshot.checksum, { type: 'FeatureCollection', features: snapshot.records }, snapshot.metadata);
    const evidence = records.map(record => ({
      sourceId: id, sourceName: routeSource.name, sourceUrl: 'https://discover.data.vic.gov.au/en_AU/dataset/vicmap-transport-road-line',
      licence: routeSource.licence, attribution: routeSource.attribution, sourceVersion: snapshot.metadata.retrievedAt,
      objectId: record.id, pfi: record.properties.pfi, importId, checksum: snapshot.checksum, role: 'route_segment'
    }));
    const feature = store.saveFeature(job, { ...result, evidence });
    store.updateJob(job.id, result.status, 'completed', 'Victorian Vicmap route snapshot saved.', feature.id);
  }
} finally { store.close(); }
