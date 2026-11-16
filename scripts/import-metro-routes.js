import { readFileSync } from 'node:fs';
import { createStore } from '../server/store.js';
import { buildMetroRoute, metroSource } from '../server/metro-routes.js';

if (!process.argv.includes('--approve-source')) throw Error('Review the Vicmap CC BY 4.0 source before using --approve-source.');
const imports = ['24', '26'].map(code => {
  const snapshot = JSON.parse(readFileSync(new URL(`./data/metropolitan-route-${code}-review.geojson`, import.meta.url)));
  return { code, snapshot, ...buildMetroRoute(code, snapshot) };
});
const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
try {
  const existing = store.sources().find(s => s.type === metroSource.type && s.url === metroSource.url && s.format === metroSource.format);
  if (existing?.status === 'rejected') throw Error('The Vicmap metropolitan route review source is rejected.');
  const sourceId = existing?.id || store.addSource(metroSource);
  if (existing?.status !== 'approved') store.decideSource(sourceId, 'approved', metroSource);
  for (const { code, snapshot, result, checksum } of imports) {
    const job = store.request(`Metropolitan Route ${code}`, 'road_route');
    store.setProcessingPolicy(job.id, { allowResearch: false });
    const current = store.jobFeatures(job.id)[0];
    if (current?.algorithmVersion === result.algorithmVersion && current.evidence[0]?.checksum === checksum &&
        job.feature_id === current.id && job.status === result.status) {
      console.log(`${current.displayName}: already imported`);
      continue;
    }
    const importId = store.addImport(sourceId, job.id, checksum, snapshot, {
      adapter: result.algorithmVersion, retrievedAt: snapshot.audit.retrievedAt,
      requests: snapshot.audit.requests, baseline: result.roadRoute.review.baseline
    });
    const evidence = snapshot.features.map(record => ({
      sourceId, sourceName: metroSource.name, sourceUrl: 'https://discover.data.vic.gov.au/dataset/vicmap-transport-road-line',
      licence: metroSource.licence, attribution: metroSource.attribution, sourceVersion: snapshot.audit.retrievedAt,
      objectId: record.id, pfi: record.properties.pfi, importId, checksum, role: 'candidate_route_segment'
    }));
    const feature = store.saveFeature(job, { ...result, evidence });
    store.updateJob(job.id, result.status, 'completed', '2015 corridor matched to Vicmap; current signing remains unverified.', feature.id);
    console.log(`${feature.displayName}: ${evidence.length} segments, ${feature.status}`);
  }
} finally { store.close(); }
