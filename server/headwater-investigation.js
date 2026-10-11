import { createHash } from 'node:crypto';
import { bbox, featureCollection, point, lineString, length, along, distance, nearestPointOnLine } from '@turf/turf';
import { featureSearchTerms, normalize, now } from './store.js';
import { isGeofabric } from './geofabric.js';
import { checkGapLayer } from './gap-investigation.js';
import { publicJson } from './network.js';
import { sampleHeadwaterTerrain } from './headwater-terrain.js';

export const headwaterVersion = 'headwater-evidence/1';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function headwaterAnchor(store, job) {
  if (job.type !== 'river') throw Error('Headwater assessment supports rivers only.');
  const features = store.jobFeatures(job.id).filter(f => f.mainStem?.namedStart);
  if (features.length !== 1) throw Error('A single river with an unverified named start is required.');
  const feature = features[0], evidence = feature.evidence.find(e => e.role === 'named_start');
  const row = evidence && store.db.prepare('SELECT * FROM imports WHERE id=?').get(evidence.importId);
  const source = row && store.sources().find(s => s.id === row.source_id);
  if (!row || !source || source.status !== 'approved' || !isGeofabric(source)) throw Error('The current approved Geofabric snapshot is required.');
  const metadata = JSON.parse(row.metadata), context = metadata.geofabric?.headwaterContexts?.find(c => c.nodeId === feature.mainStem.namedStart.nodeId);
  if (!context?.incoming.length || context.incoming.length > 16) throw Error('Between one and sixteen published upstream alternatives are required.');
  return { featureId: feature.id, ...feature.mainStem.namedStart, downstreamHydroId:feature.mainStem.selectedHydroIds[0], source, importId: row.id, context,
    checksum: digest({ geometry: feature.geometry, context, importChecksum: row.checksum }) };
}

function coordinates(record) {
  const p = record.properties, c = record.geometry?.coordinates;
  if (record.geometry?.type !== 'LineString' || ![1,2].includes(p.flowdir) || !Array.isArray(c) || c.length < 2 || c.length > 100000 || c.some(v => v.length < 2 || !v.slice(0,2).every(Number.isFinite) || Math.abs(v[0]) > 180 || Math.abs(v[1]) > 90)) throw Error('Invalid or undirected upstream geometry.');
  return p.flowdir === 2 ? [...c].reverse() : c;
}

export function assessHeadwaters(anchor, branches, checks, preferences, terms, terrain) {
  const mapped = checks.filter(c => c.status === 'checked' && c.kind === 'channels' && c.source.status === 'approved');
  const alternatives = branches.map(branch => {
    const record = branch.records[0], p = record.properties, c = coordinates(record), shape = lineString(c), km = length(shape);
    const name = String(p.name || '').trim();
    const excluded = !!name && !terms.includes(normalize(name));
    const samples = Array.from({ length: 9 }, (_,i) => along(shape, km*(i+1)/10).geometry.coordinates);
    const corroboration = mapped.flatMap(check => check.records.filter(f => terms.includes(normalize(String(f.properties?.[check.source.nameField] || '')))).flatMap(f => {
      const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      const matches = samples.filter(s => parts.some(c => nearestPointOnLine(lineString(c), s).properties.dist <= 0.03)).length;
      return matches >= 5 ? [{ sourceId:check.source.id, sourceUrl:check.source.url, recordId:f.properties?.[check.source.idField], matchedSamples:matches, totalSamples:9, toleranceMetres:30 }] : [];
    }));
    const prefs = preferences.filter(v => v.nodeid === p.from_node || v.nodeid === anchor.nodeId);
    const linksAgree = p.to_node === anchor.nodeId && p.nextdownid === anchor.downstreamHydroId && distance(c.at(-1), anchor.coordinates) <= 0.02;
    const profile = terrain?.profiles?.find(v => v.hydroId === p.hydroid);
    return { hydroId:p.hydroid, name:name || 'Unnamed upstream stream', excludedNamedTributary:excluded,
      namedMapping:terms.includes(normalize(name)) ? 'same_named_network_segment' : corroboration.length ? 'spatial_name_corroboration' : excluded ? 'different_named_tributary' : 'no_name_corroboration',
      corroboration, publishedPreferences:prefs, continuity:{ ...branch.continuity, joinsNamedStart:linksAgree, recordIds:branch.records.map(f=>f.properties.hydroid), lengthKm:branch.records.reduce((sum,f)=>sum+length(lineString(coordinates(f))),0) },
      terrain:profile || { status:'unavailable', message:terrain?.message || 'No approved elevation profile available.' },
      interpretation:excluded ? 'Do not extend the requested river along a differently named tributary.' : 'Possible continuation only. Name overlap, preferred downstream flow and uphill terrain do not independently establish headwater identity.' };
  });
  const supported = alternatives.filter(a => !a.excludedNamedTributary && a.continuity.joinsNamedStart && a.namedMapping === 'same_named_network_segment' && a.continuity.status === 'published_headwater' && a.continuity.allSameName);
  const conflict = alternatives.some(a => !a.excludedNamedTributary && a.corroboration.length && !supported.includes(a));
  return { alternatives, assessment:supported.length === 1 && !conflict ? 'identity_supported_candidate' : 'ambiguous',
    preferredCandidateHydroId:supported.length === 1 && !conflict ? supported[0].hydroId : null,
    applicable:false, message:'Headwater alternatives assessed. No upstream geometry has been appended and no physical source has been certified.',
    limitations:['Published flow preferences select downstream edges, not the identity of an upstream tributary.', 'Spatial name overlap is corroboration, not an identity match or surveyed source.', 'Elevation profiles are local terrain diagnostics, not catchment boundaries. Longer, higher or steeper branches are not automatically preferred.'] };
}

export async function investigateHeadwaters(store, job, checkpoint, save, options = {}) {
  const load = options.load || publicJson, anchor = headwaterAnchor(store,job);
  const state = checkpoint?.version === headwaterVersion ? checkpoint : { version:headwaterVersion, anchor, branches:[], checks:[], requests:[] };
  const persist = async message => { state.message = message; await save(state); };
  const base = anchor.source.url.replace(/\/6$/, '');
  const query = async (layer,field,ids,spatial=true) => {
    if (state.requests.length >= 256) throw Error('Upstream evidence exceeds 256 network queries.');
    if (ids.some(v => !Number.isSafeInteger(v) || v <= 0)) throw Error('Invalid upstream network ID.');
    const params = new URLSearchParams({ f:spatial?'geojson':'json', where:`${field} IN (${[...new Set(ids)].join(',')})`, outFields:'*', outSR:'4326', returnGeometry:String(spatial) });
    const url = `${base}/${layer}/query?${params}`; state.requests.push(url);
    const data = await load(url);
    if (data.error || data.exceededTransferLimit || !Array.isArray(data.features) || data.features.length > 1000) throw Error('Incomplete upstream network query.');
    if (data.crs && !/4326|CRS84/.test(JSON.stringify(data.crs))) throw Error('Upstream evidence is not WGS84.');
    return spatial ? data.features : data.features.map(f => f.attributes);
  };
  const terms = featureSearchTerms(job.query,'river',store.featureSettings(job.id).aliases);
  for (const initial of anchor.context.incoming) {
    if (state.branches.some(b=>b.records[0].properties.hydroid === initial.properties.hydroid)) continue;
    const records = [initial], seen = new Set([initial.properties.hydroid]);
    let continuity = {status:'bounded', allSameName:terms.includes(normalize(String(initial.properties.name||'')))};
    for (let depth=0;depth<32;depth++) {
      const current = records.at(-1), p = current.properties, c = coordinates(current);
      const nodes = await query(3,'hydroid',[p.from_node]);
      if(nodes.length>1||nodes.some(n=>n.properties.hydroid!==p.from_node))throw Error('Upstream node query returned unexpected records.');
      const node = nodes.find(n=>n.properties.hydroid===p.from_node);
      if (!node || node.geometry?.type!=='Point' || distance(node.geometry.coordinates,c[0])>0.02) {continuity.status='missing_or_mismatched_node';break;}
      if (node.properties.ahgfftype===9) {continuity.status='published_headwater';continuity.headNodeId=p.from_node;break;}
      if (distance(c[0],anchor.coordinates)>20) {continuity.status='20km_limit';break;}
      const incoming = await query(6,'to_node',[p.from_node]);
      if (incoming.some(f=>f.properties.to_node!==p.from_node)) throw Error('Upstream query returned unrelated node records.');
      if (incoming.length!==1) {continuity.status=incoming.length?'upstream_junction':'no_incoming_records';continuity.upstreamAlternativeIds=incoming.map(f=>f.properties.hydroid);break;}
      const next = incoming[0], nc = coordinates(next);
      if (seen.has(next.properties.hydroid)) {continuity.status='cycle';break;}
      if (next.properties.nextdownid!==p.hydroid || distance(nc.at(-1),c[0])>0.02) {continuity.status='inconsistent_link';break;}
      seen.add(next.properties.hydroid);records.push(next);
      continuity.allSameName &&= terms.includes(normalize(String(next.properties.name||'')));
    }
    if ([...state.branches.flatMap(b=>b.records),...records].reduce((n,r)=>n+coordinates(r).length,0)>500000) throw Error('Upstream continuity exceeds 500,000 vertices.');
    state.branches.push({records,continuity});
    await persist(`Upstream continuity checked for HydroID ${initial.properties.hydroid}`);
  }
  if (!state.preferences) {
    try { state.preferences = await query(37,'nodeid',[anchor.nodeId,...anchor.context.incoming.map(f=>f.properties.from_node)],false); }
    catch(error) {state.preferences=[];state.preferenceError=error.message;}
    await persist('Published flow preferences checked');
  }
  for (const source of store.sources().filter(s=>s.status==='approved'&&s.type==='river'&&s.format==='arcgis'&&!isGeofabric(s))) {
    if (state.checks.some(c=>c.source.id===source.id)) continue;
    try { state.checks.push(await checkGapLayer(source,{targetName:job.query,radiusKm:5},anchor,load,message=>persist(`${source.name}: ${message}`))); }
    catch(error) {state.checks.push({source,status:'failed',message:error.message,requests:error.requests||[]});}
    await persist(`Named mapping checked: ${source.name}`);
  }
  if (!state.terrain) {
    try { state.terrain = await (options.sampleTerrain || sampleHeadwaterTerrain)(anchor.context.incoming,store.sources(),options.terrainOptions); }
    catch(error) {state.terrain={status:'unavailable',message:error.message};}
    await persist('Terrain profiles checked');
  }
  const result = assessHeadwaters(anchor,state.branches,state.checks,state.preferences,terms,state.terrain);
  const preview = featureCollection(anchor.context.incoming.map(r=>lineString(coordinates(r),{hydroId:r.properties.hydroid})).concat(point(anchor.coordinates)));
  const vertices=anchor.context.incoming.reduce((n,r)=>n+r.geometry.coordinates.length,0);
  return {...state,...result,preview:vertices<=50000?{collection:preview,bounds:bbox(preview)}:undefined,previewError:vertices>50000?'Headwater preview exceeds 50,000 vertices. Evidence remains available.':undefined,checkedAt:now()};
}
