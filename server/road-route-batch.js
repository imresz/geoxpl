import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildRoadRoute, importRoadRoute, routeSource, routeCode, routeJobName } from './road-routes.js';

const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const vicmapPage = 'https://discover.data.vic.gov.au/dataset/vicmap-transport-road-line';
const dtpPage = 'https://opendata.transport.vic.gov.au/dataset/dtp-managed-roads/resource/7085bd59-9bed-4284-b226-703e3cfe3404';
const dtpSource = {
  ...routeSource, url: dtpPage, name: 'DTP Managed Roads (SRNS)', format: 'dtp-managed-road-snapshot',
  version: '2026-03-10', nameField: 'SRNS', idField: 'OBJECTID',
  attribution: 'State of Victoria, Department of Transport and Planning (DTP Managed Roads)',
  notes: 'Audited SRNS-tagged segments from the published 2026-03-10 WGS84 snapshot; junction IDs are unavailable.'
};
let inventory, dtpRecords;
export const routeInventory = () => inventory ??= JSON.parse(readFileSync(new URL('./data/victorian-route-coverage.json', import.meta.url)));
export function batchRouteEntry(query) {
  const code = routeCode(query);
  if (!code || !Object.hasOwn(routeInventory().codes, code)) return null;
  return { code, query: routeJobName(code), ...routeInventory().codes[code] };
}

export function registerRouteBatchSources(store) {
  const configured = [routeSource, dtpSource].map(definition => [
    definition, store.sources().find(s => s.type === definition.type && s.format === definition.format && s.url === definition.url)
  ]);
  if (configured.some(([,s]) => s?.status === 'rejected')) throw Error('A road route source is rejected. Review its status before enqueueing.');
  for (const [definition, existing] of configured) {
    if (existing?.status !== 'approved') store.decideSource(existing?.id || store.addSource(definition), 'approved', definition);
  }
}

function dtpSnapshot(code, expected) {
  const audit = routeInventory();
  dtpRecords ??= JSON.parse(gunzipSync(readFileSync(new URL('./data/victorian-dtp-only-routes.json.gz', import.meta.url))));
  const input = dtpRecords[code];
  const ids = new Set();
  if (!Array.isArray(input) || input.length !== expected) throw Error('DTP snapshot does not match the coverage audit.');
  const records = input.map(f => {
    const p = f.properties, id = p?.OBJECTID;
    if (!Number.isSafeInteger(id) || ids.has(id) || p.SRNS.trim().toUpperCase() !== code) throw Error('Invalid DTP route record.');
    ids.add(id);
    return { ...f, id: String(id), properties: { ...p, ezi_road_name_label: [p.RD_NAME?.trim(),p.RD_TYPE?.trim()].filter(Boolean).join(' ') } };
  });
  return { records, checksum: digest(input),
    metadata: { adapter: 'dtp-srns-snapshot/1', retrievedAt: audit.audited, edition: audit.dtpEdition, originalChecksum: audit.dtpSha256 } };
}

export async function runRoadRouteJob(store, job, { boundary, routeLoader } = {}) {
  const entry = batchRouteEntry(job.query);
  if (!entry) return store.updateJob(job.id, 'insufficient_data', 'awaiting_data', 'This route is not part of the audited batch.');
  const existing = store.jobFeatures(job.id)[0];
  if (existing) return store.updateJob(job.id, existing.status, 'completed', 'Saved road route retained.', existing.id);
  const { code, vicmap, dtp } = entry;
  const definition = vicmap ? routeSource : dtpSource;
  const approved = () => store.sources().find(s => s.status === 'approved' && s.format === definition.format && s.type === definition.type &&
    s.url === definition.url && s.nameField === definition.nameField && s.idField === definition.idField && s.licence?.trim() && s.attribution?.trim());
  const source = approved();
  if (!source) return store.updateJob(job.id, 'source_unavailable', 'awaiting_data', 'An approved route source with licence and attribution is required.');
  store.updateJob(job.id, 'pending', 'importing', `Reading ${source.name} for ${code}`);
  const snapshot = vicmap ? await importRoadRoute(code, routeLoader) : dtpSnapshot(code, dtp);
  if (approved()?.id !== source.id) throw Error('Road route source approval changed during import.');
  snapshot.metadata = { ...snapshot.metadata, boundaryChecksum: digest(boundary), coverageAudit: entry };
  let built;
  try { built = buildRoadRoute(code, snapshot, boundary); }
  catch (error) {
    if (error.code === 'NO_VICTORIAN_ROUTE_SEGMENTS') {
      return store.updateJob(job.id, 'no_match', 'awaiting_data', 'No tagged records passed the Victorian boundary check. No alignment was published.');
    }
    throw error;
  }
  const { records, result } = built;
  if (!vicmap) {
    result.status = 'partially_resolved';
    result.method = 'dtp_exact_srns_code';
    result.roadRoute.topologyUnavailable = true;
    result.warnings[0] = 'DTP publishes these segments without network junction IDs. Continuity and missing links could not be verified.';
  }
  if (!dtp || !vicmap) {
    result.status = 'partially_resolved';
    result.warnings.push('This code was found in only one audited source. Full route coverage is unverified.');
  }
  if (/^\d/.test(code)) {
    result.displayName = `Numbered Route ${code} (Vicmap)`;
    result.warnings.push('Vicmap publishes this numeric code. Its current signing and numbering scheme are unverified.');
  }
  if (snapshot.records.length !== records.length) {
    result.status = 'partially_resolved';
    result.warnings.push('Some source segments were omitted by the Victorian boundary check; continuity at the state border is unverified.');
  }
  const importId = store.addImport(source.id, job.id, snapshot.checksum, { type: 'FeatureCollection', features: snapshot.records }, snapshot.metadata);
  const evidence = records.map(record => ({
    sourceId: source.id, sourceName: source.name, sourceUrl: vicmap ? vicmapPage : dtpPage,
    licence: source.licence, attribution: source.attribution, sourceVersion: snapshot.metadata.edition || snapshot.metadata.retrievedAt,
    objectId: record.id, pfi: record.properties.pfi, importId, checksum: snapshot.checksum, role: 'route_segment'
  }));
  const feature = store.saveFeature(job, { ...result, evidence });
  store.updateJob(job.id, result.status, 'completed',
    result.status === 'resolved' ? 'Tagged Victorian segments form one connected group.' : 'Tagged Victorian segments saved; full continuity or coverage is unverified.', feature.id);
}
