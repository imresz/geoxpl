import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createStore } from '../server/store.js';
import { route24PublicObservations } from '../server/metro-routes.js';
import { drainageFingerprint, processValleyFloor } from '../server/valley-floor.js';

const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
try {
  const jobs = store.jobs();
  const routeJob = jobs.find(j => j.type === 'road_route' && j.normalized === 'metropolitan route 24' && !j.superseded_by);
  const route = routeJob && store.feature(routeJob.feature_id);
  if (!route?.roadRoute?.review || route.status !== 'partially_resolved') throw Error('The reviewed Route 24 candidate must already exist.');

  const valley = jobs.find(j => j.type === 'valley' && j.normalized === 'yarra valley' && !j.superseded_by);
  if (!valley) throw Error('The reviewed Yarra Valley request is missing.');
  const settings = store.featureSettings(valley.id);
  if (!settings.valleyFloor || !settings.terrain) throw Error('The reviewed floor and terrain settings are required.');
  const drainage = store.feature(settings.valleyFloor.drainageFeatureId);
  if (!drainage || drainage.name.toLowerCase() !== 'yarra river') throw Error('The reviewed Yarra River is not available.');
  const revised = { ...settings, valleyFloor: { ...settings.valleyFloor, reviewedPartialDrainageChecksum: drainageFingerprint(drainage) } };
  const source = store.sources().find(s => s.id === settings.valleyFloor.sourceId);
  const archive = store.db.prepare('SELECT * FROM imports WHERE job_id=? AND source_id=? ORDER BY created DESC, rowid DESC LIMIT 1').get(valley.id, source?.id ?? '');
  if (!archive || !source) throw Error('The reviewed landform snapshot is missing.');
  const boundary = JSON.parse(readFileSync(new URL('../public/victoria.geojson', import.meta.url)));
  const floor = processValleyFloor({ ...archive, source, metadata: JSON.parse(archive.metadata), payload: JSON.parse(archive.payload) }, boundary, revised, drainage);
  if (!floor.result) throw Error(`Mapped river reaches did not validate the reviewed floor: ${floor.error}`);
  console.log(`Reviewed landforms still intersect mapped Yarra River reaches: ${floor.result.areaKm2.toFixed(1)} km2 floor.`);
  if (!process.argv.includes('--apply')) {
    console.log('Validation only; no changes saved.');
  } else {
    if (!isDeepStrictEqual(route.roadRoute.review.publicObservations, route24PublicObservations)) {
      const review = { ...route.roadRoute.review, publicObservations: route24PublicObservations };
      const saved = store.saveFeature(routeJob, { ...route, roadRoute: { ...route.roadRoute, review } });
      store.updateJob(routeJob.id, saved.status, 'completed', 'Vicmap candidate alignment; independent sign observations added for Glen Iris.', saved.id);
    }
    const matches = store.jobFeatures(valley.id);
    if (!isDeepStrictEqual(settings, revised) || !matches.some(f => f.extentEstimate?.kind === 'terrain_valley')) {
      store.setFeatureSettings(valley.id, revised);
      store.setProcessingPolicy(valley.id, { allowResearch: false });
      store.setting(`research:${valley.id}`, 'false');
      store.retry(valley.id);
      console.log(`Terrain refresh queued for ${valley.id}.`);
    }
  }
} finally { store.close(); }
