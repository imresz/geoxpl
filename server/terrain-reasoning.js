import { z } from 'zod';
import { execFile } from 'node:child_process';
import { access,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { area,bbox,feature,booleanValid,coordEach,booleanIntersects,bboxPolygon } from '@turf/turf';
import { retainVicmapElevation,sha,demSourceFingerprint } from './vicmap-dem.js';
import { terrainPilotVersion,terrainPilots } from './terrain-pilot-config.js';
import { drainageFingerprint } from './valley-floor.js';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const terrainReasoningSchema=z.object({pilotId:z.enum(['yarra','ovens','loddon']),sourceId:z.string().min(1),
  drainageFeatureId:z.string().min(1),drainageChecksum:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function pilotInput(config,drainage) {
  const settings=terrainReasoningSchema.parse(config),pilot=terrainPilots.find(p=>p.id===settings.pilotId);
  if(!drainage||drainage.id!==settings.drainageFeatureId||drainage.type!=='river'||drainage.method!=='geofabric_directed_main_stem'||
    !['resolved','partially_resolved'].includes(drainage.status)||!['LineString','MultiLineString'].includes(drainage.geometry?.type)||
    drainageFingerprint(drainage)!==settings.drainageChecksum||!drainage.evidence?.some(e=>e.role==='route_segment')||
    drainage.name.trim().toLowerCase()!==pilot.river.toLowerCase()||!booleanIntersects(feature(drainage.geometry),bboxPolygon(pilot.scope)))throw Error('The pilot requires the reviewed saved mapped-river revision; river identity or geometry changed.');
  return {settings,pilot};
}
export function runReasoning(python,manifest,input,options={}) {
  return new Promise((accept,reject)=>{
    const child=execFile(python,[join(project,'terrain','reasoning.py'),manifest,input],{windowsHide:true,timeout:options.timeout||900000,maxBuffer:16_000_000,
      env:{...process.env,NUMBA_NUM_THREADS:'2',...(options.pythonPath?{PYTHONPATH:options.pythonPath}:{})}},(error,stdout,stderr)=>{
      if(error){let message;try{message=JSON.parse(stderr.trim().split(/\r?\n/).at(-1)).error;}catch{}
        return reject(Error(message||(error.killed?'Terrain reasoning exceeded the 15-minute processing limit.':'Terrain Python processing failed. Check its optional dependencies.')));}
      try{accept(JSON.parse(stdout));}catch{reject(Error('Terrain reasoning returned invalid JSON.'));}
    });
    if(options.progress)child.stderr.on('data',chunk=>options.progress(String(chunk).trim().slice(-500)));
    child.on('error',()=>{});
  });
}
function checkedGeometry(geometry,pilot) {
  if(!['Polygon','MultiPolygon'].includes(geometry?.type))throw Error('Terrain reasoning returned no polygon.');
  const f=feature(geometry);let count=0;
  coordEach(f,c=>{if(++count>250000||c.length!==2||!c.every(Number.isFinite)||c[0]<pilot.scope[0]-.001||c[0]>pilot.scope[2]+.001||c[1]<pilot.scope[1]-.001||c[1]>pilot.scope[3]+.001)throw Error('Terrain reasoning polygon exceeds its declared study area.');});
  const parts=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  if(parts.length>512||parts.some(coordinates=>!booleanValid(feature({type:'Polygon',coordinates}))))throw Error('Terrain reasoning returned invalid polygon parts.');
  const km2=area(f)/1e6;if(!Number.isFinite(km2)||km2<=0||km2>area(bboxPolygon(pilot.scope))/1e6*1.01)throw Error('Terrain reasoning area is invalid.');
  return {geometry,bbox:bbox(f),areaKm2:km2};
}
export async function deriveTerrainReasoning(source,drainage,config,options={}) {
  const {settings,pilot}=pilotInput(config,drainage);
  const python=options.python||process.env.TERRAIN_PYTHON||join(project,'.venv-terrain',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!options.run)await access(python).catch(()=>{throw Error('Terrain Python environment is unavailable.');});
  const retained=await (options.retain||retainVicmapElevation)(source,pilot.scope,{runtimeDir:options.runtimeDir,
    progress:p=>options.progress?.(`Retaining Vicmap elevation tiles ${p.completed}/${p.total}`)});
  const fingerprint=sha({algorithm:terrainPilotVersion,pilot,drainage:settings.drainageChecksum,dem:retained.checksum});
  const cache=join(retained.root,`${fingerprint}.result.json`);
  let calculated,computed=false;
  try{const saved=JSON.parse(await readFile(cache,'utf8'));if(saved.fingerprint===fingerprint&&saved.checksum===sha(saved.result))calculated=saved.result;}catch{}
  if(!calculated) {
    const input=join(retained.root,`${randomUUID()}.input.json`);
    try{await writeFile(input,JSON.stringify({scope:pilot.scope,riverGeometry:drainage.geometry}));
      calculated=await (options.run||runReasoning)(python,retained.manifestPath,input,{pythonPath:options.pythonPath,progress:options.progress});
    }finally{await unlink(input).catch(()=>{});}
    computed=true;
  }
  const central=checkedGeometry(calculated.geometry,pilot),core=checkedGeometry(calculated.stableCore,pilot),outer=checkedGeometry(calculated.outerEnvelope,pilot),d=calculated.diagnostics;
  if(calculated.algorithmVersion!==terrainPilotVersion||!d||!Number.isFinite(d.intersectionOverUnion)||d.intersectionOverUnion<0||d.intersectionOverUnion>1||
    d.analysisCellMetres!==30||!Array.isArray(d.scales)||d.scales.length!==3||!Number.isFinite(d.weakReliefEdgeShare)||!Array.isArray(d.rules)||!Array.isArray(d.limitations))throw Error('Terrain reasoning omitted required uncertainty diagnostics.');
  if(computed){const temporary=`${cache}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify({fingerprint,result:calculated,checksum:sha(calculated)}));await rename(temporary,cache);}
  const m=retained.manifest;
  const raster={adapter:m.adapter,nominalSourceMetres:10,analysisCellMetres:30,cacheLevel:m.plan.level,cacheResolutionWebMercatorMetres:m.plan.resolution,
    checksum:retained.checksum,manifest:`${retained.checksum}.manifest.json`,tileCount:m.entries.length,bytes:m.bytes,
    retrievedAt:m.retrievedAt,verticalDatum:m.verticalDatum,sourceEpoch:m.sourceEpoch,verticalRmseMetres:m.verticalRmseMetres,
    horizontalRmseMetres:m.horizontalRmseMetres,compressionErrorMetres:m.metadata.tileInfo.lercError};
  const importId=options.saveImport?.(retained.checksum,{type:'RasterTileSnapshot',manifest:raster.manifest,checksum:retained.checksum},raster)||null;
  return {geometry:central.geometry,bbox:central.bbox,displayBbox:central.bbox,displayName:pilot.label,areaKm2:central.areaKm2,lengthKm:null,
    status:'partially_resolved',confidence:'estimated',method:'drainage_constrained_multiscale_terrain',algorithmVersion:terrainPilotVersion,
    extentEstimate:{kind:'terrain_valley',label:'Terrain-derived valley interpretation',coverage:'partial',scopeNote:pilot.scopeNote,
      evidenceUrl:pilot.contextUrl,sourceScale:'Vicmap 10m source via numeric elevation cache; 30m regional analysis grid. Not 10m boundary accuracy.'},
    principalDrainage:{featureId:drainage.id,name:drainage.name,checksum:settings.drainageChecksum,status:drainage.status},
    selection:{sourceId:source.id,reason:'Explicit terrain-reasoning pilot; not a published named-valley boundary.'},
    terrainReasoning:{version:terrainPilotVersion,pilotId:pilot.id,inputFingerprint:fingerprint,scope:pilot.scope,scopeNote:pilot.scopeNote,contrast:pilot.contrast,
      raster,diagnostics:d,stableCore:core,outerEnvelope:outer,rules:d.rules,limitations:d.limitations,
      interpretation:'Physical terrain candidate; named-feature meaning and study cuts are separate assumptions.'},
    warnings:[pilot.scopeNote,...d.limitations,...(drainage.status==='partially_resolved'?['The principal river is partially resolved. Only its saved mapped flow-path geometry was used; no dotted river gaps were used.']:[])],
    evidence:[{sourceId:source.id,sourceName:source.name,sourceUrl:source.url,licence:source.licence,attribution:source.attribution,sourceVersion:source.version,
      objectId:`Vicmap elevation cache: ${m.entries.length} bounded level-14 tiles`,importId,checksum:retained.checksum,role:'terrain_elevation'},
      ...(drainage.evidence||[]).map(e=>({...e,role:'principal_drainage_support'}))]};
}

export async function runTerrainPilot(store,job,options={}) {
  const settings=store.featureSettings(job.id),config=terrainReasoningSchema.parse(settings.terrainReasoning),drainage=store.feature(config.drainageFeatureId);
  const source=store.sources().find(s=>s.id===config.sourceId),beforeSource=source&&demSourceFingerprint(source),beforeSettings=JSON.stringify(settings);
  if(source?.status!=='approved')throw Error('The terrain elevation source must be approved.');
  pilotInput(config,drainage);
  if(job.query.trim().toLowerCase()!==terrainPilots.find(p=>p.id===config.pilotId).name.toLowerCase())throw Error('Pilot settings do not match the requested valley name.');
  if((drainage.evidence||[]).some(e=>!store.sources().some(s=>s.id===e.sourceId&&s.status==='approved')))throw Error('A drainage evidence source is no longer approved.');
  const active=store.jobFeatures(job.id),old=store.db.prepare('SELECT data FROM features WHERE job_id=?').all(job.id).map(r=>JSON.parse(r.data));
  if(old.length>1)throw Error('Terrain pilot cannot replace a disambiguation list.');
  store.updateJob(job.id,'pending','processing','Deriving terrain candidates and comparing uncertainty settings.');
  const result=await (options.terrainReasoner||deriveTerrainReasoning)(source,drainage,config,{runtimeDir:options.runtimeDir,
    progress:message=>store.db.prepare('UPDATE jobs SET message=?,updated=? WHERE id=?').run(message,new Date().toISOString(),job.id),
    saveImport:(checksum,payload,metadata)=>store.addImport(source.id,job.id,checksum,payload,metadata)});
  const currentSource=store.sources().find(s=>s.id===config.sourceId),currentDrainage=store.feature(config.drainageFeatureId);
  if(!currentSource||currentSource.status!=='approved'||demSourceFingerprint(currentSource)!==beforeSource||JSON.stringify(store.featureSettings(job.id))!==beforeSettings||
    !currentDrainage||drainageFingerprint(currentDrainage)!==config.drainageChecksum||currentDrainage.evidence.some(e=>!store.sources().some(s=>s.id===e.sourceId&&s.status==='approved')))throw Error('Terrain inputs changed during processing. Review and retry.');
  if(active[0]?.terrainReasoning?.inputFingerprint===result.terrainReasoning.inputFingerprint)return store.updateJob(job.id,'partially_resolved','available_estimate','Unchanged terrain interpretation retained.',active[0].id);
  const saved=store.saveFeature(job,{...result,identityKey:old[0]?.identityKey||`terrain-pilot:${config.pilotId}`});
  return store.updateJob(job.id,'partially_resolved','available_estimate','Terrain-derived interpretation available. The named extent, outer edge and study cuts remain uncertain.',saved.id);
}
