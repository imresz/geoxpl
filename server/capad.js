import { createHash } from 'node:crypto';
import { area, bbox, feature, featureCollection, coordEach, union } from '@turf/turf';
import { publicJson } from './network.js';
import { featureSearchTerms, normalize, now } from './store.js';

export const capadEndpoint = 'https://gis.environment.gov.au/gispubmap/rest/services/ogc_services/CAPAD/FeatureServer/0';
export const capadVersion = 'capad-national-park/1';
export const capadDate = '2024-06-30';
export const capadWhere = "STATE='VIC' AND TYPE_ABBR='NP' AND TYPE='National Park' AND NRS_PA='Y'";
export const capadSource = {name:'Australian Government CAPAD 2024 - Victorian national parks',type:'national_park',format:'capad',url:capadEndpoint,nameField:'NAME',idField:'OBJECTID',licence:'CC BY 4.0',attribution:'Australian Government Department of Climate Change, Energy, the Environment and Water (CAPAD 2024)',version:'CAPAD 2024; boundaries as at 30 June 2024',completeness:'complete',aliases:[],notes:'Official national snapshot. National parks established in Victoria only; excludes proposed parks and other reserve types. Not a statement of current legal boundaries. Licence: https://www.dcceew.gov.au/sites/default/files/documents/capad-2024-tech-spec.pdf'};
const digest = x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const literal = x=>`'${x.toUpperCase().replaceAll("'","''")}'`;
function approved(source) {
  if(source.status!=='approved'||source.type!=='national_park'||source.format!=='capad'||source.url!==capadEndpoint||source.nameField!=='NAME'||source.idField!=='OBJECTID'||!source.licence?.trim()||!source.attribution?.trim())throw Error('An approved official CAPAD source with licence and attribution is required.');
}
async function queryIds(where,load,requests) {
  const p=new URLSearchParams({f:'json',where,returnIdsOnly:'true'}),url=`${capadEndpoint}/query?${p}`;
  requests.push(url);const data=await load(url);
  const ids=data.objectIds===null&&data.objectIdFieldName==='OBJECTID'?[]:data.objectIds;
  if(data.error||data.exceededTransferLimit||!Array.isArray(ids)||ids.some(n=>!Number.isSafeInteger(n)||n<0)||new Set(ids).size!==ids.length||ids.length>10000)throw Error('CAPAD did not return a complete valid object-ID list.');
  return ids.sort((a,b)=>a-b);
}
function eligible(p) {return p.STATE==='VIC'&&p.TYPE_ABBR==='NP'&&p.TYPE==='National Park'&&p.NRS_PA==='Y';}
async function fetchRecords(ids,geometry,load,requests) {
  const records=[];
  for(let i=0;i<ids.length;i+=20){
    const batch=ids.slice(i,i+20),p=new URLSearchParams({f:geometry?'geojson':'json',objectIds:batch.join(','),outFields:'*',outSR:'4326',returnGeometry:String(geometry)}),url=`${capadEndpoint}/query?${p}`;
    requests.push(url);const data=await load(url,100000000);
    if(data.error||data.exceededTransferLimit||!Array.isArray(data.features)||data.features.length!==batch.length||(data.crs&&!/4326|CRS84/.test(JSON.stringify(data.crs))))throw Error('CAPAD records are missing, truncated or not WGS84.');
    const seen=new Set();
    for(const f of data.features){const p=geometry?f.properties:f.attributes;
      if(!p||!batch.includes(p.OBJECTID)||seen.has(p.OBJECTID)||!eligible(p)||!p.NAME?.trim()||!p.PA_ID?.trim()||!p.PA_PID?.trim())throw Error('CAPAD returned unexpected or ineligible park records.');
      seen.add(p.OBJECTID);records.push(geometry?f:p);
    }
  }
  return records;
}
async function metadata(load) {
  const data=await load(`${capadEndpoint}?f=json`);
  const required=['OBJECTID','NAME','PA_ID','PA_PID','TYPE','TYPE_ABBR','STATE','NRS_PA'];
  if(data.error||data.geometryType!=='esriGeometryPolygon'||!required.every(k=>data.fields?.some(f=>f.name===k))||!/30 June 2024/.test(data.description||''))throw Error('CAPAD service schema or edition changed; review the source before importing.');
  return data;
}
export async function listVictorianNationalParks(source,load=publicJson) {
  approved(source);await metadata(load);const requests=[];
  const records=await fetchRecords(await queryIds(capadWhere,load,requests),false,load,requests);
  const groups=new Map();
  for(const p of records){if(!groups.has(p.PA_ID))groups.set(p.PA_ID,{id:p.PA_ID,name:p.NAME,objectIds:[]});
    const group=groups.get(p.PA_ID);if(normalize(group.name)!==normalize(p.NAME))throw Error('CAPAD park identity has conflicting names.');group.objectIds.push(p.OBJECTID);
  }
  return {parks:[...groups.values()].sort((a,b)=>a.name.localeCompare(b.name)),requests,checksum:digest(records),snapshotDate:capadDate};
}
export async function downloadVictorianNationalParks(source,load=publicJson) {
  approved(source);await metadata(load);const requests=[];
  const records=await fetchRecords(await queryIds(capadWhere,load,requests),true,load,requests);
  const payload={type:'FeatureCollection',features:records};
  return {payload,truncated:false,checksum:digest(payload),metadata:{adapter:capadVersion,snapshotDate:capadDate,retrievedAt:now(),requests,scope:'victoria-national-parks',registryVersion:source.version}};
}
export async function importNationalParks(source,query,load=publicJson,identity={},snapshot) {
  if(snapshot){
    approved(source);
    if(snapshot.checksum!==digest(snapshot.payload)||snapshot.metadata.adapter!==capadVersion||snapshot.metadata.snapshotDate!==capadDate||snapshot.metadata.scope!=='victoria-national-parks'||snapshot.metadata.registryVersion!==source.version||snapshot.truncated)throw Error('Cached CAPAD snapshot is incomplete or changed.');
    const terms=featureSearchTerms(query,'national_park',identity.aliases);
    const parents=new Set(snapshot.payload.features.filter(f=>terms.includes(normalize(f.properties.NAME))).map(f=>f.properties.PA_ID));
    const payload={type:'FeatureCollection',features:snapshot.payload.features.filter(f=>parents.has(f.properties.PA_ID))};
    return {payload,truncated:false,checksum:digest(payload),metadata:{...snapshot.metadata,scope:'selected-national-parks',catalogueChecksum:snapshot.checksum,queryTerms:terms,parentIds:[...parents]}};
  }
  approved(source);await metadata(load);const terms=featureSearchTerms(query,'national_park',identity.aliases),requests=[];
  const where=`${capadWhere} AND UPPER(NAME) IN (${terms.map(literal).join(',')})`;
  const ids=await queryIds(where,load,requests);
  const matches=await fetchRecords(ids,false,load,requests);
  if(matches.some(p=>!terms.includes(normalize(p.NAME))))throw Error('CAPAD names do not match the requested park.');
  // Fetch the whole published identity, not just the first matching parcel or name record.
  const parentIds=[...new Set(matches.map(p=>p.PA_ID))];
  const completeIds=parentIds.length?await queryIds(`${capadWhere} AND PA_ID IN (${parentIds.map(literal).join(',')})`,load,requests):[];
  const records=await fetchRecords(completeIds,true,load,requests);
  if(records.some(f=>!parentIds.includes(f.properties.PA_ID)||!terms.includes(normalize(f.properties.NAME))))throw Error('CAPAD identity/name changed during import.');
  const payload={type:'FeatureCollection',features:records};
  return {payload,truncated:false,checksum:digest(payload),metadata:{adapter:capadVersion,snapshotDate:capadDate,retrievedAt:now(),requests,queryTerms:terms,parentIds}};
}
export function processNationalParks(item) {
  approved(item.source);
  if(item.truncated||item.metadata?.adapter!==capadVersion||item.metadata.snapshotDate!==capadDate)throw Error('A complete validated CAPAD snapshot is required.');
  const groups=new Map();let vertices=0;
  for(const record of item.payload.features){
    const p=record.properties;
    if(!eligible(p)||!['Polygon','MultiPolygon'].includes(record.geometry?.type))throw Error('Invalid CAPAD park classification or geometry.');
    const polygons=record.geometry.type==='Polygon'?[record.geometry.coordinates]:record.geometry.coordinates;
    if(!polygons.length||polygons.some(poly=>!poly.length||poly.some(r=>r.length<4||r[0][0]!==r.at(-1)[0]||r[0][1]!==r.at(-1)[1])))throw Error('CAPAD polygon rings are empty or unclosed.');
    coordEach(record,c=>{if(++vertices>2000000||c.length<2||!c.slice(0,2).every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>90)throw Error('CAPAD geometry exceeds WGS84 or vertex limits.');});
    if(!groups.has(p.PA_ID))groups.set(p.PA_ID,[]);groups.get(p.PA_ID).push(record);
  }
  return [...groups].map(([paId,records])=>{
    const shape=records.length===1?records[0]:union(featureCollection(records));
    if(!shape||!['Polygon','MultiPolygon'].includes(shape.geometry.type))throw Error('CAPAD park parcels could not be combined.');
    const bounds=bbox(shape),areaKm2=area(shape)/1e6;
    if(!bounds.every(Number.isFinite)||!Number.isFinite(areaKm2)||areaKm2<=0)throw Error('CAPAD park has no usable boundary or area.');
    const p=records[0].properties;
    return {sourceId:item.source.id,sourceName:item.source.name,coverage:'complete',spanKm:0,identityRank:3,result:{
      identityKey:`capad:${paId}`,geometry:shape.geometry,bbox:bounds,areaKm2,lengthKm:null,status:'resolved',confidence:'published_snapshot',method:'capad_published_park_boundary',algorithmVersion:capadVersion,warnings:[],
      displayName:`${p.NAME} National Park`,identity:{excludedRecords:0,publisherIdentity:{field:'PA_ID',value:paId,sourceUrl:item.source.url}},
      park:{paId,parcelIds:[...new Set(records.map(r=>r.properties.PA_PID))],officialName:p.NAME,designation:p.TYPE,state:p.STATE,authority:p.AUTHORITY,edition:'CAPAD 2024',boundaryDate:capadDate,retrievedAt:item.metadata.retrievedAt,
        latestGazettal:Math.max(0,...records.map(r=>Number(r.properties.LATEST_GAZ)||0))||null,reportedAreaHa:records.reduce((n,r)=>n+(Number(r.properties.GIS_AREA)||0),0),limitations:['Published boundary snapshot as at 30 June 2024. Later legal boundary changes may not be included.','GIS area is not necessarily the gazetted legal area.']},
      evidence:records.map(r=>({sourceId:item.source.id,sourceName:item.source.name,sourceUrl:item.source.url,licence:item.source.licence,attribution:item.source.attribution,sourceVersion:item.source.version,objectId:String(r.properties.OBJECTID),importId:item.id,checksum:item.checksum,role:'published_park_parcel',paId,parcelId:r.properties.PA_PID}))
    }};
  });
}
