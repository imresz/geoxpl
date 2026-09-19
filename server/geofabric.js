import { createHash } from 'node:crypto';
import { bbox, booleanIntersects, buffer, distance, feature, length } from '@turf/turf';
import { normalize } from './store.js';

export const geofabricStreamUrl = 'https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/ahgf/Geofabric_V3x_All_Products/MapServer/6';
const base = geofabricStreamUrl.slice(0, -2);
const limit = 10000;
export const isGeofabric = source => source.format === 'arcgis' && [geofabricStreamUrl, geofabricStreamUrl.replace('/MapServer/', '/FeatureServer/')].includes(source.url.replace(/\/$/, ''));
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const named = (record, terms) => terms.includes(normalize(String(record.properties?.name || '')));

async function rows(load, layer, field, ids, spatial = false) {
  const output = [];
  const unique = [...new Set(ids)];
  if (unique.some(id => !positiveId(id))) throw Error('Geofabric supplied an invalid network identifier.');
  for (let i = 0; i < unique.length; i += 50) {
    const params = new URLSearchParams({ f: spatial ? 'geojson' : 'json', where: `${field} IN (${unique.slice(i, i + 50).join(',')})`, outFields: '*', outSR: '4326', returnGeometry: String(spatial) });
    const data = await load(`${base}/${layer}/query?${params}`);
    if (data.error) throw Error(`Geofabric: ${data.error.message}`);
    if (!Array.isArray(data.features) || data.exceededTransferLimit) throw Error('Geofabric returned an incomplete network query.');
    output.push(...data.features);
  }
  return output;
}

export async function extendGeofabric(imported, load, progress = () => {}) {
  const fields = new Set(imported.metadata.fields?.map(f => f.name));
  for (const field of ['hydroid', 'from_node', 'to_node', 'nextdownid', 'flowdir', 'ahgfftype', 'name']) {
    if (!fields.has(field)) throw Error(`Geofabric schema changed: missing ${field}.`);
  }
  if (imported.truncated) throw Error('A complete named Geofabric import is required before tracing.');
  const records = new Map(), missing = new Set(), namedIds = [];
  function add(record) {
    const id = record.properties?.hydroid;
    if (!positiveId(id)) throw Error('Geofabric stream has no valid HydroID.');
    if (records.has(id) && JSON.stringify(records.get(id)) !== JSON.stringify(record)) throw Error(`Conflicting Geofabric records for HydroID ${id}.`);
    records.set(id, record);
    if (records.size > limit) throw Error('Geofabric trace exceeds the 10,000-segment import limit.');
  }
  imported.payload.features.forEach(record => { add(record); namedIds.push(record.properties.hydroid); });
  // Close all named seeds under the publisher's downstream relation, including unnamed connectors.
  for (let round = 0; round < 500; round++) {
    const needed = [...new Set([...records.values()].map(f => f.properties.nextdownid).filter(id => positiveId(id) && !records.has(id) && !missing.has(id)))];
    if (!needed.length) break;
    const fetched = await rows(load, 6, 'hydroid', needed, true);
    fetched.forEach(add);
    for (const id of needed) if (!records.has(id)) missing.add(id);
    if (round % 10 === 0) progress(`Following Geofabric downstream links: ${records.size} segments`);
    if (round === 499) throw Error('Geofabric trace exceeds the downstream expansion limit.');
  }
  const all = [...records.values()].sort((a, b) => a.properties.hydroid - b.properties.hydroid);
  const starts = new Set(all.map(f => f.properties.from_node)), ends = new Set(all.map(f => f.properties.to_node));
  const endpointIds = [...new Set([...starts].filter(id => !ends.has(id)).concat([...ends].filter(id => !starts.has(id))))];
  const seedStarts = new Set(imported.payload.features.map(f => f.properties.from_node));
  const junctionIds = [...new Set(imported.payload.features.map(f => f.properties.to_node).filter(id => !seedStarts.has(id)))];
  if (junctionIds.length > 128) throw Error('Geofabric exceeds the 128 potential-confluence limit.');
  progress(`Checking Geofabric river junctions: ${junctionIds.length} nodes`);
  // Query both sides of a possible mouth; downstream closure alone omits the receiving river upstream.
  const incoming = await rows(load, 6, 'to_node', junctionIds, true);
  const outgoing = await rows(load, 6, 'from_node', junctionIds, true);
  if (incoming.length + outgoing.length > limit) throw Error('Geofabric junction evidence exceeds the 10,000-record limit.');
  const junctions = junctionIds.map(nodeId => ({ nodeId, incoming: incoming.filter(f => f.properties.to_node === nodeId), outgoing: outgoing.filter(f => f.properties.from_node === nodeId) }));
  const nodes = await rows(load, 3, 'hydroid', [...endpointIds, ...junctionIds], true);
  const seedEnds = new Set(imported.payload.features.map(f => f.properties.to_node));
  const namedStartIds = [...seedStarts].filter(id => !seedEnds.has(id));
  if (namedStartIds.length > 128) throw Error('Geofabric exceeds the 128 named-start limit.');
  const uncertainStarts = namedStartIds.filter(id => !nodes.some(n => n.properties.hydroid === id && n.properties.ahgfftype === 9));
  // Preserve upstream evidence without guessing which unnamed tributary carries the river's identity.
  const upstream = await rows(load, 6, 'to_node', uncertainStarts, true);
  if (upstream.length + incoming.length + outgoing.length > limit) throw Error('Geofabric endpoint evidence exceeds the 10,000-record limit.');
  const upstreamNodes = await rows(load, 3, 'hydroid', upstream.map(f => f.properties.from_node), true);
  const headwaterContexts = uncertainStarts.map(nodeId => ({ nodeId, incoming: upstream.filter(f => f.properties.to_node === nodeId) }));
  const counts = new Map();
  for (const record of all) counts.set(record.properties.from_node, (counts.get(record.properties.from_node) || 0) + 1);
  const preferences = (await rows(load, 37, 'nodeid', [...counts].filter(([, n]) => n > 1).map(([id]) => id))).map(f => f.attributes);
  const trace = { version: 'geofabric-network/3', namedIds, namedStartIds, headwaterContexts, upstreamNodes, missingIds: [...missing], nodes, preferences, junctions, nodesUrl: `${base}/3`, preferencesUrl: `${base}/37` };
  const payload = { type: 'FeatureCollection', features: all };
  const checksum = createHash('sha256').update(JSON.stringify({ payload, trace })).digest('hex');
  return { ...imported, payload, checksum, metadata: { ...imported.metadata, geofabric: trace } };
}

function oriented(record) {
  const { geometry, properties: p } = record;
  if (geometry?.type !== 'LineString' || geometry.coordinates.length < 2 || ![1, 2].includes(p.flowdir)) throw Error(`Stream ${p.hydroid} has unsupported geometry or unknown flow direction.`);
  if (![p.hydroid, p.from_node, p.to_node].every(positiveId) || !(p.nextdownid === -1 || positiveId(p.nextdownid))) throw Error(`Stream ${p.hydroid} has invalid connectivity.`);
  if (!geometry.coordinates.every(c => c.length >= 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)) throw Error(`Stream ${p.hydroid} has invalid coordinates.`);
  return p.flowdir === 2 ? [...geometry.coordinates].reverse() : geometry.coordinates;
}

function confluenceAt(previous, junction, node, terms, byId) {
  if (!previous || !named(previous, terms) || !junction) return null;
  const { incoming, outgoing } = junction;
  if (outgoing.some(f => named(f, terms))) return null;
  const receiving = outgoing.filter(f => normalize(String(f.properties.name || '')));
  if (!receiving.length) return null;
  // Waterbody connections can change names without being tributary mouths.
  if (node && node.properties.ahgfftype !== 4) return null;
  const fail = reason => ({ error: `Confluence at node ${junction.nodeId} needs evidence: ${reason}` });
  if (!node || node.geometry?.type !== 'Point') return fail('a classified junction point is missing.');
  if (outgoing.length !== 1) return fail('the receiving river has ambiguous outgoing branches.');
  const downstream = receiving[0], name = normalize(downstream.properties.name);
  const upstream = incoming.filter(f => f.properties.hydroid !== previous.properties.hydroid && normalize(String(f.properties.name || '')) === name);
  if (!upstream.length) return null;
  if (upstream.length !== 1) return fail('a unique same-named receiving river must enter and leave the junction.');
  if ([upstream[0], downstream].some(f => byId.has(f.properties.hydroid) && JSON.stringify(byId.get(f.properties.hydroid)) !== JSON.stringify(f))) return fail('receiving-river records conflict with the imported network.');
  const tributary = incoming.find(f => f.properties.hydroid === previous.properties.hydroid);
  if (!tributary || JSON.stringify(tributary) !== JSON.stringify(previous)) return fail('the junction query does not agree with the traced tributary record.');
  if (previous.properties.nextdownid !== downstream.properties.hydroid || upstream[0].properties.nextdownid !== downstream.properties.hydroid) return fail('published downstream IDs do not confirm the receiving river.');
  if (previous.properties.to_node !== junction.nodeId || upstream[0].properties.to_node !== junction.nodeId || downstream.properties.from_node !== junction.nodeId) return fail('published node IDs are inconsistent.');
  try {
    const points = [oriented(previous).at(-1), oriented(upstream[0]).at(-1), oriented(downstream)[0]];
    if (points.some(point => distance(node.geometry.coordinates, point) > 0.000001)) return fail('stream endpoints do not coincide with the junction; no bridge was invented.');
  } catch (error) { return fail(error.message); }
  return { kind: 'confluence', nodeId: junction.nodeId, receivingRiver: downstream.properties.name, tributaryHydroId: previous.properties.hydroid, receivingUpstreamHydroId: upstream[0].properties.hydroid, receivingDownstreamHydroId: downstream.properties.hydroid, rule: 'published_receiving_river_continuity', records: [upstream[0], downstream] };
}

export function traceGeofabric(item, boundary, terms) {
  const trace = item.metadata?.geofabric;
  const records = item.payload.features;
  if (!trace || !['geofabric-network/1', 'geofabric-network/2', 'geofabric-network/3'].includes(trace.version)) return { error: 'Geofabric connectivity and endpoint evidence has not been imported.' };
  if (!boundary) return { error: 'The Victoria boundary is required to identify the intended river.' };
  const region = buffer(boundary, 2, { units: 'kilometers' });
  const byId = new Map(), outgoing = new Map(), nodes = new Map(trace.nodes.map(n => [n.properties.hydroid, n]));
  for (const record of records) {
    const p = record.properties;
    if (byId.has(p.hydroid)) return { error: 'Duplicate Geofabric HydroID in imported records.' };
    byId.set(p.hydroid, record);
    if (!outgoing.has(p.from_node)) outgoing.set(p.from_node, []);
    outgoing.get(p.from_node).push(record);
  }
  const prefs = new Map(trace.preferences.map(p => [p.nodeid, p.prefedgeid]));
  const namedIds = new Set(trace.namedIds);
  const junctions = new Map((trace.junctions || []).map(j => [j.nodeId, j]));
  const heads = [...nodes.values()].filter(n => n.properties.ahgfftype === 9 && (outgoing.get(n.properties.hydroid) || []).some(f => namedIds.has(f.properties.hydroid) && named(f, terms)));
  const headwaterContexts = new Map((trace.headwaterContexts || []).map(c => [c.nodeId, c]));
  if (trace.version === 'geofabric-network/3') {
    const seedEnds = new Set(records.filter(f => namedIds.has(f.properties.hydroid)).map(f => f.properties.to_node));
    for (const id of trace.namedStartIds || []) {
      const node = nodes.get(id);
      if (node?.properties.ahgfftype !== 9 && node?.geometry?.type === 'Point' && !seedEnds.has(id) && headwaterContexts.has(id) && (outgoing.get(id) || []).some(f => namedIds.has(f.properties.hydroid) && named(f, terms))) heads.push(node);
    }
  }
  const candidates = [];
  for (const head of heads) {
    let current = head.properties.hydroid, previous = null, failure = null, confluence = null;
    const path = [], decisions = [], seen = new Set();
    while (path.length < limit) {
      const mouth = confluenceAt(previous, junctions.get(current), nodes.get(current), terms, byId);
      if (mouth?.error) { failure = mouth.error; break; }
      if (mouth && [mouth.receivingUpstreamHydroId, mouth.receivingDownstreamHydroId].some(id => seen.has(id))) { failure = 'Receiving-river evidence reconnects to the traced route; a cycle cannot define a mouth.'; break; }
      if (mouth) { confluence = mouth; break; }
      const choices = outgoing.get(current) || [];
      if (!choices.length) break;
      if (previous?.properties.nextdownid === -1) { failure = 'The published end-of-network marker conflicts with outgoing segments.'; break; }
      const matching = choices.filter(f => named(f, terms));
      const pool = matching.length ? matching : choices;
      const preferred = pool.find(f => f.properties.hydroid === prefs.get(current));
      const linked = pool.find(f => f.properties.hydroid === previous?.properties.nextdownid);
      if (prefs.has(current) && !byId.has(prefs.get(current))) { failure = `Published preferred segment ${prefs.get(current)} was not imported.`; break; }
      // Name continuity defines the requested river; publisher IDs adjudicate remaining splits.
      const next = preferred || (matching.length === 1 ? matching[0] : linked) || (!previous && pool.length === 1 ? pool[0] : null);
      if (!next) { failure = `No unambiguous published continuation at network node ${current}.`; break; }
      const p = next.properties;
      if (seen.has(p.hydroid)) { failure = `A downstream cycle was detected at segment ${p.hydroid}.`; break; }
      try {
        const coordinates = oriented(next);
        const last = path.at(-1)?.coordinates.at(-1);
        if (last && distance(last, coordinates[0]) > 0.000001) throw Error(`Published segments have a coordinate gap at node ${current}; no bridge was invented.`);
        if (!last && (head.geometry?.type !== 'Point' || distance(head.geometry.coordinates, coordinates[0]) > 0.000001)) throw Error('Published head node does not match the stream geometry.');
        path.push({ record: next, coordinates }); seen.add(p.hydroid);
      } catch (e) { failure = e.message; break; }
      if (choices.length > 1) decisions.push({ nodeId: current, selectedHydroId: p.hydroid, rule: preferred ? 'published_preferred_flow' : matching.length === 1 ? 'named_river_continuity' : 'published_next_down_id', alternativeHydroIds: choices.filter(f => f !== next).map(f => f.properties.hydroid) });
      current = p.to_node; previous = next;
    }
    if (!path.length || !path.some(p => named(p.record, terms) && booleanIntersects(p.record, region))) continue;
    const outlet = nodes.get(current);
    const warnings = failure ? [failure] : [];
    const verifiedHeadwater = head.properties.ahgfftype === 9;
    const headwaterContext = verifiedHeadwater ? null : headwaterContexts.get(head.properties.hydroid);
    if (!verifiedHeadwater) warnings.push(`The named reach starts at BoM node ${head.properties.hydroid}, not a classified headwater. ${headwaterContext.incoming.length} upstream stream(s) require river-identity evidence; none has been appended. The full source-to-mouth extent remains unverified.`);
    let verifiedOutlet = false;
    if (path.length === limit) warnings.push('The route reached the processing limit.');
    if (confluence) verifiedOutlet = true;
    else if (!outlet || outlet.properties.ahgfftype !== 5 || previous?.properties.nextdownid !== -1) warnings.push('A classified terminal node and end-of-network marker, or a verified receiving-river confluence, was not reached.');
    else if (outlet.geometry?.type !== 'Point' || distance(outlet.geometry.coordinates, path.at(-1).coordinates.at(-1)) > 0.000001) warnings.push('The terminal node does not match the stream geometry.');
    else verifiedOutlet = true;
    const routeLength = path.reduce((total, p) => total + length(feature({ type: 'LineString', coordinates: p.coordinates })), 0);
    const namedLength = path.filter(p => named(p.record, terms)).reduce((total, p) => total + length(p.record), 0);
    const nameFraction = routeLength > 0 ? namedLength / routeLength : 0;
    if (nameFraction < 0.95) warnings.push('More than 5% of this flow path lies outside the approved river names. A tributary mouth or additional identity evidence is needed.');
    if (trace.missingIds.length || item.truncated) warnings.push('Some network records were unavailable; the import is not complete.');
    candidates.push({ path, head, verifiedHeadwater, headwaterContext, outlet: verifiedOutlet ? outlet : null, confluence, decisions, warnings, nameFraction });
  }
  if (!candidates.length) return { error: 'No route from a classified, named headwater intersects Victoria. A source or confluence identity needs additional evidence.' };
  if (candidates.length > 1) {
    candidates.sort((a, b) => b.path.length - a.path.length);
    for (const candidate of candidates) candidate.warnings.push(`${candidates.length} named starting routes intersect Victoria; river identity is ambiguous.`);
  }
  const candidate = candidates[0];
  const route = candidate.path.map(p => p.record);
  const coordinates = candidate.path.flatMap((p, i) => i ? p.coordinates.slice(1) : p.coordinates);
  const geometry = { type: 'LineString', coordinates }, shape = feature(geometry);
  const endpoint = (node, label) => node ? { coordinates: node.geometry.coordinates, nodeId: node.properties.hydroid, objectId: node.id ?? node.properties.objectid, sourceUrl: trace.nodesUrl, classification: label } : null;
  const { records: confluenceRecords = [], ...termination } = candidate.confluence || { kind: candidate.outlet ? 'network_terminus' : 'unverified', nodeId: candidate.outlet?.properties.hydroid };
  const mouth = endpoint(candidate.outlet, candidate.confluence ? 'BoM river confluence' : 'BoM network terminus');
  if (mouth && candidate.confluence) mouth.receivingRiver = candidate.confluence.receivingRiver;
  const headwaterRecords = candidate.headwaterContext?.incoming || [];
  const headwaterNodes = (trace.upstreamNodes || []).filter(n => headwaterRecords.some(f => f.properties.from_node === n.properties.hydroid));
  const namedStart = candidate.verifiedHeadwater ? null : endpoint(candidate.head, 'BoM named reach start (headwater unverified)');
  return {
    geometry, bbox: bbox(shape), records: route, confluenceRecords, headwaterRecords, headwaterNodes, source: candidate.verifiedHeadwater ? endpoint(candidate.head, 'BoM network headwater') : null, mouth,
    graph: { components: 1, branchJunctions: 0, endpoints: [coordinates[0], coordinates.at(-1)] },
    identity: { excludedRecords: records.length - route.length, scopeBufferKm: 2, namedLengthFraction: candidate.nameFraction },
    mainStem: { status: candidate.warnings.length ? 'candidate' : 'published_network', method: 'named_directed_geofabric', namedStart, headwater: { status: candidate.verifiedHeadwater ? 'published_headwater' : 'unverified_named_start', upstreamHydroIds: headwaterRecords.map(f => f.properties.hydroid) }, termination, componentRoutes: [{ endpoints: [coordinates[0], coordinates.at(-1)], lengthKm: length(shape) }], branchDecisions: candidate.decisions, preferencesUrl: trace.preferencesUrl, usedPreferences: trace.preferences.filter(p => candidate.decisions.some(d => d.rule === 'published_preferred_flow' && d.nodeId === p.nodeid)), selectedHydroIds: route.map(f => f.properties.hydroid), limitations: ['BoM terrain-derived flow path, including modelled waterbody connections. Not a surveyed centreline or a navigation route.', 'Endpoint labels refer to published network nodes, not independently surveyed physical source or mouth positions.'] },
    warnings: candidate.warnings,
    status: candidate.warnings.length ? 'partially_resolved' : 'resolved'
  };
}
