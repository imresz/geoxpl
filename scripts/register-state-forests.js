import { createStore } from '../server/store.js';
import { forestSource } from '../server/state-forests.js';
if(!process.argv.includes('--approve-source'))throw Error('Use --approve-source after reviewing the official PLM25 dataset and CC BY 4.0 licence.');
const store=createStore(process.env.GEOXPL_DB||'runtime/geoxpl.sqlite');
try{
  const existing=store.sources().find(s=>s.format===forestSource.format&&s.url===forestSource.url);
  if(existing?.status==='rejected')throw Error('The PLM25 source is rejected. Review it before registering.');
  const id=existing?.id||store.addSource(forestSource);
  if(existing?.status!=='approved')store.decideSource(id,'approved',forestSource);
  const seed=process.argv.indexOf('--seed');
  let job;
  if(seed>=0){if(!process.argv[seed+1])throw Error('Supply a forest name after --seed.');job=store.request(process.argv[seed+1],'state_forest');store.setProcessingPolicy(job.id,{allowResearch:false});}
  console.log(JSON.stringify({sourceId:id,jobId:job?.id,status:job?.status}));
}finally{store.close();}
