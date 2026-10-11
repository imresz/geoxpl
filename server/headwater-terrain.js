import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbox, buffer, featureCollection, lineString, along, length } from '@turf/turf';
import { publicBytes } from './network.js';
import { demEndpoint } from './terrain.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function sampleHeadwaterTerrain(records, sources, options = {}) {
  const source = sources.find(s=>s.status==='approved'&&s.format==='ga-dem'&&s.url===demEndpoint&&s.licence?.trim()&&s.attribution?.trim());
  if (!source) throw Error('No approved elevation dataset with licence and attribution is available.');
  const shapes = records.map(r=>lineString(r.properties.flowdir===2?[...r.geometry.coordinates].reverse():r.geometry.coordinates));
  const bounds = bbox(buffer(featureCollection(shapes),0.2,{units:'kilometers'}));
  const cells = Math.ceil((bounds[2]-bounds[0])*1200)*Math.ceil((bounds[3]-bounds[1])*1200);
  if (bounds[0]<113||bounds[1]<-44||bounds[2]>154||bounds[3]>-10||cells>1200000) throw Error('Headwater elevation extract exceeds Australian coverage or 1.2 million cells.');
  const params = new URLSearchParams({service:'WCS',version:'1.0.0',request:'GetCoverage',coverage:'1',crs:'EPSG:4326',response_crs:'EPSG:4326',bbox:bounds.join(','),resx:String(1/1200),resy:String(1/1200),format:'GeoTIFF',interpolation:'bilinear'});
  const requestUrl = `${demEndpoint}?${params}`;
  const bytes = await (options.load||publicBytes)(requestUrl,32000000,'image/tiff');
  if (!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>32000000||!['49492a00','4d4d002a'].includes(bytes.subarray(0,4).toString('hex'))) throw Error('Elevation service returned no usable GeoTIFF.');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const root = resolve(options.runtimeDir||dirname(process.env.GEOXPL_DB||'runtime/geoxpl.sqlite'),'terrain');
  await mkdir(root,{recursive:true});
  const raster = join(root,`${checksum}.tif`),input = join(root,`${randomUUID()}.json`);
  const profiles = shapes.map((shape,i)=>({hydroId:records[i].properties.hydroid,coordinates:Array.from({length:21},(_,n)=>along(shape,length(shape)*n/20).geometry.coordinates)}));
  await writeFile(raster,bytes);
  let calculated;
  try {
    await writeFile(input,JSON.stringify({profiles,requestedBbox:bounds}));
    if (options.run) calculated = await options.run(raster,input);
    else calculated = await new Promise((accept,reject)=>execFile(options.python||process.env.TERRAIN_PYTHON||join(project,'.venv-terrain',process.platform==='win32'?'Scripts/python.exe':'bin/python'),[join(project,'terrain','headwaters.py'),raster,input],{windowsHide:true,timeout:60000,maxBuffer:1000000},(error,stdout)=>{
      if(error)return reject(Error('Elevation profile sampling failed. Check the terrain Python environment and raster coverage.'));
      try {accept(JSON.parse(stdout));} catch {reject(Error('Invalid elevation profile response.'));}
    }));
  } finally {await unlink(input).catch(()=>{});}
  if (!Array.isArray(calculated.profiles)||calculated.profiles.length!==profiles.length||calculated.profiles.some((p,i)=>p.hydroId!==profiles[i].hydroId||p.status!=='sampled'||![p.upstreamMetres,p.downstreamMetres,p.dropMetres,p.uphillSteps].every(Number.isFinite))) throw Error('Incomplete or invalid elevation profiles.');
  return {status:'sampled',sourceId:source.id,sourceName:source.name,licence:source.licence,attribution:source.attribution,requestUrl,checksum,filename:`${checksum}.tif`,resolutionMetres:90,profiles:calculated.profiles,
    message:'Local SRTM elevation profiles on an approximately 90 m grid. Small reversals can reflect terrain noise; these are not headwater identity decisions.'};
}
