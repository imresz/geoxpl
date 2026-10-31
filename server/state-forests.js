import { createHash } from 'node:crypto';
import { area, bbox, coordEach, featureCollection, union } from '@turf/turf';
import { publicJson } from './network.js';
import { normalize, featureSearchTerms, now } from './store.js';

export const forestEndpoint='https://opendata.maps.vic.gov.au/geoserver/wfs';
export const forestVersion='victorian-state-forest/1';
export const forestSource={name:'Victorian state forests - PLM25',type:'state_forest',format:'vic-state-forest',url:forestEndpoint,nameField:'name',idField:'plm_id',licence:'CC BY 4.0',attribution:'State of Victoria, Department of Energy, Environment and Climate Action (PLM25)',version:'PLM25; retrieved source snapshot',completeness:'partial',aliases:[],notes:'Official Victorian public land management polygons at 1:25,000. Includes only parcels currently classified STATE FOREST and carrying the requested published name; unnamed land is not inferred. https://discover.data.vic.gov.au/dataset/public-land-management-plm25'};
const scope="mmgt_ongen='STATE FOREST' AND mmtgen='STATE FOREST'";
const checksum=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sourceOK=s=>{if(s.status!=='approved'||s.type!=='state_forest'||s.format!=='vic-state-forest'||s.url!==forestEndpoint||s.nameField!=='name'||s.idField!=='plm_id'||!s.licence?.trim()||!s.attribution?.trim())throw Error('An approved official PLM25 state-forest source with licence and attribution is required.');};
const params=(filter,extra={})=>new URLSearchParams({service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:plm25',outputFormat:'application/json',srsName:'EPSG:4326',cql_filter:filter,...extra});
const total=d=>{if(!['number','string'].includes(typeof d.numberMatched)||String(d.numberMatched).trim()==='')throw Error('PLM25 omitted a complete result count.');const n=Number(d.numberMatched);if(!Number.isSafeInteger(n)||n<0)throw Error('PLM25 omitted a complete result count.');return n;};

async function fetchForestRecords(filter,load,attributesOnly=false){
  const records=[],requests=[],seen=new Set();let expected;
  for(let offset=0;offset===0||offset<expected;){
    const p=params(filter,{count:'200',startIndex:String(offset),sortBy:'plm_id A',...(attributesOnly?{propertyName:'plm_id,name,label,mmgt_ongen,mmtgen,vers_date'}:{})});
    const url=`${forestEndpoint}?${p}`;requests.push(url);const data=await load(url,50000000),n=total(data);
    if(n>10000||expected!==undefined&&n!==expected||data.type!=='FeatureCollection'||!Array.isArray(data.features)||data.numberReturned!==data.features.length||data.features.length>200||(!data.features.length&&offset<n))throw Error('PLM25 returned incomplete, inconsistent or oversized results.');
    if(data.crs&&!/4326|CRS84/.test(JSON.stringify(data.crs)))throw Error('PLM25 geometry is not WGS84.');
    expected=n;
    for(const f of data.features){const p=f.properties;
      if(!p||!Number.isSafeInteger(p.plm_id)||p.plm_id<=0||seen.has(p.plm_id)||p.mmgt_ongen!=='STATE FOREST'||p.mmtgen!=='STATE FOREST'||!String(p.name||'').trim())throw Error('PLM25 returned duplicated, unnamed or non-state-forest records.');
      seen.add(p.plm_id);records.push(f);
    }
    offset+=data.features.length;if(!n)break;
  }
  if(records.length!==expected)throw Error('PLM25 did not return every matching parcel.');
  return {records,requests};
}
export async function listStateForests(source,load=publicJson){
  sourceOK(source);
  const {records,requests}=await fetchForestRecords(`${scope} AND name IS NOT NULL AND strTrim(name)<>''`,load,true);
  const names=new Map();for(const r of records){const p=r.properties;names.set(normalize(p.name),String(p.label||'').trim()||p.name.trim());}
  return {names:[...names.values()].sort(),recordCount:records.length,requests,checksum:checksum(records)};
}
export async function importStateForest(source,query,load=publicJson,settings={}){
  sourceOK(source);const terms=featureSearchTerms(query,'state_forest',settings.aliases);
  const literals=terms.map(t=>`'${t.toUpperCase().replaceAll("'","''")}'`).join(',');
  const {records,requests}=await fetchForestRecords(`${scope} AND strToUpperCase(strTrim(name)) IN (${literals})`,load);
  if(records.some(r=>!terms.includes(normalize(r.properties.name))))throw Error('PLM25 names do not match the requested forest.');
  return {payload:{type:'FeatureCollection',features:records},metadata:{adapter:forestVersion,retrievedAt:now(),queryTerms:terms,requests},truncated:false,checksum:checksum(records)};
}
export function processStateForest(item){
  sourceOK(item.source);
  if(item.truncated||item.metadata?.adapter!==forestVersion)throw Error('A complete validated PLM25 import is required.');
  const groups=new Map(),ids=new Set();let vertices=0;
  for(const r of item.payload.features){const p=r.properties;
    if(p.mmgt_ongen!=='STATE FOREST'||p.mmtgen!=='STATE FOREST'||!String(p.name||'').trim()||!Number.isSafeInteger(p.plm_id)||p.plm_id<=0||ids.has(p.plm_id)||!['Polygon','MultiPolygon'].includes(r.geometry?.type))throw Error('Invalid state-forest classification, name, identifier or geometry.');
    ids.add(p.plm_id);
    const polygons=r.geometry.type==='Polygon'?[r.geometry.coordinates]:r.geometry.coordinates;
    if(!polygons.length||polygons.some(poly=>!poly.length||poly.some(r=>r.length<4||r[0][0]!==r.at(-1)[0]||r[0][1]!==r.at(-1)[1])))throw Error('State-forest polygon rings are empty or unclosed.');
    coordEach(r,c=>{if(++vertices>2000000||c.length<2||!c.slice(0,2).every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>90)throw Error('State-forest geometry exceeds coordinate or vertex limits.');});
    const key=normalize(p.name);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  return [...groups].map(([name,records])=>{
    const shape=records.length===1?records[0]:union(featureCollection(records));
    if(!shape)throw Error('Forest parcels could not be combined.');
    const bounds=bbox(shape),areaKm2=area(shape)/1e6;
    if(!bounds.every(Number.isFinite)||!Number.isFinite(areaKm2)||areaKm2<=0)throw Error('State forest has no usable boundary.');
    const dates=[...new Set(records.map(r=>r.properties.vers_date).filter(Boolean))].sort();
    const label=String(records[0].properties.label||'').trim()||records[0].properties.name.trim();
    return {sourceId:item.source.id,sourceName:item.source.name,coverage:'partial',identityRank:1,spanKm:0,result:{identityKey:`plm25:state-forest:${checksum(name).slice(0,24)}`,displayName:label,geometry:shape.geometry,bbox:bounds,areaKm2,lengthKm:null,status:'resolved',confidence:'published_snapshot',method:'plm25_named_state_forest_parcels',algorithmVersion:forestVersion,warnings:[],identity:{excludedRecords:0,publisherName:name},
      forest:{officialName:label,dataset:'PLM25',scale:'1:25,000',parcelCount:records.length,sourceVersionDates:dates,retrievedAt:item.metadata.retrievedAt,limitations:['Extent of all parcels carrying this published name and classified State Forest in the retrieved PLM25 snapshot. Unnamed forest land is not assigned by inference.','PLM25 is a public land management dataset, not a surveyed legal boundary or a statement of public access.','Parcels are grouped by their published forest name; PLM25 does not provide a persistent parent forest identifier.']},
      evidence:records.map(r=>({sourceId:item.source.id,sourceName:item.source.name,sourceUrl:item.source.url,licence:item.source.licence,attribution:item.source.attribution,sourceVersion:r.properties.vers_date||'Not supplied',objectId:String(r.properties.plm_id),importId:item.id,checksum:item.checksum,role:'state_forest_parcel'}))}};
  });
}
