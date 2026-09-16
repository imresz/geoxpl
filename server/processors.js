import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import { bbox, length, area, feature, featureCollection, booleanValid, booleanIntersects } from '@turf/turf';

export const algorithmVersion = 'conservative-assembly/1.0.0';
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

export function processGeometry(job, imports, boundary) {
  const lines = [], polygons = [], evidence = [], warnings = [];
  let declaredComplete = false, invalid = 0, inScope = false;
  for (const item of imports) {
    const source = item.source;
    for (const record of item.payload.features) {
      const geometry = record.geometry;
      const expected = job.type === 'river' ? ['LineString', 'MultiLineString'] : ['Polygon', 'MultiPolygon'];
      if (!geometry || !expected.includes(geometry.type)) { invalid++; continue; }
      try {
        validCoordinates(geometry);
        if (!booleanValid(record)) { invalid++; continue; }
        if (boundary && booleanIntersects(record, boundary)) inScope = true;
      } catch { invalid++; continue; }
      if (job.type === 'river') lines.push(...(geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates));
      else polygons.push(...(geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates));
      evidence.push({ sourceId: source.id, sourceName: source.name, sourceUrl: source.url, licence: source.licence, attribution: source.attribution, objectId: String(record.id ?? record.properties?.[source.idField || 'OBJECTID'] ?? 'not supplied'), importId: item.id, sourceVersion: source.version || 'retrieved snapshot', checksum: item.checksum });
    }
    declaredComplete ||= source.completeness === 'complete';
    if (item.truncated) warnings.push('The source did not return all requested records.');
  }
  if (invalid) warnings.push(`${invalid} record(s) were excluded because their geometry was invalid or the wrong type.`);
  if (!lines.length && !polygons.length) return { status: job.type === 'valley' ? 'missing_capability' : 'insufficient_data', message: job.type === 'valley' ? 'No approved valley polygon was found. Terrain derivation requires an additional processor.' : 'No usable named watercourse geometry was found.' };
  if (boundary && !inScope) return { status: 'insufficient_data', message: 'The available geometry does not intersect Victoria. Scope eligibility could not be established.' };
  if (!boundary) warnings.push('Victoria boundary was unavailable; geographic eligibility needs review.');
  let geometry, graphInfo = null;
  if (job.type === 'river') {
    const graph = new Graph.UndirectedGraph();
    const unique = new Map();
    for (const line of lines) {
      const forward = JSON.stringify(line), backward = JSON.stringify([...line].reverse());
      if (unique.has(forward) || unique.has(backward)) continue;
      unique.set(forward, line);
      for (let i = 1; i < line.length; i++) {
        const a = JSON.stringify(line[i - 1].slice(0, 2)), b = JSON.stringify(line[i].slice(0, 2));
        graph.mergeNode(a); graph.mergeNode(b);
        if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b);
      }
    }
    const components = connectedComponents(graph);
    const branches = graph.nodes().filter(n => graph.degree(n) > 2).length;
    const ends = graph.nodes().filter(n => graph.degree(n) === 1);
    graphInfo = { components: components.length, branchJunctions: branches, endpoints: ends.map(n => JSON.parse(n)) };
    geometry = { type: 'MultiLineString', coordinates: [...unique.values()] };
    if (components.length !== 1) warnings.push(`${components.length} disconnected components. Gaps have not been bridged.`);
    if (branches) warnings.push(`${branches} branching junctions. Main-stem selection requires more evidence.`);
    if (ends.length !== 2) warnings.push('A single source-to-mouth path could not be established.');
    if (!declaredComplete) warnings.push('Source coverage is not approved as the complete named feature.');
  } else {
    geometry = { type: 'MultiPolygon', coordinates: polygons };
    if (evidence.length > 1) warnings.push('Multiple matching polygon records require identity review before publication.');
    if (!declaredComplete) warnings.push('The available valley extent has not been approved as complete.');
  }
  const resolved = warnings.length === 0;
  const shape = feature(geometry);
  const result = { geometry, bbox: bbox(shape), graph: graphInfo, lengthKm: job.type === 'river' ? length(shape) : null, areaKm2: job.type === 'valley' ? area(shape) / 1e6 : null, source: null, mouth: null, principalDrainage: null, confidence: resolved ? 'source_supported' : 'review_required', method: job.type === 'river' ? 'exact_named_segment_assembly' : 'published_polygon', algorithmVersion, warnings, evidence, status: resolved ? 'resolved' : 'partially_resolved' };
  return { status: result.status, message: resolved ? 'Feature ready' : 'Available geometry needs review before it can be shown as the complete feature.', result };
}
