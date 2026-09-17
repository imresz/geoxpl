import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import { bbox, length, area, feature, booleanValid, booleanIntersects, buffer, distance } from '@turf/turf';

export const algorithmVersion = 'source-selected-assembly/2.0.0';
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
    geometry: { type: 'MultiLineString', coordinates: parts.map(part => part.coordinates) },
    records: [...indices].map(index => records[index]),
    graph: { components: kept.length, branchJunctions: kept.reduce((n, g) => n + g.branches, 0), endpoints: kept.flatMap(g => g.endpoints) },
    identity: { anchoredComponents: anchored, associatedComponents: associated, excludedComponents: groups.length - kept.length, excludedRecords: records.length - indices.size, scopeBufferKm: 2, continuationToleranceKm: 0.1 }
  };
}

function processSource(job, item, boundary) {
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
  let selected, geometry, graph = null, identity;
  if (job.type === 'river') {
    const match = selectRiverIdentity(records, boundary);
    if (match.error) return { sourceId: source.id, sourceName: source.name, error: match.error };
    ({ geometry, graph, identity } = match); selected = match.records;
    if (graph.components !== 1) warnings.push(`${graph.components} disconnected components. Gaps have not been bridged.`);
    if (graph.branchJunctions) warnings.push(`${graph.branchJunctions} branching junctions. Main-stem selection requires more evidence.`);
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
    result: { geometry, bbox: bounds, graph, identity, lengthKm: job.type === 'river' ? length(shape) : null, areaKm2: job.type === 'valley' ? area(shape) / 1e6 : null, source: null, mouth: null, principalDrainage: null, confidence: warnings.length ? 'review_required' : 'source_supported', method: job.type === 'river' ? 'single_source_named_network' : 'published_polygon', algorithmVersion, warnings, evidence, status: warnings.length ? 'partially_resolved' : 'resolved' }
  };
}

export function processGeometry(job, imports, boundary, settings = {}) {
  const candidates = imports.map(item => processSource(job, item, boundary));
  const comparisons = candidates.map(c => ({ sourceId: c.sourceId, sourceName: c.sourceName, coverage: c.coverage, error: c.error, excludedRecords: c.excludedRecords ?? c.result?.identity.excludedRecords, records: c.result?.evidence.length, lengthKm: c.result?.lengthKm, bbox: c.result?.bbox, components: c.result?.graph?.components, branches: c.result?.graph?.branchJunctions }));
  const eligible = candidates.filter(c => c.result);
  // Comparison datasets never contribute extra geometry or length to the selected source.
  eligible.sort((a, b) => Number(b.result.status === 'resolved') - Number(a.result.status === 'resolved') || b.spanKm - a.spanKm || a.sourceId.localeCompare(b.sourceId));
  const chosen = settings.preferredSourceId ? eligible.find(c => c.sourceId === settings.preferredSourceId) : eligible[0];
  if (!chosen) return {
    status: job.type === 'valley' && !imports.length ? 'missing_capability' : 'insufficient_data', comparisons,
    message: settings.preferredSourceId ? 'The selected source did not provide usable, in-scope geometry. Review source selection.' : 'No usable named geometry associated with Victoria was found.'
  };
  const result = { ...chosen.result, selection: { sourceId: chosen.sourceId, mode: settings.preferredSourceId ? 'administrator' : 'resolved_then_widest_coverage', comparisons } };
  return { status: result.status, message: result.status === 'resolved' ? 'Feature ready' : 'Available geometry needs review before it can be shown as the complete feature.', result, comparisons };
}
