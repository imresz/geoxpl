import {createStore} from '../server/store.js';
import {floodSource,floodArchiveUrl} from '../server/flood-evidence.js';
import {drainageFingerprint} from '../server/valley-floor.js';
const store=createStore(process.env.GEOXPL_DB||'runtime/geoxpl.sqlite');
try{
  let source=store.sources().find(s=>s.format==='nccma-flood'&&s.url===floodArchiveUrl);
  if(!source){const id=store.addSource(floodSource);source=store.sources().find(s=>s.id===id);}
  if(source.status!=='approved'){
    if(!process.argv.includes('--approve-source'))throw Error('Review the published archive licence and attribution, then use --approve-source.');
    store.decideSource(source.id,'approved',floodSource);
  }
  const jobs=store.jobs().filter(j=>j.type==='valley'&&j.normalized==='loddon valley'&&!j.superseded_by);
  if(jobs.length!==1)throw Error('Expected one existing Loddon Valley pilot request.');
  const job=jobs[0],settings=store.featureSettings(job.id),config=settings.terrainReasoning;
  if(config?.pilotId!=='loddon')throw Error('The Loddon terrain pilot must be configured first.');
  const river=store.feature(config.drainageFeatureId);
  if(!river||drainageFingerprint(river)!==config.drainageChecksum)throw Error('The saved Loddon river revision changed; review the drainage input.');
  if(store.jobFeatures(job.id).some(f=>f.floodSupport?.sourceId===source.id)&&!process.argv.includes('--retry'))console.log('Flood-supported Loddon result already retained; use --retry for an explicit repeat.');
  else{
    store.setFeatureSettings(job.id,{...settings,terrainReasoning:{...config,floodSupport:{sourceId:source.id}}});
    store.setProcessingPolicy(job.id,{allowResearch:false});store.retry(job.id);console.log(`Queued Loddon flood support: ${job.id}`);
  }
}finally{store.close();}
