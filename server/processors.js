import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import { bbox, length, area, feature, booleanValid, booleanIntersects, buffer, distance } from '@turf/turf';
import { mainStemCandidate } from './main-stem.js';
import { isGeofabric, traceGeofabricMatches } from './geofabric.js';
import { normalize } from './store.js';
import { withInterpolations } from './interpolation.js';

export const algorithmVersion = 'directed-geofabric/5.0.0';
const scopeRegions = new WeakMap();
export function validCoordinates(geometry) {
  let count = 0;
  const visit = c => {
    if (!Array.isArray(c) || !c.length) throw new Error('Empty coordinates');
    if (typeof c[0] === 'number') {
      if (c.length < 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw new Error('Invalid WGS84 coordinates');
      if (++count > 500000) throw new Error('Geometry exceeds 500,000 vertices');
    } else c.forEach(visit);
  };
  visit(geometry.coordinates); return count;
}

function scopeRegion(boundary) {
  if (!boundary) return null;
  // Eligibility includes border watercourses; the buffer never alters the returned geometry.
  if (!scopeRegions.has(boundary)) scopeRegions.set(boundary, buffer(boundary, 2, { units: 'kilometers' }));
  return scopeRegions.get(boundary);
}

function network(records) {
  const graph = new Graph.UndirectedGraph(), unique = new Map();
  for (const [index, record] of records.entries()) {
    const lines = record.geometry.type === 'LineString' ? [record.geometry.coordinates] : record.geometry.coordinates;
    for (const coordinates of lines) {
      const forward = JSON.stringify(coordinates), reverse = JSON.stringify([...coordinates].reverse());
      const existing = unique.get(forward) || unique.get(reverse);
      if (existing) { existing.records.add(index); continue; }
      const part = { coordinates, records: new Set([index]) };
      unique.set(forward, part);
      for (let i = 0; i < coordinates.length; i++) {
        const b = JSON.stringify(coordinates[i].slice(0, 2)); graph.mergeNode(b);
        if (!i) { part.node = b; continue; }
        const a = JSON.stringify(coordinates[i - 1].slice(0, 2));
        if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b);
      }
    }
  }
  const groups = connectedComponents(graph).map(nodes => ({
    nodes, parts: [], endpoints: nodes.filter(n => graph.degree(n) === 1).map(n => JSON.parse(n)),
    branches: nodes.filter(n => graph.degree(n) > 2).length
  }));
  const membership = new Map();
  groups.forEach((group, index) => group.nodes.forEach(node => membership.set(node, index)));
  for (const part of unique.values()) groups[membership.get(part.node)].parts.push(part);
  return groups;
}

function selectRiverIdentity(records, boundary) {
  const groups = network(records), region = scopeRegion(boundary);
  if (groups.length > 128) return { error: 'Too many disconnected components to establish river identity. Review a more specific dataset.' };
  const selected = new Set();
  groups.forEach((group, index) => {
    if (!region || group.parts.some(part => booleanIntersects(feature({ type: 'LineString', coordinates: part.coordinates }), region))) selected.add(index);
  });
  const anchored = selected.size;
  // Associate near-touching continuations without snapping, bridging, or inventing coordinates.
  let changed = true, associated = 0;
  while (changed) {
    changed = false;
    groups.forEach((group, index) => {
      if (selected.has(index)) return;
      const nearby = [...selected].some(other => group.endpoints.some(a => groups[other].endpoints.some(b => distance(a, b) <= 0.1)));
      if (nearby) { selected.add(index); associated++; changed = true; }
    });
  }
  const kept = [...selected].map(index => groups[index]);
  const parts = kept.flatMap(group => group.parts);
  const indices = new Set(parts.flatMap(part => [...part.records]));
  return {
    parts,
    geometry: { type: 'MultiLineString', coordinates: parts.map(part => part.coordinates) },
    records: [...indices].map(index => records[index]),
    graph: { components: kept.length, branchJunctions: kept.reduce((n, g) => n + g.branches, 0), endpoints: kept.flatMap(g => g.endpoints) },
    identity: { anchoredComponents: anchored, associatedComponents: associated, excludedComponents: groups.length - kept.length, excludedRecords: records.length - indices.size, scopeBufferKm: 2, continuationToleranceKm: 0.1 }
  };
}

function processSource(job, item, boundary, settings) {
  const source = item.source, records = [], warnings = [];
  let invalid = 0;
  for (const record of item.payload.features) {
    const expected = job.type === 'river' ? ['LineString', 'MultiLineString'] : ['Polygon', 'MultiPolygon'];
    try {
      if (!record.geometry || !expected.includes(record.geometry.type)) throw new Error('Unexpected geometry');
      validCoordinates(record.geometry);
      if (!booleanValid(record)) throw new Error('Invalid geometry');
      records.push(record);
    } catch { invalid++; }
  }
  if (!records.length) return { sourceId: source.id, sourceName: source.name, error: 'No usable named geometry was found.' };
  let selected, geometry, graph = null, identity, mainStem, recordedNetwork;
  if (job.type === 'river') {
    const match = selectRiverIdentity(records, boundary);
    if (match.error) return { sourceId: source.id, sourceName: source.name, error: match.error };
    ({ geometry, graph, identity } = match); selected = match.records;
    if (graph.components !== 1) warnings.push(`${graph.components} disconnected components. Gaps have not been bridged.`);
    if (graph.branchJunctions) {
      const candidate = mainStemCandidate(match.parts);
      if (candidate.error) {
        mainStem = { status: 'unavailable', reason: candidate.error };
        warnings.push(candidate.error);
      } else {
        recordedNetwork = { geometry, bbox: bbox(feature(geometry)), lengthKm: length(feature(geometry)), recordCount: selected.length };
        mainStem = candidate.diagnostics;
        geometry = candidate.geometry; selected = candidate.recordIndices.map(index => records[index]);
        warnings.push(`A main-stem candidate was extracted from ${graph.branchJunctions} branching junctions. Branch choices and endpoints are not verified.`);
      }
    }
    if (graph.endpoints.length !== 2) warnings.push('A single source-to-mouth path could not be established.');
    if (identity.associatedComponents) warnings.push('Nearby continuation components need identity review; their gaps remain unchanged.');
  } else {
    const region = scopeRegion(boundary);
    selected = records.filter(record => !region || booleanIntersects(record, region));
    geometry = { type: 'MultiPolygon', coordinates: selected.flatMap(r => r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates) };
    identity = { excludedRecords: records.length - selected.length, scopeBufferKm: 2 };
    if (selected.length > 1) warnings.push('Multiple matching polygon records require identity review before publication.');
  }
  if (!selected.length) return { sourceId: source.id, sourceName: source.name, error: 'No matching component is associated with Victoria.', excludedRecords: records.length };
  if (invalid) warnings.push(`${invalid} record(s) had invalid or unexpected geometry.`);
  if (item.truncated) warnings.push('The source did not return all requested records.');
  if (!boundary) warnings.push('Victoria boundary was unavailable; geographic eligibility needs review.');
  if (source.completeness !== 'complete') warnings.push('Source coverage is not approved as the complete named feature.');
  const evidence = selected.map(record => ({ sourceId: source.id, sourceName: source.name, sourceUrl: source.url, licence: source.licence, attribution: source.attribution, objectId: String(record.id ?? record.properties?.[source.idField || 'OBJECTID'] ?? 'not supplied'), importId: item.id, sourceVersion: source.version || 'retrieved snapshot', checksum: item.checksum }));
  const shape = feature(geometry), bounds = bbox(shape);
  return {
    sourceId: source.id, sourceName: source.name, coverage: source.completeness, spanKm: distance(bounds.slice(0, 2), bounds.slice(2)),
    result: { geometry, bbox: bounds, graph, identity, mainStem, recordedNetwork, lengthKm: job.type === 'river' ? length(shape) : null, areaKm2: job.type === 'valley' ? area(shape) / 1e6 : null, source: null, mouth: null, principalDrainage: null, confidence: mainStem?.status === 'candidate' ? 'unverified_candidate' : warnings.length ? 'review_required' : 'source_supported', method: mainStem?.status === 'candidate' ? 'main_stem_candidate' : job.type === 'river' ? 'single_source_named_network' : 'published_polygon', algorithmVersion, warnings, evidence, status: warnings.length ? 'partially_resolved' : 'resolved' }
  };
}

function processDirectedSource(item, result) {
  const source = item.source;
  const { records, confluenceRecords, headwaterRecords, headwaterNodes, ...data } = result;
  if (source.completeness === 'partial') data.warnings.push('The source is explicitly marked as partial coverage.');
  data.status = data.warnings.length ? 'partially_resolved' : 'resolved';
  data.mainStem.status = data.warnings.length ? 'candidate' : 'published_network';
  const provenance = { sourceId: source.id, sourceName: source.name, sourceUrl: source.url, licence: source.licence, attribution: source.attribution, importId: item.id, sourceVersion: source.version || 'retrieved snapshot', checksum: item.checksum };
  const evidence = records.map(record => ({ ...provenance, objectId: String(record.id ?? record.properties[source.idField]), hydroId: record.properties.hydroid, role: 'route_segment' }));
  for (const record of confluenceRecords) evidence.push({ ...provenance, objectId: String(record.id ?? record.properties[source.idField]), hydroId: record.properties.hydroid, role: 'confluence_support' });
  for (const record of headwaterRecords) evidence.push({ ...provenance, sourceUrl: item.metadata.geofabric.nodesUrl.replace('/3', '/6'), objectId: String(record.id ?? record.properties.objectid), hydroId: record.properties.hydroid, role: 'headwater_identity_support' });
  for (const record of headwaterNodes) evidence.push({ ...provenance, sourceUrl: item.metadata.geofabric.nodesUrl, objectId: String(record.id ?? record.properties.objectid), hydroId: record.properties.hydroid, role: 'upstream_node_support' });
  if (data.mainStem.namedStart) evidence.push({ ...provenance, sourceUrl: data.mainStem.namedStart.sourceUrl, objectId: String(data.mainStem.namedStart.objectId), hydroId: data.mainStem.namedStart.nodeId, role: 'named_start' });
  for (const endpoint of [data.source, data.mouth].filter(Boolean)) evidence.push({ ...provenance, sourceUrl: endpoint.sourceUrl, objectId: String(endpoint.objectId), hydroId: endpoint.nodeId, role: 'endpoint' });
  for (const pref of data.mainStem.usedPreferences) evidence.push({ ...provenance, sourceUrl: data.mainStem.preferencesUrl, objectId: String(pref.objectid), role: 'preferred_flow' });
  return { sourceId: source.id, sourceName: source.name, coverage: source.completeness, spanKm: distance(data.bbox.slice(0, 2), data.bbox.slice(2)), result: { ...data, lengthKm: length(feature(data.geometry)), areaKm2: null, principalDrainage: null, confidence: data.status === 'resolved' ? 'derived_published_network' : 'review_required', method: 'geofabric_directed_main_stem', algorithmVersion, evidence } };
}

function sourceMatches(job, item, boundary, settings) {
  if (job.type === 'river' && isGeofabric(item.source)) {
    const traced = traceGeofabricMatches(item, boundary, [job.query, ...(settings.aliases || [])].filter(Boolean).map(normalize));
    return traced.error ? [{ sourceId: item.source.id, sourceName: item.source.name, error: traced.error }] : traced.results.map(result => ({ ...processDirectedSource(item, result), identityRank: 2 }));
  }
  const records = item.payload.features;
  // These are publisher feature identities, not per-segment object IDs.
  const field = ['vicnames_id', 'named_feature_id', 'hydronameoid'].find(key => records.length && records.every(r => Number.isSafeInteger(r.properties?.[key]) && r.properties[key] > 0));
  if (!field) return [processSource(job, item, boundary, settings)];
  const groups = new Map();
  for (const record of records) {
    const id = record.properties[field];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  if (groups.size > 128) return [{ sourceId: item.source.id, sourceName: item.source.name, error: 'More than 128 matching feature identities; narrow the approved dataset.' }];
  return [...groups].sort(([a], [b]) => a - b).map(([id, features]) => {
    const candidate = processSource(job, { ...item, payload: { ...item.payload, features } }, boundary, settings);
    if (candidate.result) {
      candidate.result.identityKey = `${item.source.url.replace('/FeatureServer/', '/MapServer/')}:${field}:${id}`;
      candidate.result.identity.publisherIdentity = { field, value: id, sourceUrl: item.source.url };
      candidate.identityRank = 1;
    }
    return candidate;
  });
}

function labelMatches(job, results, boundary) {
  const regionBounds = boundary ? bbox(boundary) : null;
  const regionMiddle = regionBounds && (regionBounds[0] + regionBounds[2]) / 2;
  return results.map(result => {
    const [west, south, east, north] = result.bbox;
    const lon = (west + east) / 2, lat = (south + north) / 2;
    const position = `${Math.abs(lat).toFixed(3)} ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)} ${lon < 0 ? 'W' : 'E'}`;
    const location = regionMiddle === null ? `Near ${position}` : `${lon < regionMiddle ? 'Western' : 'Eastern'} Victoria`;
    const receiving = result.mouth?.receivingRiver;
    const locationLabel = receiving ? `${location}; joins ${receiving}` : location;
    return { ...result, locationLabel, locationDescription: `Extent centred near ${position}`, displayName: results.length > 1 ? `${job.query} (${locationLabel})` : job.query };
  }).map((result, _, labelled) => labelled.filter(other => other.displayName === result.displayName).length > 1
    ? { ...result, displayName: `${result.displayName} - ${result.locationDescription} [${result.identityKey.split(':').at(-1)}]` } : result);
}

export function processGeometry(job, imports, boundary, settings = {}) {
  const candidates = imports.flatMap(item => sourceMatches(job, item, boundary, settings));
  const comparisons = candidates.map(c => ({ sourceId: c.sourceId, sourceName: c.sourceName, identityKey: c.result?.identityKey, coverage: c.coverage, error: c.error, excludedRecords: c.excludedRecords ?? c.result?.identity.excludedRecords, records: c.result?.evidence.length, lengthKm: c.result?.lengthKm, bbox: c.result?.bbox, components: c.result?.graph?.components, branches: c.result?.graph?.branchJunctions }));
  const eligible = imports.map(item => {
    const matches = candidates.filter(c => c.sourceId === item.source.id && c.result);
    return { sourceId: item.source.id, matches, identityRank: Math.max(0, ...matches.map(c => c.identityRank || 0)), resolved: matches.length > 0 && matches.every(c => c.result.status === 'resolved'), warnings: matches.reduce((n, c) => n + c.result.warnings.length, 0) / matches.length, spanKm: Math.max(0, ...matches.map(c => c.spanKm)) };
  }).filter(c => c.matches.length);
  const multiple = eligible.some(c => c.matches.length > 1);
  // Comparison datasets never contribute extra geometry or length to the selected source.
  eligible.sort((a, b) => (multiple ? b.identityRank - a.identityRank : 0) || Number(b.resolved) - Number(a.resolved) || (multiple ? a.warnings - b.warnings : 0) || b.spanKm - a.spanKm || a.sourceId.localeCompare(b.sourceId));
  const chosen = settings.preferredSourceId ? eligible.find(c => c.sourceId === settings.preferredSourceId) : eligible[0];
  if (!chosen) return {
    status: job.type === 'valley' && !imports.length ? 'missing_capability' : 'insufficient_data', comparisons,
    message: settings.preferredSourceId ? 'The selected source did not provide usable, in-scope geometry. Review source selection.' : 'No usable named geometry associated with Victoria was found.'
  };
  const results = labelMatches(job, chosen.matches.map(candidate => {
    const selected = { ...candidate.result, selection: { sourceId: chosen.sourceId, mode: settings.preferredSourceId ? 'administrator' : multiple ? 'identity_evidence_then_resolution_and_coverage' : 'resolved_then_widest_coverage', comparisons } };
    return withInterpolations(selected, imports.find(i => i.source.id === chosen.sourceId), settings);
  }), boundary);
  const status = results.every(r => r.status === 'resolved') ? 'resolved' : 'partially_resolved';
  return { status, message: results.length > 1 ? `${results.length} same-named features found. Choose a location.` : status === 'resolved' ? 'Feature ready' : 'Available geometry needs review before it can be shown as the complete feature.', result: results.length === 1 ? results[0] : null, results, comparisons };
}
