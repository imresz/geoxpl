import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import { bbox, distance, feature, featureCollection, lineString, nearestPointOnLine } from '@turf/turf';
import { z } from 'zod';

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const estimatedConnectionsSchema = z.array(z.object({
  coordinates: z.tuple([position, position]), label: z.string().trim().min(1).max(200),
  evidenceUrl: z.url().startsWith('https://'), evidenceRecord: z.string().trim().min(1).max(300)
})).max(32);
const maxAutomaticGapKm = 5;
const warning = 'Dotted connections are interpolated estimates, not verified geography. They are excluded from recorded measurements.';
const valid = p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const key = p => JSON.stringify(p.slice(0, 2));
function lines(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

// Estimates are a separate overlay; never change the recorded geometry, endpoints or measurements.
export function withInterpolations(result, item, settings = {}) {
  const output = [], notes = [], seen = new Set();
  const add = (from, to, properties) => {
    if (!valid(from) || !valid(to) || distance(from, to) <= 0.000001) return;
    const id = [key(from), key(to)].sort().join(':');
    if (seen.has(id)) return;
    seen.add(id);
    output.push(lineString([from.slice(0, 2), to.slice(0, 2)], { ...properties, id: `estimate-${output.length + 1}`, method: 'straight_line_interpolation', certainty: 'unverified', lengthKm: distance(from, to) }));
  };
  const shapes = lines(result.geometry);
  if (result.mainStem?.coordinateGaps?.length) {
    for (const gap of result.mainStem.coordinateGaps) {
      const [from, to] = gap.coordinates;
      if (distance(from, to) <= maxAutomaticGapKm) add(from, to, { kind: 'gap', label: 'Gap between linked recorded sections', basis: 'Published node link; the geometry between its endpoints is unknown', nodeId: gap.nodeId, importId: item?.id || null });
      else notes.push('A linked coordinate gap exceeds the 5 km automatic interpolation limit.');
    }
  } else if (['LineString', 'MultiLineString'].includes(result.geometry.type) && shapes.reduce((n, c) => n + c.length, 0) <= 250000) {
    const graph = new Graph.UndirectedGraph();
    for (const coordinates of shapes) for (let i = 1; i < coordinates.length; i++) {
      const a = key(coordinates[i - 1]), b = key(coordinates[i]);
      graph.mergeNode(a); graph.mergeNode(b);
      if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b);
    }
    const groups = connectedComponents(graph).map(nodes => nodes.filter(n => graph.degree(n) === 1).sort());
    if (groups.length <= 128 && groups.reduce((n, g) => n + g.length, 0) <= 256) {
      const candidates = [], links = new Graph.UndirectedGraph(), usedEnds = new Set();
      groups.forEach((_, i) => links.addNode(String(i)));
      for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
        for (const from of groups[a]) for (const to of groups[b]) {
          const km = distance(JSON.parse(from), JSON.parse(to));
          if (km <= maxAutomaticGapKm) candidates.push({ a: String(a), b: String(b), from, to, km });
        }
      }
      candidates.sort((a, b) => a.km - b.km || [a.from, a.to].sort().join(':').localeCompare([b.from, b.to].sort().join(':')));
      // Greedy shortest endpoint connections, without cycles or reusing an endpoint to create a fan.
      for (const c of candidates) {
        if (usedEnds.has(c.from) || usedEnds.has(c.to) || connectedComponents(links).some(g => g.includes(c.a) && g.includes(c.b))) continue;
        add(JSON.parse(c.from), JSON.parse(c.to), { kind: 'gap', label: 'Gap between recorded sections', basis: 'Nearest open endpoints in the selected feature', importId: item?.id || null });
        links.addEdge(c.a, c.b); usedEnds.add(c.from); usedEnds.add(c.to);
      }
      if (groups.length > 1 && connectedComponents(links).length > 1) notes.push('Some sections have no suitable endpoint pair within the 5 km automatic interpolation limit.');
    } else notes.push('Automatic interpolation was skipped because the feature exceeds endpoint/component limits.');
  } else if (['LineString', 'MultiLineString'].includes(result.geometry.type)) notes.push('Automatic interpolation was skipped because the feature exceeds the 250,000-vertex limit.');
  const start = result.mainStem?.namedStart;
  const context = item?.metadata?.geofabric?.headwaterContexts?.find(c => c.nodeId === start?.nodeId);
  if (start && context) {
    const nodes = item.metadata.geofabric.upstreamNodes || [];
    for (const record of context.incoming) {
      const excluded = result.mainStem.headwater?.excludedNamedTributaries?.find(f => f.hydroId === record.properties.hydroid);
      if (excluded) { notes.push(`${excluded.name} is a separately named tributary, not an assumed upstream extension of this feature.`); continue; }
      const node = nodes.find(n => n.properties.hydroid === record.properties.from_node);
      if (record.properties.to_node !== start.nodeId || !node || node.geometry?.type !== 'Point' || !valid(node.geometry.coordinates)) continue;
      if (distance(node.geometry.coordinates, start.coordinates) > maxAutomaticGapKm) { notes.push('An upstream alternative exceeds the 5 km automatic interpolation limit.'); continue; }
      add(node.geometry.coordinates, start.coordinates, { kind: 'upstream_alternative', label: context.incoming.length > 1 ? `Possible upstream connection ${output.filter(f => f.properties.kind === 'upstream_alternative').length + 1}` : 'Possible upstream connection', alternativeGroup: `headwater-${start.nodeId}`, basis: 'Published upstream node; membership of the named feature is unverified', hydroId: record.properties.hydroid, nodeId: node.properties.hydroid, importId: item.id, evidenceUrl: item.metadata.geofabric.nodesUrl });
    }
  }
  for (const connection of estimatedConnectionsSchema.parse(settings.estimatedConnections || [])) {
    const [from, to] = connection.coordinates;
    const onRecorded = shapes.some(coords => nearestPointOnLine(lineString(coords), from).properties.dist <= 0.001);
    if (!onRecorded) { notes.push(`Estimate omitted because its recorded anchor no longer matches the feature: ${connection.label}`); continue; }
    add(from, to, { kind: 'reviewed_anchor', label: connection.label, basis: 'Evidence-located anchor; the intervening path is unknown', evidenceUrl: connection.evidenceUrl, evidenceRecord: connection.evidenceRecord });
  }
  const interpolations = featureCollection(output);
  const displayBbox = bbox(featureCollection([feature(result.geometry), ...output]));
  return {
    ...result, interpolations, displayBbox,
    interpolationSummary: { version: 'straight-line/1', count: output.length, totalOverlayLengthKm: output.reduce((n, f) => n + f.properties.lengthKm, 0), maxAutomaticGapKm, notes },
    ...(output.length ? { status: 'partially_resolved', confidence: 'review_required', warnings: [...new Set([...result.warnings, warning])] } : {})
  };
}
