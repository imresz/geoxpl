import { randomUUID,createHash } from 'node:crypto';
import { booleanPointInPolygon } from '@turf/turf';
import { publicJson } from './network.js';
import { routeCode,routeSource } from './road-routes.js';

const now=()=>new Date().toISOString();
const normalize=value=>value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
const abbreviations={mt:'mount',rd:'road',st:'street',hwy:'highway',fwy:'freeway',ave:'avenue',av:'avenue',dr:'drive',pde:'parade',ct:'court',cres:'crescent',ln:'lane',blvd:'boulevard'};
export const roadName=value=>normalize(value).replace(/\./g,'').split(' ').map(word=>abbreviations[word]||word).join(' ');
export function routeSearchInput(query) {
  const parts=query.split(',').map(s=>s.trim()).filter(Boolean);
  if(parts.length>2)throw Error('Use a road name and one locality, separated by a comma.');
  const code=routeCode(parts[0]),numeric=code&&/^\d+$/.test(code);
  const historical=/^(?:historical |old )?national route /i.test(parts[0]);
  const scheme=numeric ? /^(?:state|metro|metropolitan) route /i.test(parts[0])?'metropolitan':'unconfirmed_numeric':'alphanumeric';
  const label=code ? numeric?`${scheme==='metropolitan'?'Metropolitan':'Numbered'} Route ${code}`:code:parts[0];
  return {query:query.trim(),name:parts[0],locality:parts[1]||'',code,scheme,label,historical,
    key:code?`code:${scheme}:${code}:${normalize(parts[1]||'')}`:`road:${roadName(parts[0])}:${normalize(parts[1]||'')}`};
}

export function createRouteDiscoveryTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS route_road_names(revision_id TEXT NOT NULL,segment_key TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(revision_id,segment_key));
    CREATE INDEX IF NOT EXISTS route_road_names_name ON route_road_names(name);
    CREATE TABLE IF NOT EXISTS route_discoveries(id TEXT PRIMARY KEY,search_key TEXT NOT NULL UNIQUE,input TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,attempts INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS route_discovery_revisions(id TEXT PRIMARY KEY,discovery_id TEXT NOT NULL REFERENCES route_discoveries(id),data TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS route_discovery_indexed(revision_id TEXT PRIMARY KEY);`);
}

export function indexRouteNames(db,revisionId) {
  const insert=db.prepare('INSERT OR IGNORE INTO route_road_names VALUES(?,?,?)');
  for(const row of db.prepare("SELECT segment_key,json_extract(data,'$.roadName') AS name FROM route_memberships WHERE revision_id=?").iterate(revisionId)) {
    if(row.name&&row.name!=='Unnamed road')insert.run(revisionId,row.segment_key,roadName(row.name));
  }
  db.prepare('INSERT OR IGNORE INTO route_discovery_indexed VALUES(?)').run(revisionId);
}
export function backfillRouteNames(db) {
  for(const row of db.prepare(`SELECT r.revision_id FROM route_membership_revisions r
    WHERE NOT EXISTS(SELECT 1 FROM route_discovery_indexed i WHERE i.revision_id=r.revision_id)`).all()) {
    db.exec('BEGIN IMMEDIATE');
    try{indexRouteNames(db,row.revision_id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  }
}

export function namedRouteMatches(store,input,records) {
  const keys=records&&new Set(records.map(r=>`vicmap:tr_road:${r.pfi}`));
  const ids=new Set();
  for(const row of store.db.prepare(`SELECT n.segment_key,f.id FROM route_road_names n JOIN features f ON f.id=(
      SELECT r.feature_id FROM route_membership_revisions r WHERE r.revision_id=n.revision_id)
    JOIN jobs j ON j.id=f.job_id WHERE n.name=? AND f.active=1 AND j.superseded_by IS NULL
      AND n.revision_id=(SELECT d.id FROM derivations d WHERE d.feature_id=f.id ORDER BY d.rowid DESC LIMIT 1)`).all(roadName(input.name))) {
    if(!keys||keys.has(row.segment_key))ids.add(row.id);
  }
  return [...ids].map(id=>store.feature(id)).filter(Boolean);
}

const parseRow=row=>row?{id:row.id,input:JSON.parse(row.input),state:row.state,data:JSON.parse(row.data),attempts:row.attempts,created:row.created,updated:row.updated}:null;
export const findRouteDiscovery=(store,input)=>parseRow(store.db.prepare('SELECT * FROM route_discoveries WHERE search_key=?').get(input.key));
export const getRouteDiscovery=(store,id)=>parseRow(store.db.prepare('SELECT * FROM route_discoveries WHERE id=?').get(id));
export const listRouteDiscoveries=store=>store.db.prepare('SELECT * FROM route_discoveries ORDER BY updated DESC').all().map(parseRow);
export function queueRouteDiscovery(store,input,{retry=false}={}) {
  if(input.historical||(!input.code&&!input.locality))throw Error('Research needs a supported route code or a road name and locality. Historical National Route 1 is separate.');
  const old=findRouteDiscovery(store,input);
  if(old&&!retry)return old;
  if(old&&['queued','running'].includes(old.state))return old;
  if(old&&Date.now()-Date.parse(old.updated)<300000)throw Error('Please wait five minutes before requesting another source check.');
  if(store.db.prepare("SELECT COUNT(*) AS n FROM route_discoveries WHERE state IN ('queued','running')").get().n>=20)throw Error('The route research queue is full. Please try later.');
  const timestamp=now(),id=old?.id||randomUUID();
  store.db.prepare(`INSERT INTO route_discoveries VALUES(?,?,?,'queued','{}',0,?,?) ON CONFLICT(id) DO UPDATE SET state='queued',updated=excluded.updated`)
    .run(id,input.key,JSON.stringify(input),timestamp,timestamp);
  return getRouteDiscovery(store,id);
}

const quote=value=>`'${value.replaceAll("'","''")}'`;
function sourceRoadNames(name) {
  let variants=[''];
  for(const word of roadName(name).split(' ')) {
    const options=[word,...Object.keys(abbreviations).filter(key=>abbreviations[key]===word)];
    variants=variants.flatMap(prefix=>options.map(value=>`${prefix} ${value}`.trim()));
    if(variants.length>64)throw Error('Road name has too many abbreviation variants.');
  }
  return variants.map(value=>quote(value.toUpperCase())).join(',');
}
export async function lookupRoadLocality(input,load=publicJson) {
  const records=[],requests=[],ids=new Set();let total;
  for(let offset=0;offset===0||offset<total;offset=records.length) {
    const params=new URLSearchParams({service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:tr_road',
      outputFormat:'application/json',count:'500',startIndex:String(offset),sortBy:'pfi A',
      propertyName:'pfi,ezi_road_name,left_locality,right_locality,route_no',
      cql_filter:`ezi_road_name IN (${sourceRoadNames(input.name)}) AND (left_locality=${quote(input.locality.toUpperCase())} OR right_locality=${quote(input.locality.toUpperCase())})`});
    const url=`${routeSource.url}?${params}`;requests.push(url);
    const page=await load(url,4_000_000);
    if(page.type!=='FeatureCollection'||!Number.isSafeInteger(page.numberMatched)||page.numberMatched<0||page.numberMatched>5000||
      (total!==undefined&&total!==page.numberMatched)||!Array.isArray(page.features)||page.features.length>500||page.numberReturned!==page.features.length||
      offset+page.features.length>page.numberMatched||(!page.features.length&&page.numberMatched>offset))throw Error('Vicmap returned incomplete road-name results.');
    total=page.numberMatched;
    for(const f of page.features) {
      const p=f.properties;
      if(!p||!Number.isSafeInteger(p.pfi)||p.pfi<1||ids.has(p.pfi)||roadName(p.ezi_road_name||'')!==roadName(input.name)||
        ![p.left_locality,p.right_locality].some(l=>typeof l==='string'&&normalize(l)===normalize(input.locality)))throw Error('Vicmap road-name or locality evidence did not match the request.');
      ids.add(p.pfi);records.push({pfi:p.pfi,name:p.ezi_road_name,localities:[...new Set([p.left_locality,p.right_locality].filter(Boolean))],code:p.route_no||null});
    }
    if(records.length===total)break;
  }
  return {provider:'Vicmap Transport',licence:'CC BY 4.0',attribution:routeSource.attribution,requests,records,
    note:'Locality matched against Vicmap left/right locality fields and retained road identifiers. A road tag is not proof of current signing.'};
}

export const overpassEndpoint='https://overpass.kumi.systems/api/interpreter';
export async function lookupPublicRoute(input,boundary,load=publicJson) {
  if(input.locality)return lookupLocalPublicRoute(input,boundary,load);
  const token=`(^|;[ ]*)${input.code}([ ]*;|$)`,bounds='(-39.3,140.9,-34,150.1)';
  const clauses=['ref','old_ref','proposed:ref'].flatMap(key=>[
    `way["highway"]["${key}"~"${token}"]${bounds};`,`rel["route"="road"]["${key}"~"${token}"]${bounds};`]);
  const query=`[out:json][timeout:15][maxsize:33554432];(${clauses.join('')});out meta center 1001;`;
  const url=`${overpassEndpoint}?${new URLSearchParams({data:query})}`;
  const payload=await load(url,5_000_000);
  if(payload.remark||!Array.isArray(payload.elements)||payload.elements.length>1000)throw Error('The public source returned incomplete or oversized results.');
  const records=[],seen=new Set(),matches=value=>typeof value==='string'&&value.split(';').some(v=>v.trim().toUpperCase()===input.code);
  for(const e of payload.elements) {
    if(!['way','relation'].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<1||!e.tags||seen.has(`${e.type}:${e.id}`))throw Error('Invalid public-source record.');
    seen.add(`${e.type}:${e.id}`);
    if(!Number.isFinite(e.center?.lon)||!Number.isFinite(e.center?.lat))throw Error('Public-source record has no usable location.');
    if(!booleanPointInPolygon([e.center.lon,e.center.lat],boundary))continue;
    const claims=['ref','old_ref','proposed:ref'].filter(key=>matches(e.tags[key]));
    if(!claims.length)throw Error('Public-source route code did not match.');
    records.push({id:e.id,type:e.type,name:String(e.tags.name||'Unnamed road').slice(0,200),version:e.version,timestamp:e.timestamp,
      url:`https://www.openstreetmap.org/${e.type}/${e.id}`,claims:claims.map(field=>({field,value:e.tags[field],
        status:field==='old_ref'?'reported_historical':field==='proposed:ref'?'reported_proposed':'reported_assignment'})),
      tags:Object.fromEntries(['name','ref','old_ref','proposed:ref','source','source:ref','note','check_date'].filter(k=>typeof e.tags[k]==='string').map(k=>[k,e.tags[k].slice(0,2000)]))});
  }
  return {provider:'OpenStreetMap contributors',licence:'ODbL 1.0',attribution:'© OpenStreetMap contributors',requests:[url],
    sourceUrl:'https://www.openstreetmap.org/copyright',records,snapshotAt:payload.osm3s?.timestamp_osm_base,
    note:'Publicly reported tags, not an official designation or verified signing. This is a bounded Victoria metadata search, not a complete alignment. Numeric tags do not identify a metropolitan numbering scheme. No geometry has been published.'};
}

async function lookupLocalPublicRoute(input,boundary,load) {
  const params=new URLSearchParams({service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:tr_road',
    outputFormat:'application/json',srsName:'EPSG:4326',count:'1000',propertyName:'geom,pfi,left_locality,right_locality',
    cql_filter:`left_locality=${quote(input.locality.toUpperCase())} OR right_locality=${quote(input.locality.toUpperCase())}`});
  const localityUrl=`${routeSource.url}?${params}`,page=await load(localityUrl,10_000_000);
  if(page.type!=='FeatureCollection'||!Number.isSafeInteger(page.numberMatched)||page.numberMatched<1||page.numberMatched>1000||
    !Array.isArray(page.features)||page.features.length!==page.numberMatched||page.numberReturned!==page.features.length||
    !/4326|CRS84/.test(page.crs?.properties?.name||''))throw Error('Locality coverage is incomplete or too large.');
  const coords=page.features.flatMap(f=>{
    if(![f.properties?.left_locality,f.properties?.right_locality].some(v=>typeof v==='string'&&normalize(v)===normalize(input.locality)))throw Error('Locality record did not match.');
    if(f.geometry?.type==='LineString')return f.geometry.coordinates;
    if(f.geometry?.type==='MultiLineString')return f.geometry.coordinates.flat();
    throw Error('Invalid locality geometry.');
  });
  if(!coords.length||coords.some(c=>!Array.isArray(c)||c.length!==2||!c.every(Number.isFinite)))throw Error('Invalid locality coverage.');
  const bounds=coords.reduce((b,c)=>[Math.min(b[0],c[0]),Math.min(b[1],c[1]),Math.max(b[2],c[0]),Math.max(b[3],c[1])],[Infinity,Infinity,-Infinity,-Infinity]);
  if(bounds[2]-bounds[0]>.12||bounds[3]-bounds[1]>.10||!coords.some(c=>booleanPointInPolygon(c,boundary)))throw Error('Locality is too large for a bounded source check.');
  const cx=(bounds[0]+bounds[2])/2,cy=(bounds[1]+bounds[3])/2;
  const sample=[Math.max(bounds[0],cx-.0125),Math.max(bounds[1],cy-.01),Math.min(bounds[2],cx+.0125),Math.min(bounds[3],cy+.01)];
  const mapUrl=`https://api.openstreetmap.org/api/0.6/map.json?bbox=${sample.join(',')}`;
  const payload=await load(mapUrl,15_000_000);
  if(payload.error||!Array.isArray(payload.elements)||payload.elements.length>100000)throw Error('Incomplete public map response.');
  const nodes=new Map(payload.elements.filter(e=>e.type==='node'&&Number.isFinite(e.lon)&&Number.isFinite(e.lat)).map(e=>[e.id,[e.lon,e.lat]]));
  const matches=v=>typeof v==='string'&&v.split(';').some(t=>t.trim().toUpperCase()===input.code);
  const records=payload.elements.filter(e=>e.type==='way'&&e.tags?.highway&&['ref','old_ref','proposed:ref'].some(k=>matches(e.tags[k]))).map(e=>{
    if(!Number.isSafeInteger(e.id)||!Array.isArray(e.nodes))throw Error('Invalid public road record.');
    const locations=e.nodes.map(id=>nodes.get(id)).filter(Boolean);
    if(!locations.some(c=>booleanPointInPolygon(c,boundary)))return null;
    return {id:e.id,type:e.type,name:String(e.tags.name||'Unnamed road').slice(0,200),version:e.version,timestamp:e.timestamp,
      url:`https://www.openstreetmap.org/way/${e.id}`,claims:['ref','old_ref','proposed:ref'].filter(k=>matches(e.tags[k])).map(field=>({field,value:e.tags[field],
        status:field==='old_ref'?'reported_historical':field==='proposed:ref'?'reported_proposed':'reported_assignment'})),
      tags:Object.fromEntries(['name','ref','old_ref','proposed:ref','source','source:ref','note','check_date'].filter(k=>typeof e.tags[k]==='string').map(k=>[k,e.tags[k].slice(0,2000)]))};
  }).filter(Boolean);
  return {provider:'OpenStreetMap contributors',licence:'ODbL 1.0',attribution:'© OpenStreetMap contributors',sourceUrl:'https://www.openstreetmap.org/copyright',
    requests:[localityUrl,mapUrl],records,localityBounds:bounds,sampleBounds:sample,
    note:`Public tags in a small central sample of ${input.locality}, located using Vicmap road records. Nearby roads may be included. This does not cover the whole locality or route and is not an official assignment. No geometry has been published.`};
}

export async function runRouteDiscovery(store,id,{load=publicJson,boundary}={}) {
  const row=getRouteDiscovery(store,id);if(!row||row.state!=='queued')return;
  const timestamp=now();
  // A durable attempt claim also rate-limits restarts and explicit retries.
  if(store.db.prepare("SELECT COUNT(*) AS n FROM route_discovery_revisions WHERE created>? AND json_extract(data,'$.state')='running'").get(new Date(Date.now()-3600000).toISOString()).n>=10)return;
  store.db.prepare("UPDATE route_discoveries SET state='running',attempts=attempts+1,updated=? WHERE id=?").run(timestamp,id);
  const revisionId=randomUUID();
  store.db.prepare('INSERT INTO route_discovery_revisions VALUES(?,?,?,?)').run(revisionId,id,JSON.stringify({state:'running',input:row.input}),timestamp);
  let data,state;
  try {
    if(row.input.code&&!boundary)throw Error('Victorian boundary is unavailable.');
    const evidence=await (row.input.code?lookupPublicRoute(row.input,boundary,load):lookupRoadLocality(row.input,load));
    state=evidence.records.length?'available':'no_match';data={...evidence,retrievedAt:now(),
      checksum:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
      coverage:'No mapped extent',designation:row.input.code?(evidence.records.length?'Public-source reports; unverified':'No assignment found in this source'):'Road/locality evidence only'};
  }catch(error) {state='unavailable';data={retrievedAt:now(),error:String(error.message).slice(0,500),message:'The source check could not finish. This does not mean the route is absent. An administrator can retry after five minutes.'};}
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('UPDATE route_discoveries SET state=?,data=?,updated=? WHERE id=?').run(state,JSON.stringify(data),now(),id);
    store.db.prepare('INSERT INTO route_discovery_revisions VALUES(?,?,?,?)').run(randomUUID(),id,JSON.stringify({state,input:row.input,data}),now());
    store.db.exec('COMMIT');
  }catch(e){store.db.exec('ROLLBACK');throw e;}
}

export function routeDiscoveryView(store,row,{history=false}={}) {
  if(!row)return null;
  const view={...row};
  if(history)view.history=store.db.prepare('SELECT id,data,created FROM route_discovery_revisions WHERE discovery_id=? ORDER BY rowid DESC').all(row.id).map(r=>({id:r.id,created:r.created,...JSON.parse(r.data)}));
  return view;
}
