import {resolve} from 'node:path';
import {createStore} from '../server/store.js';
import {vicmapDemSource,vicmapDemEndpoint} from '../server/vicmap-dem.js';
import {terrainPilots} from '../server/terrain-pilot-config.js';
import {drainageFingerprint} from '../server/valley-floor.js';
import {pilotInput} from '../server/terrain-reasoning.js';

// Run with the server stopped. Existing geometry and all revisions are preserved.
const database=process.env.GEOXPL_DB||'runtime/geoxpl.sqlite';
const store=createStore(resolve(database));
try{
  let source=store.sources().find(s=>s.url===vicmapDemEndpoint&&s.format==='vic-dem10m');
  if(!source){const id=store.addSource(vicmapDemSource);source=store.sources().find(s=>s.id===id);}
  if(source.status!=='approved'){
    if(!process.argv.includes('--approve-source'))throw Error('Review the Vicmap numeric DEM source and licence, then use --approve-source to approve it.');
    store.decideSource(source.id,'approved',vicmapDemSource);
    source=store.sources().find(s=>s.id===source.id);
  }
  const plans=terrainPilots.map(pilot=>{
    const matches=store.features().filter(f=>f.type==='river'&&f.name.trim().toLowerCase()===pilot.river.toLowerCase());
    if(matches.length!==1)throw Error(`Expected one saved ${pilot.river}; review its identity first.`);
    const drainage=matches[0],config={pilotId:pilot.id,sourceId:source.id,drainageFeatureId:drainage.id,drainageChecksum:drainageFingerprint(drainage)};
    pilotInput(config,drainage);return {pilot,config};
  });
  for(const {pilot,config} of plans){
    const job=store.request(pilot.name,'valley'),existing=store.featureSettings(job.id);
    if(store.jobFeatures(job.id).some(f=>f.terrainReasoning?.pilotId===pilot.id)&&JSON.stringify(existing.terrainReasoning)===JSON.stringify(config)&&!process.argv.includes('--retry')){
      console.log(`${pilot.name}: already retained; use --retry to recompute from the retained snapshot.`);continue;
    }
    store.setFeatureSettings(job.id,{...existing,preferredSourceId:null,valleyFloor:null,terrain:null,terrainReasoning:config});
    store.setProcessingPolicy(job.id,{allowResearch:false});
    store.retry(job.id);console.log(`${pilot.name}: queued (${job.id})`);
  }
}finally{store.db.close();}
