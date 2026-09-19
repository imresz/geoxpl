import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import { dijkstra } from 'graphology-shortest-path';
import { distance } from '@turf/turf';

// A geometric routing hypothesis, never hydrological verification. No snapping or gap filling.
export function mainStemCandidate(parts) {
  const graph = new Graph.UndirectedGraph();
  for (const part of parts) {
    for (let i = 1; i < part.coordinates.length; i++) {
      const a = part.coordinates[i - 1].slice(0, 2), b = part.coordinates[i].slice(0, 2);
      const u = JSON.stringify(a), v = JSON.stringify(b);
      if (u === v) continue;
      graph.mergeNode(u); graph.mergeNode(v);
      const edge = graph.edge(u, v);
      if (edge !== undefined) {
        for (const index of part.records) graph.getEdgeAttribute(edge, 'records').add(index);
      } else graph.addEdge(u, v, { weight: distance(a, b), records: new Set(part.records) });
    }
  }
  if (graph.order > 250000) return { error: 'The named network exceeds the candidate-routing limit of 250,000 vertices.' };
  const coordinates = [], records = new Set(), routes = [], limitations = [];
  let inputLengthKm = 0, lengthKm = 0;
  graph.forEachEdge((_edge, attrs) => { inputLengthKm += attrs.weight; });
  const groups = connectedComponents(graph).sort((a, b) => a.slice().sort()[0].localeCompare(b.slice().sort()[0]));
  for (const nodes of groups) {
    const endpoints = nodes.filter(n => graph.degree(n) === 1).sort();
    const anchors = nodes.filter(n => graph.degree(n) !== 2).sort();
    if (endpoints.length < 2) return { error: 'A connected component has fewer than two open endpoints; no endpoint-based route can be inferred.' };
    if (endpoints.length > 128 || anchors.length > 512) return { error: 'The named network exceeds candidate-routing limits (128 endpoints or 512 junctions per component).' };

    // Collapse degree-two chains so shortest-path searches do not copy paths for every bend.
    const compact = new Graph.UndirectedGraph(), visited = new Set();
    for (const node of anchors) compact.addNode(node);
    let alternatives = 0;
    for (const start of anchors) {
      for (const first of graph.edges(start).sort((a, b) => graph.opposite(start, a).localeCompare(graph.opposite(start, b)))) {
        if (visited.has(first)) continue;
        const chain = [start], indices = new Set();
        let current = start, edge = first, weight = 0;
        while (true) {
          visited.add(edge);
          const attrs = graph.getEdgeAttributes(edge);
          weight += attrs.weight;
          for (const index of attrs.records) indices.add(index);
          current = graph.opposite(current, edge); chain.push(current);
          if (graph.degree(current) !== 2) break;
          edge = graph.edges(current).find(e => e !== edge);
        }
        if (current === start) { alternatives++; continue; }
        const existing = compact.edge(start, current);
        const attrs = { weight, chain, records: indices };
        if (existing === undefined) compact.addEdge(start, current, attrs);
        else {
          alternatives++;
          const old = compact.getEdgeAttributes(existing);
          if (weight < old.weight || (weight === old.weight && JSON.stringify(chain) < JSON.stringify(old.chain))) compact.replaceEdgeAttributes(existing, attrs);
        }
      }
    }
    let best = null;
    for (const start of endpoints) {
      const paths = dijkstra.singleSource(compact, start, 'weight');
      for (const end of endpoints) {
        if (end <= start) continue;
        const path = paths[end];
        if (!path) continue;
        const weight = path.slice(1).reduce((sum, node, i) => sum + compact.getEdgeAttribute(compact.edge(path[i], node), 'weight'), 0);
        if (!best || weight > best.weight) best = { path, weight };
      }
    }
    if (!best) return { error: 'No continuous candidate route exists between the component endpoints.' };
    const route = [];
    for (let i = 1; i < best.path.length; i++) {
      const attrs = compact.getEdgeAttributes(compact.edge(best.path[i - 1], best.path[i]));
      const chain = attrs.chain[0] === best.path[i - 1] ? attrs.chain : [...attrs.chain].reverse();
      for (const node of chain.slice(i === 1 ? 0 : 1)) route.push(JSON.parse(node));
      for (const index of attrs.records) records.add(index);
    }
    coordinates.push(route); lengthKm += best.weight;
    routes.push({ endpoints: [route[0], route.at(-1)], lengthKm: best.weight, endpointCandidates: endpoints.length, parallelAlternatives: alternatives });
  }
  limitations.push('Endpoints are inferred from the network, not verified headwaters or mouth; flow direction is unknown.');
  limitations.push('Shortest routes through braids and the most widely separated network endpoints are geometric heuristics, not evidence of the hydrological main stem.');
  if (groups.length > 1) limitations.push('Disconnected components remain separate; no connecting geometry has been invented.');
  return {
    geometry: { type: 'MultiLineString', coordinates }, recordIndices: [...records],
    diagnostics: { status: 'candidate', method: 'longest_endpoint_shortest_path', inputLengthKm, lengthKm, excludedLengthKm: Math.max(0, inputLengthKm - lengthKm), componentRoutes: routes, limitations }
  };
}
