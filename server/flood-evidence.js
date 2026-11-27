import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {publicBytes,publicJson} from './network.js';
import {sha} from './vicmap-dem.js';

export const floodDatasetId='244468a2-f9ee-4663-8440-72b89425efd6';
export const floodResourceId='d2fd0cb6-fed7-43ee-9e45-65f4bb932acc';
export const floodCatalogue=`https://data.gov.au/data/dataset/${floodDatasetId}`;
export const floodArchiveUrl=`${floodCatalogue}/resource/${floodResourceId}/download/nccma_ari100_extent.zip`;
export const floodSource={name:'North Central CMA 1% AEP flood extents - 2021 published archive',type:'valley',format:'nccma-flood',url:floodArchiveUrl,
  nameField:'StudyName',idField:'archive-row',licence:'Creative Commons Attribution 2.5 Australia (CC BY 2.5 AU)',
  attribution:'North Central Catchment Management Authority, 1% AEP Flood Extent, published 21 November 2021, CC BY 2.5 AU. Selection, clipping and valley interpretation by GeoXpl.',
  version:'Published archive 2021-11-21; per-record study and modification dates retained',completeness:'partial',aliases:[],
  notes:`Declared licence: https://creativecommons.org/licenses/by/2.5/au/ . Catalogue: ${floodCatalogue} . Not current flood warnings, property advice or a complete valley boundary. Only high-reliability modelled 1% AEP records intersecting the mapped river support the floor candidate. Other records are not assumed reliable or current.`};
export const floodFingerprint=s=>sha({url:s.url,format:s.format,type:s.type,licence:s.licence,attribution:s.attribution,version:s.version});
export async function retainFloodArchive(source,options={}){
  if(source?.status!=='approved'||source.type!=='valley'||source.format!=='nccma-flood'||source.url!==floodArchiveUrl||!source.licence?.includes('2.5')||!source.attribution?.trim())throw Error('An approved, licensed North Central CMA flood archive is required.');
  const root=resolve(options.runtimeDir||'runtime','flood-support');await mkdir(root,{recursive:true});
  const index=join(root,`${floodFingerprint(source)}.snapshot.json`);
  try{
    const saved=JSON.parse(await readFile(index,'utf8')),archivePath=join(root,`${saved.checksum}.zip`),bytes=await readFile(archivePath);
    if(saved.sourceFingerprint===floodFingerprint(source)&&saved.checksum===sha(bytes)&&saved.metadata?.licenseId==='cc-by-2.5')return {...saved,archivePath,root};
  }catch{}
  const reply=await(options.json||publicJson)(`https://data.gov.au/data/api/3/action/package_show?id=${floodDatasetId}`,2_000_000);
  const m=reply.result,r=m?.resources?.find(r=>r.id===floodResourceId);
  if(!reply.success||m.id!==floodDatasetId||m.private||m.license_id!=='cc-by-2.5'||!/^https?:\/\/creativecommons.org\/licenses\/by\/2\.5\/au\/?$/.test(m.license_url)||r?.url!==floodArchiveUrl||r.size>40_000_000)throw Error('Flood archive metadata or declared reuse terms changed; review the source.');
  const bytes=await(options.load||publicBytes)(floodArchiveUrl,40_000_000);
  if(bytes.length!==r.size||bytes.readUInt32LE(0)!==0x04034b50)throw Error('Flood archive is incomplete or is not the published ZIP.');
  const checksum=sha(bytes),archivePath=join(root,`${checksum}.zip`);
  const metadata={datasetId:floodDatasetId,resourceId:floodResourceId,datasetTitle:m.title,licence:m.license_title,licenseId:m.license_id,licenceUrl:m.license_url,
    catalogueUrl:floodCatalogue,archiveModified:r.last_modified,catalogueModified:m.metadata_modified,archiveBytes:bytes.length,
    retrievalDate:new Date().toISOString(),attribution:source.attribution};
  const saved={sourceFingerprint:floodFingerprint(source),checksum,metadata};
  const temp=`${archivePath}.${randomUUID()}.tmp`;await writeFile(temp,bytes);await rename(temp,archivePath);
  await writeFile(index,JSON.stringify(saved));return {...saved,archivePath,root};
}
