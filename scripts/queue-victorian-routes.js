import { createStore } from '../server/store.js';
import { enqueueBatch } from '../server/batches.js';
import { batchRouteEntry, registerRouteBatchSources, routeInventory } from '../server/road-route-batch.js';

if (!process.argv.includes('--approve-sources')) throw Error('Review the audited Vicmap and DTP sources before using --approve-sources.');
const audit = routeInventory();
const entries = Object.keys(audit.codes).map(batchRouteEntry).sort((a,b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
const groups = [
  ['shared', 'Vicmap and DTP', entries.filter(e => e.vicmap && e.dtp)],
  ['single', 'single-source and numeric', entries.filter(e => !e.vicmap || !e.dtp)]
];
const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
try {
  registerRouteBatchSources(store);
  for (const [key, title, routes] of groups) {
    for (let offset = 0; offset < routes.length; offset += 100) {
      const part = offset / 100 + 1;
      const created = enqueueBatch(store, {
        id: `victoria-road-routes-${audit.audited}-${key}-${part}`,
        name: `Victorian road routes: ${title} (${part})`,
        selectionNote: 'Exact published codes from the November 2026 coverage audit. Shared code presence does not verify agreement on alignment. Single-source or discontinuous routes remain partially resolved. Numeric tags are not assumed to establish a numbering scheme.',
        references: [
          { title:'Vicmap Transport Road Line', url:'https://discover.data.vic.gov.au/dataset/vicmap-transport-road-line' },
          { title:'DTP Managed Roads (March 2026 snapshot)', url:'https://opendata.transport.vic.gov.au/dataset/dtp-managed-roads/resource/7085bd59-9bed-4284-b226-703e3cfe3404' }
        ],
        entries: routes.slice(offset, offset + 100).map(e => ({ query:e.query, type:'road_route' }))
      });
      const { id, total, counts } = created.batch;
      console.log(JSON.stringify({ id, created:created.created, total, counts }));
    }
  }
  if (process.argv.includes('--retry-failed')) {
    const jobs = store.jobs().filter(j => j.type === 'road_route' && !j.superseded_by &&
      ['failed','source_unavailable'].includes(j.status) && batchRouteEntry(j.query) && !store.jobFeatures(j.id).length);
    for (const j of jobs) store.retry(j.id);
    console.log(`Requeued ${jobs.length} failed or source-unavailable route imports.`);
  }
} finally { store.close(); }
