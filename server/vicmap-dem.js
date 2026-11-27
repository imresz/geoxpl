import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { bbox,bboxPolygon,buffer } from '@turf/turf';
import { publicBytes,publicJson } from './network.js';

export const vicmapDemEndpoint='https://tiles-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_10m_DEM/ImageServer';
export const vicmapDemSource={name:'Vicmap Elevation 10m DEM - numeric elevation cache',type:'valley',format:'vic-dem10m',url:vicmapDemEndpoint,
  nameField:'coverage',idField:'tile',licence:'Creative Commons Attribution 4.0 International (CC BY 4.0)',
  attribution:'State of Victoria (Department of Transport and Planning), Vicmap Elevation 10m DEM, CC BY 4.0; terrain interpretation by GeoXpl.',
  version:'Vicmap 10m DEM; mixed source epochs 1990-2018; retained elevation-cache snapshot',completeness:'partial',aliases:[],
  notes:'Numeric single-band LERC elevation samples, not shaded relief. AHD heights; 10m nominal source; vertical accuracy +/-5m RMSE, horizontal 12.5m RMSE or better. Service cache is resampled in Web Mercator. Licence/metadata: https://discover.data.vic.gov.au/dataset/vicmap-elevation-dem-10m ; https://www.land.vic.gov.au/maps-and-spatial/spatial-data/vicmap-catalogue/vicmap-elevation . Not a named-valley boundary.'};
export const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const demSourceFingerprint=s=>sha({url:s.url,format:s.format,type:s.type,licence:s.licence,attribution:s.attribution,version:s.version});
const LEVEL=13,SIZE=256,WORLD=40075016.68557849;
export function elevationPlan(scope,bufferKm=6) {
  if(!Array.isArray(scope)||scope.length!==4||!scope.every(Number.isFinite)||scope[0]<141||scope[2]>150||scope[1]<-39.3||scope[3]>-34||scope[0]>=scope[2]||scope[1]>=scope[3]||scope[2]-scope[0]>.7||scope[3]-scope[1]>.5)throw Error('Unsupported Victorian terrain study area.');
  const bounds=bbox(buffer(bboxPolygon(scope),bufferKm,{units:'kilometers'})),n=2**LEVEL;
  const tx=lon=>Math.floor((lon+180)/360*n),ty=lat=>Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
  const x0=tx(bounds[0]),x1=tx(bounds[2]),y0=ty(bounds[3]),y1=ty(bounds[1]);
  const count=(x1-x0+1)*(y1-y0+1);
  if(count<1||count>1200)throw Error('Terrain study requires too many elevation tiles.');
  return {level:LEVEL,size:SIZE,resolution:WORLD/(n*SIZE),origin:[-WORLD/2,WORLD/2],x0,x1,y0,y1,count,bounds,scope};
}
export function validateElevationService(metadata,plan) {
  const info=metadata.tileInfo,lod=info?.lods?.find(v=>v.level===plan.level);
  if(metadata.error||metadata.serviceDataType!=='esriImageServiceDataTypeElevation'||metadata.bandCount!==1||metadata.pixelType!=='F32'||info?.format!=='LERC'||
    info.rows!==SIZE||info.cols!==SIZE||![3857,102100].includes(info.spatialReference?.latestWkid||info.spatialReference?.wkid)||
    !Number.isFinite(info.lercError)||info.lercError<0||info.lercError>.1||!lod||Math.abs(lod.resolution-plan.resolution)>1e-6||
    Math.abs(info.origin?.x-plan.origin[0])>0.01||Math.abs(info.origin?.y-plan.origin[1])>0.01)throw Error('Vicmap service is not the expected numeric elevation cache.');
  return {serviceDataType:metadata.serviceDataType,bandCount:metadata.bandCount,pixelType:metadata.pixelType,tileInfo:info,
    spatialReference:metadata.spatialReference,serviceItemId:metadata.serviceItemId||null};
}
async function atomic(path,data) {const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,data);await rename(temporary,path);}
async function retryLoad(load){
  for(let attempt=0;attempt<3;attempt++){
    try{return await load(attempt);}catch(error){
      if(attempt===2||!/fetch failed|timeout|ENOTFOUND|EAI_AGAIN|HTTP (429|5\d\d)/i.test(error.message))throw error;
      await new Promise(done=>setTimeout(done,1000*(attempt+1)));
    }
  }
}
export async function retainVicmapElevation(source,scope,options={}) {
  if(source?.status!=='approved'||source.type!=='valley'||source.format!=='vic-dem10m'||source.url!==vicmapDemEndpoint||!source.licence?.trim()||!source.attribution?.trim())throw Error('Approved Vicmap 10m elevation source, licence and attribution are required.');
  const plan=elevationPlan(scope),load=options.load||((url,limit,attempt)=>publicBytes(url,limit,'application/octet-stream',{addressIndex:attempt,connectTimeout:30000}));
  const raw=await retryLoad(attempt=>(options.json||publicJson)(`${source.url}?f=json`,2_000_000,{addressIndex:attempt,connectTimeout:30000})),metadata=validateElevationService(raw,plan);
  const root=resolve(options.runtimeDir||'runtime','terrain-reasoning');await mkdir(root,{recursive:true});
  const namespace=sha({source:demSourceFingerprint(source),metadata}),tileRoot=join(root,'tiles',namespace);await mkdir(tileRoot,{recursive:true});
  const coordinates=[];for(let y=plan.y0;y<=plan.y1;y++)for(let x=plan.x0;x<=plan.x1;x++)coordinates.push({x,y});
  const entries=new Array(plan.count);let totalBytes=0,cursor=0,completed=0;
  async function next(){while(cursor<coordinates.length){
    const index=cursor++,{x,y}=coordinates[index];
    const name=`${plan.level}_${y}_${x}.lerc`,path=join(tileRoot,name),url=`${source.url}/tile/${plan.level}/${y}/${x}`;
    let bytes,record;
    try{record=JSON.parse(await readFile(`${path}.json`,'utf8'));bytes=await readFile(path);if(record.checksum!==sha(bytes)||!Number.isFinite(Date.parse(record.retrievedAt)))bytes=null;}catch{bytes=null;}
    if(!bytes) {
      bytes=await retryLoad(attempt=>load(url,1_000_000,attempt));
      if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.length>1_000_000||!(/^(CntZImage|Lerc2)/.test(bytes.subarray(0,10).toString('ascii'))))throw Error(`Elevation tile ${plan.level}/${y}/${x} is missing or is not numeric LERC data.`);
      record={checksum:sha(bytes),retrievedAt:new Date().toISOString()};
      await atomic(path,bytes);await atomic(`${path}.json`,JSON.stringify(record));
    }
    totalBytes+=bytes.length;if(totalBytes>160_000_000)throw Error('Elevation snapshot exceeds the 160 MB pilot limit.');
    entries[index]={level:plan.level,x,y,path,checksum:record.checksum,bytes:bytes.length,retrievedAt:record.retrievedAt,url};
    options.progress?.({completed:++completed,total:plan.count});
  }}
  await Promise.all(Array.from({length:4},next));
  const checksum=sha({namespace,plan,tiles:entries.map(({x,y,checksum})=>({x,y,checksum}))});
  const manifest={adapter:'vicmap-elevation-lerc/1',checksum,namespace,plan,metadata,entries,bytes:totalBytes,
    nominalSourceMetres:10,verticalDatum:'AHD',sourceEpoch:'Mixed source epochs 1990-2018',verticalRmseMetres:5,horizontalRmseMetres:12.5,
    sourceUrl:source.url,licence:source.licence,attribution:source.attribution,retrievedAt:entries.reduce((d,e)=>e.retrievedAt>d?e.retrievedAt:d,'')};
  const manifestPath=join(root,`${checksum}.manifest.json`);await atomic(manifestPath,JSON.stringify(manifest));
  return {root,manifestPath,manifest,checksum};
}
