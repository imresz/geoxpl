import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createStore } from '../server/store.js';
import { enqueueBatch } from '../server/batches.js';
import { capadSource, capadEndpoint, downloadVictorianNationalParks, processNationalParks, importNationalParks } from '../server/capad.js';

const args=process.argv.slice(2),download=args.indexOf('--download-only'),snapshotArg=args.indexOf('--snapshot');
let snapshot=snapshotArg>=0?JSON.parse(await readFile(args[snapshotArg+1],'utf8')):await downloadVictorianNationalParks({...capadSource,status:'approved'});
// Validate every park before approving a registry entry or enqueuing the batch.
await importNationalParks({...capadSource,status:'approved'},'Validation',undefined,{},snapshot);
const parks=processNationalParks({...snapshot,source:{...capadSource,status:'approved',id:'validation'},id:'validation'});
if(!parks.length||parks.length>100)throw Error('Unexpected CAPAD park count.');
if(download>=0){
  const path=args[download+1];if(!path)throw Error('Supply a snapshot path.');
  await mkdir(dirname(path),{recursive:true});await writeFile(`${path}.tmp`,JSON.stringify(snapshot));await rename(`${path}.tmp`,path);
  console.log(JSON.stringify({parks:parks.length,records:snapshot.payload.features.length,checksum:snapshot.checksum,path}));
} else {
  if(!args.includes('--approve-source'))throw Error('Use --approve-source to explicitly register/approve the documented CAPAD source.');
  const store=createStore(process.env.GEOXPL_DB||'runtime/geoxpl.sqlite');
  try {
    let source=store.sources().find(s=>s.url===capadEndpoint&&s.format==='capad');
    if(source?.status==='rejected')throw Error('CAPAD is rejected in this registry. Review it before importing.');
    const sourceId=source?.id||store.addSource(capadSource);
    if(source?.status!=='approved')store.decideSource(sourceId,'approved',capadSource);
    else if(source.version!==capadSource.version)throw Error('The approved CAPAD source edition differs. Review it before importing.');
    store.addImport(sourceId,'capad-victoria-2024',snapshot.checksum,snapshot.payload,snapshot.metadata);
    const entries=[...new Set(parks.map(p=>p.result.displayName))].sort().map(query=>({query,type:'national_park'}));
    const result=enqueueBatch(store,{id:'capad-2024-victorian-national-parks',name:'Victorian national parks - CAPAD 2024',selectionNote:'All established Victorian records classified National Park / NP in CAPAD 2024, as at 30 June 2024. Proposed parks, state parks and other reserve types are excluded. Coastal national parks are included. Parcels sharing PA_ID are one park; no boundary interpolation.',references:[{title:'CAPAD 2024',url:'https://www.dcceew.gov.au/environment/land/nrs/science/capad/2024'},{title:'CAPAD boundary service',url:capadEndpoint}],entries});
    console.log(JSON.stringify({created:result.created,sourceId,parks:parks.length,batchId:result.batch.id,total:result.batch.total,counts:result.batch.counts}));
  } finally {store.close();}
}
