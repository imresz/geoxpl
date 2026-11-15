import { createHash } from 'node:crypto';
import { bbox, booleanPointInPolygon, length, multiLineString } from '@turf/turf';
import { publicJson } from './network.js';
import { normalize, now } from './store.js';

export const routeSource = {
  name: 'Vicmap Transport Road Line', type: 'road_route', format: 'vic-road-route',
  url: 'https://opendata.maps.vic.gov.au/geoserver/wfs', nameField: 'route_no', idField: 'pfi',
  licence: 'CC BY 4.0', attribution: 'State of Victoria, Department of Transport and Planning (Vicmap Transport)',
  version: 'TR_ROAD snapshot', completeness: 'partial', aliases: [],
  notes: 'Victorian road records carrying an exact current route code. Not historical alignments or driving directions.'
};

export function pilotRouteCode(query) {
  return /^(?:route )?([ma]) ?1$/.exec(normalize(query))?.[1].toUpperCase().concat('1') ?? null;
}

export async function importRoadRoute(code, load = publicJson) {
  if (!['M1', 'A1'].includes(code)) throw Error('Unsupported pilot route.');
  const records = [], requests = [], ids = new Set(), pfis = new Set();
  let expected;
  for (let offset = 0; offset === 0 || offset < expected; offset = records.length) {
    const params = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'open-data-platform:tr_road',
      outputFormat: 'application/json', srsName: 'EPSG:4326', count: '500', startIndex: String(offset),
      sortBy: 'pfi A', cql_filter: `route_no='${code}'`
    });
    const url = `${routeSource.url}?${params}`;
    requests.push(url);
    const page = await load(url, 25000000);
    const count = page.numberMatched;
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000 || (expected !== undefined && expected !== count) ||
        page.type !== 'FeatureCollection' || !Array.isArray(page.features) ||
        page.numberReturned !== page.features.length || !page.features.length || page.features.length > 500 ||
        offset + page.features.length > count || !/4326|CRS84/.test(page.crs?.properties?.name || '')) {
      throw Error('Vicmap returned incomplete, inconsistent or non-WGS84 road records.');
    }
    expected = count;
    for (const f of page.features) {
      const p = f.properties;
      if (p?.route_no !== code || typeof f.id !== 'string' || !f.id || ids.has(f.id) ||
          !Number.isSafeInteger(p.pfi) || pfis.has(p.pfi)) throw Error('Unexpected or duplicate route record.');
      ids.add(f.id); pfis.add(p.pfi); records.push(f);
    }
  }
  const checksum = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return { records, checksum, metadata: { retrievedAt: now(), requests, adapter: 'vicmap-road-route/1' } };
}

export function buildRoadRoute(code, snapshot, boundary) {
  const { records, metadata } = snapshot;
  if (!['Polygon', 'MultiPolygon'].includes(boundary?.geometry?.type)) throw Error('Victorian polygon required.');
  const parent = new Map();
  function root(node) {
    if (!parent.has(node)) parent.set(node, node);
    while (parent.get(node) !== node) {
      parent.set(node, parent.get(parent.get(node)));
      node = parent.get(node);
    }
    return node;
  }
  const segments = records.flatMap((record, index) => {
    const { geometry, properties: p } = record;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] :
      geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    if (!lines.length || lines.some(line => line.length < 2 || line.some(coord =>
      !Array.isArray(coord) || coord.length !== 2 || !coord.every(Number.isFinite) ||
      coord[0] < 140 || coord[0] > 151 || coord[1] < -40 || coord[1] > -33))) throw Error('Invalid route geometry.');
    // Omit border-crossing records instead of assigning their full geometry to Victoria.
    if (!lines.every(line => line.every(point => booleanPointInPolygon(point, boundary)))) return [];
    // A multipart record or missing junction cannot establish connectivity.
    const valid = lines.length === 1 && [p.from_ufi, p.to_ufi].every(n => Number.isSafeInteger(n) && n > 0);
    const from = valid ? p.from_ufi : `unknown:${index}`;
    if (valid) parent.set(root(p.to_ufi), root(from));
    return [{ from, lines, valid, record }];
  });
  if (!segments.length) throw Error('No tagged segments within the Victorian boundary.');
  const groups = new Map();
  for (const segment of segments) {
    const key = root(segment.from);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const geometry = multiLineString(segments.flatMap(segment => segment.lines));
  const unverified = segments.filter(segment => !segment.valid).length;
  const connected = groups.size === 1 && !unverified;
  return { records: segments.map(segment => segment.record), result: {
    identityKey: `vicmap:road-route:${code}`, displayName: `${code} (Victoria)`,
    geometry: geometry.geometry, bbox: bbox(geometry), lengthKm: null, areaKm2: null,
    status: connected ? 'resolved' : 'partially_resolved', confidence: 'published_snapshot',
    method: 'vicmap_exact_route_code', algorithmVersion: metadata.adapter,
    warnings: [
      ...connected ? [] : ['The tagged records do not form one verified connected network. No missing links have been inferred.'],
      'Only records whose mapped vertices fall inside the Victorian map boundary are shown. Cross-border records may be omitted at the state line.'
    ],
    roadRoute: { code, retrievedAt: metadata.retrievedAt, segments: segments.length, components: groups.size,
      largestComponent: Math.max(...groups.values()), unverified,
      mappedKm: length(geometry), names: [...new Set(segments.map(s => s.record.properties.ezi_road_name_label).filter(Boolean))].sort() }
  } };
}
