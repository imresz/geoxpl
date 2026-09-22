import { createHash } from 'node:crypto';
import { z } from 'zod';
import { area, bbox, booleanIntersects, booleanValid, coordEach, feature, featureCollection, flattenEach, union } from '@turf/turf';

export const landformEndpoint = 'https://opendata.maps.vic.gov.au/geoserver/wfs';
export const valleyFloorSchema = z.object({
  sourceId: z.string().min(1), drainageFeatureId: z.string().min(1),
  recordIds: z.array(z.string().regex(/^gmu250\.[1-9][0-9]*$/)).min(1).max(32),
  scopeNote: z.string().trim().min(20).max(2000),
  evidenceUrl: z.url().startsWith('https://')
}).strict();

export function drainageFingerprint(drainage) {
  return createHash('sha256').update(JSON.stringify({ geometry: drainage.geometry, evidence: drainage.evidence, status: drainage.status, algorithmVersion: drainage.algorithmVersion })).digest('hex');
}

export async function importValleyLandforms(source, settings, load) {
  const definition = valleyFloorSchema.parse(settings.valleyFloor);
  if (source.type !== 'valley' || source.id !== definition.sourceId || source.url !== landformEndpoint) throw Error('Select the approved Victorian GMU250 WFS source for this valley definition.');
  const ids = [...new Set(definition.recordIds)].sort();
  const params = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'open-data-platform:gmu250',
    resourceID: ids.join(','), count: String(ids.length + 1), outputFormat: 'application/json', srsName: 'EPSG:4326' });
  const requestUrl = `${landformEndpoint}?${params}`;
  const collection = await load(requestUrl);
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw Error('Landform service did not return a GeoJSON collection.');
  if (collection.crs && !['urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84'].includes(collection.crs.properties?.name)) throw Error('Landform coordinates must be WGS84 longitude/latitude.');
  const returned = collection.features.map(f => f.id).sort();
  if (JSON.stringify(returned) !== JSON.stringify(ids) || Number(collection.numberMatched) !== ids.length || Number(collection.numberReturned) !== ids.length || collection.links?.some(l => l.rel === 'next')) throw Error('Landform service returned missing, extra or truncated records.');
  const payload = { type: 'FeatureCollection', features: collection.features };
  return { payload, truncated: false, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    metadata: { adapter: 'vic-gmu250/1', requestUrl, recordIds: ids, crs: 'EPSG:4326', interpretation: 'reviewed valley-floor association; not a named valley boundary' } };
}

export function processValleyFloor(item, boundary, settings, drainage) {
  const source = item.source;
  const failure = error => ({ sourceId: source.id, sourceName: source.name, error });
  try {
    const definition = valleyFloorSchema.parse(settings.valleyFloor);
    if (definition.sourceId !== source.id || source.status !== 'approved' || source.type !== 'valley' || source.url !== landformEndpoint) throw Error('Valley-floor source association is not approved.');
    if (!drainage || drainage.id !== definition.drainageFeatureId || drainage.type !== 'river' || drainage.status !== 'resolved' || !['LineString', 'MultiLineString'].includes(drainage.geometry?.type)) throw Error('A current, resolved principal river is required for a valley-floor estimate.');
    if (!boundary) throw Error('Victoria boundary is required for landform eligibility.');
    const ids = [...new Set(definition.recordIds)].sort();
    if (item.truncated || item.metadata?.adapter !== 'vic-gmu250/1' || JSON.stringify(item.payload.features.map(r => r.id).sort()) !== JSON.stringify(ids)) throw Error('The reviewed landform records are incomplete or do not match this definition.');
    const polygons = [], records = [], river = feature(drainage.geometry);
    let vertices = 0, excludedParts = 0;
    for (const record of item.payload.features) {
      // Start with the explicitly documented terrace/fan/floodplain class. Other classes need a reviewed adapter rule.
      if (record.properties?.gmu_t3 !== '1.3.3' || record.properties?.lfm_pattern !== 'TER' || record.properties?.lfm_element !== 'TEP') throw Error(`Landform ${record.id} is not a supported terrace/fan/floodplain class.`);
      if (!['Polygon', 'MultiPolygon'].includes(record.geometry?.type) || !booleanValid(record)) throw Error(`Landform ${record.id} has invalid polygon geometry.`);
      coordEach(record, c => { if (++vertices > 500000 || !c.every(Number.isFinite) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw Error('Landform coordinates exceed the WGS84 geometry limits.'); });
      let kept = 0;
      flattenEach(record, part => {
        if (booleanIntersects(part, river) && booleanIntersects(part, boundary)) { polygons.push(part); kept++; }
        else excludedParts++;
      });
      if (!kept) throw Error(`Landform ${record.id} does not intersect the reviewed principal river in Victoria.`);
      records.push(record);
    }
    if (!polygons.length || polygons.length > 128) throw Error('No bounded, usable landform selection was found.');
    const shape = polygons.length === 1 ? polygons[0] : union(featureCollection(polygons));
    if (!shape || !booleanValid(shape)) throw Error('The combined valley-floor estimate is not a valid polygon.');
    const bounds = bbox(shape);
    const provenance = { sourceId: source.id, sourceName: source.name, sourceUrl: source.url, licence: source.licence, attribution: source.attribution,
      importId: item.id, sourceVersion: source.version || 'retrieved snapshot', checksum: item.checksum, role: 'mapped_landform' };
    return { sourceId: source.id, sourceName: source.name, coverage: 'partial', spanKm: 0,
      result: { geometry: shape.geometry, bbox: bounds, status: 'partially_resolved', confidence: 'estimated', method: 'mapped_landform_valley_floor', algorithmVersion: 'valley-floor/1.0.0',
        lengthKm: null, areaKm2: area(shape) / 1e6, source: null, mouth: null, graph: null,
        principalDrainage: { featureId: drainage.id, name: drainage.name, checksum: drainageFingerprint(drainage) },
        identity: { excludedRecords: 0, excludedPolygonParts: excludedParts, reviewedLandformIds: ids },
        extentEstimate: { kind: 'valley_floor', label: 'Estimated valley floor', coverage: 'partial', scopeNote: definition.scopeNote, evidenceUrl: definition.evidenceUrl,
          sourceScale: 'Generalised regional landform mapping (approximately 1:100,000 to 1:500,000)' },
        warnings: ['Partial valley-floor estimate, not the complete ridge-to-ridge valley or an official named boundary.',
          'Mapped terraces, fans and floodplains can include connected tributary flats. Valley sides and unmapped gaps are not inferred.',
          'This is not a flood-risk, cadastral or planning boundary.'],
        evidence: [...records.map(record => ({ ...provenance, objectId: record.id })), ...(drainage.evidence || []).map(e => ({ ...e, role: 'principal_drainage_support' }))] } };
  } catch (error) { return failure(error.message); }
}
