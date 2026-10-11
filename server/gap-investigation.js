import { createHash } from 'node:crypto';
import { bbox, buffer, point, distance, booleanIntersects, lineString, polygonToLine, nearestPointOnLine, coordEach, lineIntersect, featureCollection } from '@turf/turf';
import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { featureSearchTerms, now } from './store.js';
import { publicJson } from './network.js';
import { research } from './research.js';
import { contextualSource } from './source-selection.js';

export const gapVersion = 'terminal-gap/2';
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
export async function checkGapLayer(source, input, anchor, load = publicJson, progress = async()=>{}) {
  if (!numericLayer(source.url) || source.format !== 'arcgis') return {source, status:'unsupported', message:'This gap checker supports numeric ArcGIS layers only.'};
  const requests = [], base = source.url.replace(/\/$/,'');
  const fetchData = async url => { requests.push(url); const d = await load(url); if (d.error) throw Error(d.error.message || 'Source query failed.'); return d; };
  try {
  const meta = await fetchData(`${base}?f=json`);
  const fields = meta.fields?.map(f => f.name) || [];
  if (![source.nameField,source.idField].every(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) && fields.includes(f))) throw Error('Configured identifier or name field is missing.');
  const polygon = ['esriGeometryPolygon'].includes(meta.geometryType);
  if (!polygon && meta.geometryType !== 'esriGeometryPolyline') return {source,status:'unsupported',requests,message:'Not a channel or waterbody geometry layer.'};
  const bounds = bbox(buffer(point(anchor.coordinates), input.radiusKm, {units:'kilometers'}));
  const terms = featureSearchTerms(input.targetName,'waterbody');
  const waterbodyContext=polygon&&(contextualSource(source)||/waterbod|wetland|lake/i.test(source.name));
  const where = polygon&&!waterbodyContext ? `UPPER(${source.nameField}) IN (${terms.map(t=>`'${t.toUpperCase().replaceAll("'","''")}'`).join(',')})` : '1=1';
  const ids=new Set(),expected=new Set(),cells=[{bounds,depth:0}],spatialQueries=[];
  while(cells.length) {
    if(spatialQueries.length>=85)throw Error('Spatial subdivision exceeds 85 queries; coverage is incomplete.');
    const cell=cells.shift(),[xmin,ymin,xmax,ymax]=cell.bounds;
    const params = new URLSearchParams({f:'json',where,geometry:JSON.stringify({xmin,ymin,xmax,ymax,spatialReference:{wkid:4326}}),geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects',returnIdsOnly:'true'});
    const data=await fetchData(`${base}/query?${params}`);
    const returned=data.objectIds===null&&typeof data.objectIdFieldName==='string'?[]:data.objectIds;
    if(!Array.isArray(returned)||returned.some(id=>!Number.isSafeInteger(id)||id<0))throw Error('Incomplete or invalid spatial ID response.');
    const split=data.exceededTransferLimit||returned.length>1000;
    spatialQueries.push({bounds:cell.bounds,depth:cell.depth,returned:returned.length,split});
    if(split) {
      if(!data.exceededTransferLimit)for(const id of returned)expected.add(id);
      if(cell.depth>=4)throw Error('Spatial subdivision remains incomplete at maximum depth.');
      const mx=(xmin+xmax)/2,my=(ymin+ymax)/2;
      cells.push(...[[xmin,ymin,mx,my],[mx,ymin,xmax,my],[xmin,my,mx,ymax],[mx,my,xmax,ymax]].map(bounds=>({bounds,depth:cell.depth+1})));
    } else for(const id of returned)ids.add(id);
    if(ids.size>10000)throw Error('Spatial check exceeds 10,000 unique records; coverage is incomplete.');
    await progress(`Spatial search: ${spatialQueries.length} cells checked, ${ids.size} unique records`);
  }
  if([...expected].some(id=>!ids.has(id)))throw Error('Subdivision omitted previously returned IDs; coverage is incomplete.');
  const unique=[...ids].sort((a,b)=>a-b);
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
    for (const f of data.features) { validGeometry(f); coordEach(f,()=>{if(++vertices>500000)throw Error('Spatial check exceeds 500,000 vertices; coverage is incomplete.');}); if (polygon&&!waterbodyContext && !terms.includes(String(f.properties?.[source.nameField]||'').trim().toLowerCase())) throw Error('Waterbody name does not match the destination.'); }
    records.push(...data.features);
    await progress(`Downloading spatial records: ${records.length} of ${unique.length}`);
  }
  return {source,status:'checked',kind:polygon?'waterbody':'channels',waterbodyContext,checkedAt:now(),requests,total:records.length,checksum:digest(records),records,spatialQueries,bounds,
    classifications:(meta.fields||[]).filter(f=>f.domain?.codedValues).map(f=>({field:f.name,values:f.domain.codedValues}))};
  } catch(error) {error.requests=requests;throw error;}
}

function paths(records) {
  return records.flatMap(f => f.geometry.type === 'LineString' ? [{record:f,coordinates:f.geometry.coordinates}] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.map(coordinates=>({record:f,coordinates})) : []);
}

export function assessGap(checks, anchor, input) {
  const terms=featureSearchTerms(input.targetName,'waterbody');
  const bodies=checks.filter(c=>c.status==='checked'&&c.kind==='waterbody').flatMap(c=>c.records.map(record=>({source:c.source,record,queryUrl:c.requests.at(-1),contextual:c.waterbodyContext,
    classification:(c.classifications||[]).flatMap(d=>d.values.filter(v=>v.code===record.properties?.[d.field]).map(v=>v.name)).join('; ')})));
  const targets=bodies.filter(t=>terms.includes(String(t.record.properties?.[t.source.nameField]||'').trim().toLowerCase()));
  const channels = checks.filter(c=>c.status==='checked'&&c.kind==='channels'&&c.source.status==='approved');
  const routes = [];
  const lines=channels.flatMap(c=>paths(c.records).map(l=>({...l,source:c.source}))),graph=new Graph.UndirectedGraph(),grid=new Map();
  if(lines.length>20000)throw Error('Combined channel review exceeds 20,000 parts.');
  graph.addNode('anchor');
  const xy=c=>[c[0]*111.32*Math.cos(anchor.coordinates[1]*Math.PI/180),c[1]*110.574];
  let comparisons=0;
  for(let i=0;i<lines.length;i++) {
    const id=String(i),l=lines[i];graph.addNode(id);
    const near=nearestPointOnLine(lineString(l.coordinates),anchor.coordinates);
    if(near.properties.dist<=0.02)graph.addEdge('anchor',id,{gapKm:near.properties.dist});
    for(const endpoint of [l.coordinates[0],l.coordinates.at(-1)]) {
      const [x,y]=xy(endpoint).map(v=>Math.floor(v/0.05));
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const other of grid.get(`${x+dx}:${y+dy}`)||[]) {
        if(++comparisons>2000000)throw Error('Channel endpoint comparison limit exceeded.');
        const km=distance(endpoint,other.endpoint);
        if(other.id!==id&&km<=0.02&&!graph.hasEdge(id,other.id))graph.addEdge(id,other.id,{gapKm:km});
      }
      const key=`${x}:${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push({id,endpoint});
    }
  }
  for (const target of targets) {
    if(booleanIntersects(point(anchor.coordinates),target.record))continue;
    const destination=`target-${routes.length}-${target.source.id}-${target.record.properties?.[target.source.idField]}`;
    graph.mergeNode(destination);
    for(let i=0;i<lines.length;i++)if(booleanIntersects(lineString(lines[i].coordinates),target.record))graph.mergeEdge(String(i),destination);
    const found=bidirectional(graph,'anchor',destination);
    // Target nodes must not become bridges between otherwise disconnected channels.
    graph.dropNode(destination);
    if(!found)continue;
    const path=found.slice(1,-1).map(Number),last=lines[path.at(-1)],entry=lineIntersect(lineString(last.coordinates),polygonToLine(target.record)).features;
    const members=path.map(i=>({sourceId:lines[i].source.id,sourceUrl:lines[i].source.url,id:lines[i].record.properties?.[lines[i].source.idField],name:lines[i].record.properties?.[lines[i].source.nameField]}));
    routes.push({channelSourceId:members[0].sourceId,channelSourceIds:[...new Set(members.map(m=>m.sourceId))],targetSourceId:target.source.id,targetRecord:target.record.properties?.[target.source.idField],recordIds:members.map(m=>m.id),members,
      shorelineIntersections:entry.map(f=>f.geometry.coordinates),endpointToleranceMetres:20,joinGapsKm:found.slice(0,-2).map((id,i)=>graph.getEdgeAttribute(id,found[i+1],'gapKm')||0),
      geometry:{type:'MultiLineString',coordinates:path.map(i=>lines[i].coordinates)},message:'Mapped channel candidate reaches the destination polygon. Endpoint joins allow up to 20 metres; flow direction, named-river membership and the physical entry point still require review.'});
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
  const containing=bodies.filter(t=>t.contextual&&booleanIntersects(point(anchor.coordinates),t.record)).map(t=>({sourceId:t.source.id,sourceUrl:t.source.url,id:t.record.properties?.[t.source.idField],name:String(t.record.properties?.[t.source.nameField]||'').trim()||'Unnamed waterbody',classification:t.classification,status:t.source.status,isDestination:targets.includes(t)}));
  const endpointAssessment={recordedClassification:anchor.classification,containingWaterbodies:containing,relation:containing.some(t=>t.isDestination&&t.status==='approved')?'within_named_destination':routes.length?'mapped_channel_candidate':containing.length?'within_other_waterbody':'unverified',
    physicalMouthVerified:false,message:'A network terminus, a point inside a waterbody and a physical shoreline entry are different claims. No surveyed mouth or seasonal wetland connection is inferred.'};
  const previewFeatures=[...targets.slice(0,10).map(t=>t.record),...routes.slice(0,3).map(r=>({type:'Feature',properties:{},geometry:r.geometry})),...(estimate?[lineString(estimate.coordinates,{label:estimate.label})]:[]),point(anchor.coordinates)];
  let previewVertices=0;for(const f of previewFeatures)coordEach(f,()=>previewVertices++);
  return {targets:targets.map(t=>({sourceId:t.source.id,name:t.record.properties?.[t.source.nameField],id:t.record.properties?.[t.source.idField],status:t.source.status})),routes,estimate,endpointAssessment,
    preview:targets.length&&previewVertices<=50000?{collection:featureCollection(previewFeatures),bounds:bbox(featureCollection(previewFeatures))}:undefined,
    previewError:previewVertices>50000?'The preview exceeds 50,000 vertices. Full evidence is retained in the investigation.':undefined,
    message:routes.length?'Mapped connection candidates found; geographic review is required.':targets.length?'Destination polygons found, but no endpoint-connected mapped channel was established.':'No exact-name destination polygon found within the search radius.'};
}

export async function investigateGap(store, job, input, checkpoint, save, options = {}) {
  const load = options.load || publicJson, anchor = gapAnchor(store,job);
  const state = checkpoint?.version===gapVersion ? checkpoint : {version:gapVersion,anchor,checks:[],discovered:[],serviceChecks:[],research:null};
  const persist = async message => { state.message=message; await save(state); };
  const check = async source => {
    if (state.checks.some(c=>c.source.url===source.url)) return;
    await persist(`Checking ${source.name}`);
    try { state.checks.push(await checkGapLayer(source,input,anchor,load,message=>persist(`${source.name}: ${message}`))); }
    catch(error) { state.checks.push({source,status:'failed',message:error.message,requests:error.requests||[]}); }
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
  return {...state,...assessment,applicable:!!assessment.estimate,checkedAt:now(),message:`${assessment.message} Recorded geometry and completion status are unchanged.`};
}
