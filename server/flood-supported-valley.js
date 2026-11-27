import {access,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {coordEach,feature} from '@turf/turf';
import {retainVicmapElevation,sha} from './vicmap-dem.js';
import {retainFloodArchive,floodCatalogue} from './flood-evidence.js';

export const floodValleyVersion='flood-supported-valley/1.0.0';
export const expandedLoddon={scope:[143.74,-36.84,144.23,-36.46],previousScope:[143.86,-36.82,144.12,-36.50],
  label:'Loddon Valley (expanded Newbridge-Bridgewater study area)',
  scopeNote:'Expanded physical study around Newbridge and Bridgewater, not the entire named Loddon Valley. Study-cut lines are processing limits; remaining edges are terrain estimates. Flood support is partial and is not a minimum valley boundary.'};
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function checkedOutline(value,pilot,validate){
  const outline=validate(value?.geometry,pilot),edges=value?.boundaryEvidence;
  if(!edges||!Number.isFinite(edges.studyCutLengthShare)||edges.studyCutLengthShare<0||edges.studyCutLengthShare>1)throw Error('Boundary evidence omitted the artificial cutoffs.');
  for(const key of ['estimatedEdges','studyCuts']){
    const collection=edges[key];let points=0;
    if(collection?.type!=='FeatureCollection'||collection.features.length>10000)throw Error('Invalid boundary evidence collection.');
    for(const line of collection.features){
      if(line.geometry?.type!=='LineString')throw Error('Boundary evidence must contain line segments.');
      coordEach(line,c=>{if(++points>500000||!c.every(Number.isFinite)||c[0]<pilot.scope[0]-.001||c[0]>pilot.scope[2]+.001||c[1]<pilot.scope[1]-.001||c[1]>pilot.scope[3]+.001)throw Error('Boundary evidence lies outside the declared study area.');});
    }
  }
  return {...outline,boundaryEvidence:edges};
}

export async function deriveFloodSupportedValley(source,drainage,config,pilot,options){
  if(pilot.id!=='loddon'||!options.floodSource||options.floodSource.id!==config.floodSupport.sourceId)throw Error('Flood-supported processing is enabled only for the reviewed Loddon pilot.');
  pilot={...pilot,...expandedLoddon};
  const python=options.python||process.env.TERRAIN_PYTHON||join(project,'.venv-terrain',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  await access(python);
  const flood=await(options.retainFlood||retainFloodArchive)(options.floodSource,{runtimeDir:options.runtimeDir});
  const dem=await(options.retain||retainVicmapElevation)(source,pilot.scope,{runtimeDir:options.runtimeDir,progress:p=>options.progress?.(`Retaining expanded elevation tiles ${p.completed}/${p.total}`)});
  const fingerprint=sha({version:floodValleyVersion,pilot,drainage:config.drainageChecksum,dem:dem.checksum,flood:flood.checksum,source:flood.sourceFingerprint});
  const cache=join(dem.root,`${fingerprint}.result.json`);let calculated,computed=false;
  try{const saved=JSON.parse(await readFile(cache,'utf8'));if(saved.fingerprint===fingerprint&&saved.checksum===sha(saved.result))calculated=saved.result;}catch{}
  if(!calculated){
    const input=join(dem.root,`${randomUUID()}.input.json`);
    try{
      await writeFile(input,JSON.stringify({scope:pilot.scope,riverGeometry:drainage.geometry,floodArchive:flood.archivePath,floodChecksum:flood.checksum}));
      calculated=await options.run(python,dem.manifestPath,input,{script:'flood_valley.py',pythonPath:options.pythonPath,progress:options.progress});
      computed=true;
    }finally{await unlink(input).catch(()=>{});}
  }
  if(calculated.validation!=='Shapely-GEOS projected and WGS84 topology')throw Error('Flood-supported processor omitted native topology validation.');
  const validate=options.validate,central=checkedOutline(calculated.central,pilot,validate),core=checkedOutline(calculated.stableCore,pilot,validate),
    outer=checkedOutline(calculated.outerEnvelope,pilot,validate),floor=checkedOutline(calculated.valleyFloor,pilot,validate),published=validate(calculated.publishedFlood,pilot),d=calculated.diagnostics;
  if(calculated.algorithmVersion!==floodValleyVersion||d?.analysisCellMetres!==30||!Number.isFinite(d.intersectionOverUnion)||d.intersectionOverUnion<0||d.intersectionOverUnion>1||!d.floodSelection?.records?.length||!Array.isArray(d.rules)||!Array.isArray(d.limitations))throw Error('Flood-supported output omitted required evidence or uncertainty.');
  if(computed){const temporary=`${cache}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify({fingerprint,result:calculated,checksum:sha(calculated)}));await rename(temporary,cache);}
  const m=dem.manifest,raster={adapter:m.adapter,nominalSourceMetres:10,analysisCellMetres:30,cacheLevel:m.plan.level,
    cacheResolutionWebMercatorMetres:m.plan.resolution,checksum:dem.checksum,manifest:`${dem.checksum}.manifest.json`,tileCount:m.entries.length,bytes:m.bytes,
    retrievedAt:m.retrievedAt,verticalDatum:m.verticalDatum,sourceEpoch:m.sourceEpoch,verticalRmseMetres:m.verticalRmseMetres,horizontalRmseMetres:m.horizontalRmseMetres,compressionErrorMetres:m.metadata.tileInfo.lercError};
  const demImport=options.saveImport?.(dem.checksum,{type:'RasterTileSnapshot',manifest:raster.manifest,checksum:dem.checksum},raster)||null;
  const floodImport=options.saveFloodImport?.(flood.checksum,{type:'ArchiveSnapshot',filename:`${flood.checksum}.zip`,checksum:flood.checksum},flood.metadata)||null;
  const scopeEstimate={kind:'terrain_valley',label:'Flood-supported terrain interpretation',coverage:'partial',scopeNote:pilot.scopeNote,evidenceUrl:pilot.contextUrl,
    sourceScale:'Vicmap 10m source; 30m analysis. Flood archive published November 2021; selected study dates retained. Not property or flood-risk advice.'};
  const floodSupport={...published,sourceId:options.floodSource.id,sourceName:options.floodSource.name,sourceUrl:floodCatalogue,
    licence:options.floodSource.licence,licenceUrl:'https://creativecommons.org/licenses/by/2.5/au/',datasetTitle:flood.metadata.datasetTitle||'1% AEP Flood Extent - North Central CMA region Victoria',
    attribution:options.floodSource.attribution,archiveChecksum:flood.checksum,importId:floodImport,
    scenario:'1% annual exceedance probability (AEP)',archiveDate:flood.metadata.archiveModified,records:d.floodSelection.records,
    selection:d.floodSelection.selection,association:d.floodSelection.association,excluded:d.floodSelection.excluded,
    limitations:['Published flood scenario, not current flooding or a valley boundary.','Only selected modelled, high-reliability, river-connected components are shown. Missing coverage is unknown, not safe.','The 2021 archive is not a claim that the underlying studies are current.']};
  return {...central,displayBbox:central.bbox,displayName:pilot.label,status:'partially_resolved',confidence:'estimated',lengthKm:null,
    method:'flood_supported_multiscale_terrain',algorithmVersion:floodValleyVersion,extentEstimate:scopeEstimate,floodSupport,
    valleyFloor:{...floor,extentEstimate:{...scopeEstimate,kind:'valley_floor',label:'Flood-supported valley-floor candidate',scopeNote:'Partial floor candidate anchored to selected flood mapping with a bounded terrain-derived fringe. It is not a published flood extent, a guaranteed minimum valley, or the whole valley floor.'}},
    principalDrainage:{featureId:drainage.id,name:drainage.name,checksum:config.drainageChecksum,status:drainage.status},
    selection:{sourceId:source.id,reason:'Explicit flood-supported Loddon study; not an authoritative named-valley boundary.'},
    terrainReasoning:{version:floodValleyVersion,pilotId:pilot.id,inputFingerprint:fingerprint,scope:pilot.scope,previousScope:pilot.previousScope,
      scopeNote:pilot.scopeNote,contrast:pilot.contrast,raster,diagnostics:d,stableCore:core,outerEnvelope:outer,rules:d.rules,limitations:d.limitations,
      interpretation:'Flood mapping supports a partial floor interpretation. Other sides are terrain estimates; artificial study cuts are stored separately.'},
    warnings:[pilot.scopeNote,...d.limitations,'The archive does not supply flood-model domain boundaries separately. Some floor edges may reflect source-model limits; only the GeoXpl study-window cuts are explicitly classified.'],
    evidence:[{sourceId:source.id,sourceName:source.name,sourceUrl:source.url,licence:source.licence,attribution:source.attribution,sourceVersion:source.version,
      objectId:`Vicmap elevation: ${m.entries.length} level-${m.plan.level} tiles`,importId:demImport,checksum:dem.checksum,role:'terrain_elevation'},
      ...d.floodSelection.records.map(record=>({sourceId:options.floodSource.id,sourceName:options.floodSource.name,sourceUrl:floodCatalogue,
        licence:options.floodSource.licence,attribution:options.floodSource.attribution,sourceVersion:options.floodSource.version,
        objectId:record.recordId,importId:floodImport,checksum:flood.checksum,role:'published_flood_support'})),
      ...(drainage.evidence||[]).map(e=>({...e,role:'principal_drainage_support'}))]};
}
