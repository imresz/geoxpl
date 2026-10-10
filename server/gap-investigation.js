import { createHash } from 'node:crypto';
import { bbox, buffer, point, distance, booleanIntersects, lineString, polygonToLine, nearestPointOnLine, coordEach } from '@turf/turf';
import { featureSearchTerms, now } from './store.js';
import { publicJson } from './network.js';
import { research } from './research.js';

export const gapVersion = 'terminal-gap/1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const position = c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
const numericLayer = url => /\/(?:MapServer|FeatureServer)\/\d+$/.test(url);

export function gapAnchor(store, job) {
  if (job.type !== 'river') throw Error('Terminal-gap investigation currently supports rivers only.');
  const features = store.jobFeatures(job.id).filter(f => position(f.mouth?.coordinates));
  if (features.length !== 1) throw Error('A single current river result with a recorded downstream endpoint is required.');
  const f = features[0];
  return { featureId:f.id, coordinates:f.mouth.coordinates.slice(0,2), classification:f.mouth.classification, checksum:digest({geometry:f.geometry,mouth:f.mouth}), warnings:f.warnings };
}

function validGeometry(f) {
  let n = 0;
  if (!['LineString','MultiLineString','Polygon','MultiPolygon'].includes(f.geometry?.type)) throw Error('Unsupported candidate geometry.');
  coordEach(f, c => { if (!position(c) || ++n > 100000) throw Error('Invalid or oversized WGS84 geometry.'); });
  if (!n || !bbox(f).every(Number.isFinite)) throw Error('Empty candidate geometry.');
}

// Every record is fetched by ID; a truncated spatial sample cannot support a route finding.
export async function checkGapLayer(source, input, anchor, load = publicJson) {
  if (!numericLayer(source.url) || source.format !== 'arcgis') return {source, status:'unsupported', message:'This gap checker supports numeric ArcGIS layers only.'};
  const requests = [], base = source.url.replace(/\/$/,'');
  const fetchData = async url => { requests.push(url); const d = await load(url); if (d.error) throw Error(d.error.message || 'Source query failed.'); return d; };
  const meta = await fetchData(`${base}?f=json`);
  const fields = meta.fields?.map(f => f.name) || [];
  if (![source.nameField,source.idField].every(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) && fields.includes(f))) throw Error('Configured identifier or name field is missing.');
  const polygon = ['esriGeometryPolygon'].includes(meta.geometryType);
  if (!polygon && meta.geometryType !== 'esriGeometryPolyline') return {source,status:'unsupported',requests,message:'Not a channel or waterbody geometry layer.'};
  const bounds = bbox(buffer(point(anchor.coordinates), input.radiusKm, {units:'kilometers'}));
  const envelope = {xmin:bounds[0],ymin:bounds[1],xmax:bounds[2],ymax:bounds[3],spatialReference:{wkid:4326}};
  const terms = featureSearchTerms(input.targetName,'waterbody');
  const where = polygon ? `UPPER(${source.nameField}) IN (${terms.map(t=>`'${t.toUpperCase().replaceAll("'","''")}'`).join(',')})` : '1=1';
  const params = new URLSearchParams({f:'json',where,geometry:JSON.stringify(envelope),geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects',returnIdsOnly:'true'});
  const ids = await fetchData(`${base}/query?${params}`);
  if (!Array.isArray(ids.objectIds) || ids.exceededTransferLimit || ids.objectIds.some(id=>!Number.isSafeInteger(id)||id<0)) throw Error('Incomplete or invalid spatial ID response.');
  const unique = [...new Set(ids.objectIds)].sort((a,b)=>a-b);
  if (unique.length > 1000) throw Error('Over 1,000 nearby records. Reduce the search radius.');
  const records = [];
  let vertices=0;
  for (let offset=0;offset<unique.length;offset+=100) {
    const batch = unique.slice(offset,offset+100);
    const p = new URLSearchParams({f:'geojson',objectIds:batch.join(','),outFields:'*',outSR:'4326',returnGeometry:'true'});
    const data = await fetchData(`${base}/query?${p}`);
    if (!Array.isArray(data.features) || data.exceededTransferLimit || data.features.length !== batch.length) throw Error('Missing spatial geometry records.');
    if (data.crs && !/4326|CRS84/.test(JSON.stringify(data.crs))) throw Error('Candidate geometry is not WGS84.');
    const objectField = meta.objectIdField || meta.fields.find(f=>f.type==='esriFieldTypeOID')?.name;
    if (!objectField || new Set(data.features.map(f=>f.properties?.[objectField] ?? f.id)).size !== batch.length || data.features.some(f=>!batch.includes(f.properties?.[objectField] ?? f.id))) throw Error('Spatial records do not match requested IDs.');
    for (const f of data.features) { validGeometry(f); coordEach(f,()=>{if(++vertices>250000)throw Error('Spatial check exceeds 250,000 vertices. Reduce the radius.');}); if (polygon && !terms.includes(String(f.properties?.[source.nameField]||'').trim().toLowerCase())) throw Error('Waterbody name does not match the destination.'); }
    records.push(...data.features);
  }
  return {source,status:'checked',kind:polygon?'waterbody':'channels',checkedAt:now(),requests,total:records.length,checksum:digest(records),records};
}

function paths(records) {
  return records.flatMap(f => f.geometry.type === 'LineString' ? [{record:f,coordinates:f.geometry.coordinates}] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.map(coordinates=>({record:f,coordinates})) : []);
}

export function assessGap(checks, anchor, input) {
  const targets = checks.filter(c=>c.status==='checked'&&c.kind==='waterbody').flatMap(c=>c.records.map(record=>({source:c.source,record,queryUrl:c.requests.at(-1)})));
  const channels = checks.filter(c=>c.status==='checked'&&c.kind==='channels');
  const routes = [];
  for (const target of targets) for (const channel of channels) {
    const lines = paths(channel.records);
    // Undirected endpoint connectivity is evidence for review, never a flow-direction or identity certification.
    const queue = lines.map((l,i)=>({l,i})).filter(({l})=>Math.min(distance(anchor.coordinates,l.coordinates[0]),distance(anchor.coordinates,l.coordinates.at(-1)))<=0.02).map(({i})=>[i]);
    const seen = new Set(queue.map(path=>path[0]));
    while (queue.length) {
      const path = queue.shift(), last = lines[path.at(-1)];
      if (booleanIntersects(lineString(last.coordinates),target.record)) {
        routes.push({channelSourceId:channel.source.id,targetSourceId:target.source.id,targetRecord:target.record.properties?.[target.source.idField],recordIds:path.map(i=>lines[i].record.properties?.[channel.source.idField]),message:'Endpoint-connected mapped channel candidate reaches the destination polygon. Flow direction and named-river identity still require review.'});
        break;
      }
      const ends = [last.coordinates[0],last.coordinates.at(-1)];
      for (let i=0;i<lines.length;i++) if (!seen.has(i) && ends.some(a=>[lines[i].coordinates[0],lines[i].coordinates.at(-1)].some(b=>distance(a,b)<=0.02))) {
        seen.add(i);queue.push([...path,i]);
      }
    }
  }
  const approvedTargets = targets.filter(t=>t.source.status==='approved');
  const distinct = new Map(approvedTargets.map(t=>[digest(t.record.geometry),t]));
  let estimate;
  if (distinct.size === 1 && !routes.length) {
    const target = [...distinct.values()][0];
    if (!booleanIntersects(point(anchor.coordinates),target.record)) {
      const boundary = polygonToLine(target.record);
      const boundaries = boundary.type==='FeatureCollection'?boundary.features:[boundary];
      const nearest = boundaries.map(f=>nearestPointOnLine(f,anchor.coordinates)).sort((a,b)=>a.properties.dist-b.properties.dist)[0];
      if (nearest && nearest.properties.dist <= input.radiusKm) estimate = {coordinates:[anchor.coordinates,nearest.geometry.coordinates.slice(0,2)],label:`Estimated connection to ${input.targetName}`,evidenceUrl:target.queryUrl,evidenceRecord:`${target.source.name}; ${target.source.idField}=${target.record.properties?.[target.source.idField]}; nearest mapped shoreline, not a verified entry point`};
    }
  }
  return {targets:targets.map(t=>({sourceId:t.source.id,name:t.record.properties?.[t.source.nameField],id:t.record.properties?.[t.source.idField],status:t.source.status})),routes,estimate,
    message:routes.length?'Mapped connection candidates found; geographic review is required.':targets.length?'Destination polygons found, but no endpoint-connected mapped channel was established.':'No exact-name destination polygon found within the search radius.'};
}

export async function investigateGap(store, job, input, checkpoint, save, options = {}) {
  const load = options.load || publicJson, anchor = gapAnchor(store,job);
  const state = checkpoint?.version===gapVersion ? checkpoint : {version:gapVersion,anchor,checks:[],discovered:[],serviceChecks:[],research:null};
  const persist = async message => { state.message=message; await save(state); };
  const check = async source => {
    if (state.checks.some(c=>c.source.url===source.url)) return;
    await persist(`Checking ${source.name}`);
    try { state.checks.push(await checkGapLayer(source,input,anchor,load)); }
    catch(error) { state.checks.push({source,status:'failed',message:error.message}); }
    await persist(`Checked ${source.name}`);
  };
  const approved = store.sources().filter(s=>s.status==='approved'&&s.type==='river'&&s.format==='arcgis').sort((a,b)=>a.id.localeCompare(b.id));
  for (const source of approved) await check(source);
  const services = [...new Set(approved.filter(s=>numericLayer(s.url)).map(s=>s.url.replace(/\/\d+$/,'')))].slice(0,8);
  for (const url of services) {
    if (state.serviceChecks.some(s=>s.url===url)) continue;
    await persist('Discovering companion waterbody layers');
    try {
      const meta = await load(`${url}?f=json`);
      for (const layer of (meta.layers||[]).filter(l=>Number.isSafeInteger(l.id)&&/waterbod|lake/i.test(l.name)).slice(0,4)) {
        const endpoint = `${url}/${layer.id}`;
        if (store.sources().some(s=>s.url===endpoint&&s.status==='rejected')) continue;
        if (state.discovered.some(s=>s.url===endpoint)) continue;
        const m = await load(`${endpoint}?f=json`), fields=m.fields||[];
        const nameField=fields.find(f=>/^name$|^waterbody_name$/i.test(f.name))?.name, idField=m.objectIdField||fields.find(f=>f.type==='esriFieldTypeOID')?.name;
        if (m.geometryType!=='esriGeometryPolygon'||!nameField||!idField) continue;
        state.discovered.push({name:layer.name,type:'river',format:'arcgis',url:endpoint,nameField,idField,licence:'',attribution:'',version:'',completeness:'unknown',aliases:[],notes:'Companion waterbody layer discovered from registered service metadata. Used only as destination evidence; verify publisher, licence and suitability before approval.'});
      }
      state.serviceChecks.push({url,status:'checked'});
    } catch(error) { state.serviceChecks.push({url,status:'failed',message:error.message}); }
    await persist('Companion layer discovery saved');
  }
  for (const candidate of state.discovered.slice(0,8)) await check(store.sources().find(s=>s.url===candidate.url)||{...candidate,status:'pending'});
  let assessment=assessGap(state.checks,anchor,input);
  if (!assessment.routes.length && input.discover && !state.research) {
    // Save the reservation first: a crash after dispatch must not silently repeat a paid AI request.
    state.research={provider:'interrupted',summary:'AI discovery was reserved but did not finish. Explicit refresh is required to retry.',candidates:[],evidence:[],nextSteps:[]};
    await persist('Discovering alternative official sources with AI');
    try { state.research=await (options.researcher||research)(job,store,`Find mapped evidence connecting the recorded downstream endpoint to ${input.targetName}. Do not invent a connector.`,{gap:{targetName:input.targetName,radiusKm:input.radiusKm,anchor,assessment},checks:state.checks.map(c=>({source:c.source.url,status:c.status,total:c.total,message:c.message}))}); }
    catch(error) { state.research={provider:'system',summary:error.message,candidates:[],evidence:[],nextSteps:['Explicitly refresh discovery after resolving the failure.']}; }
    await persist('AI discovery result saved');
  }
  if (state.research) {
    for (const candidate of state.research.candidates.slice(0,8)) {
      const existing=store.sources().find(s=>s.url===candidate.url);
      if (existing?.status==='rejected') continue;
      if (!state.discovered.some(s=>s.url===candidate.url)) state.discovered.push(candidate);
      await check(existing||{...candidate,status:'pending'});
    }
    assessment=assessGap(state.checks,anchor,input);
  }
  return {...state,...assessment,applicable:!!assessment.estimate,checkedAt:now(),message:`${assessment.message} Recorded geometry and completion status are unchanged.`,preview:undefined};
}
