const bomService = /^https:\/\/hosting\.wsapi\.cloud\.bom\.gov\.au\/arcgis\/rest\/services\/ahgf\/Geofabric_V3x_All_Products\/(?:MapServer|FeatureServer)\/(\d+)\/?$/i;

export function contextualSource(source) {
  // These published layers describe waterbodies, not river centreline geometry.
  return source.format === 'arcgis' && ['9','10','27'].includes(source.url.match(bomService)?.[1]);
}

export function sourceKey(source) {
  const match=source.url.match(bomService);
  // Only collapse the known same-product aliases; unrelated ArcGIS service IDs are not interchangeable.
  const url=source.format==='arcgis' && match && ['6','9','10','27'].includes(match[1])
    ? `bom-geofabric-v3:${match[1]}` : `${source.url.replace(/\/$/,'')}#registry:${source.id||''}`;
  return JSON.stringify([url,source.type,source.format,source.nameField,source.completeness]);
}

export function selectSources(store,job,settings) {
  const current=store.jobFeatures(job.id).map(f=>f.selection?.sourceId).filter(Boolean);
  const eligible=store.sources().filter(s=>s.status==='approved'&&s.type===job.type&&s.format!=='ga-dem'&&!contextualSource(s)&&
    (s.format!=='vic-gmu250'||settings.valleyFloor?.sourceId===s.id));
  const priority=s=>s.id===settings.preferredSourceId?0:current.includes(s.id)?1:2;
  eligible.sort((a,b)=>priority(a)-priority(b)||a.id.localeCompare(b.id));
  const selected=[],duplicates=[],seen=new Map();
  for (const source of eligible) {
    const key=sourceKey(source);
    if (seen.has(key)) duplicates.push({source,selected:seen.get(key)});
    else {seen.set(key,source);selected.push(source);}
  }
  return {selected,duplicates};
}

export function sourceChangeTargets(store,old,source,newStatus) {
  const semantic=['url','format','type','nameField','idField','licence','attribution','version','completeness','aliases'];
  const changed=old.status!==newStatus||semantic.some(k=>JSON.stringify(old[k])!==JSON.stringify(source[k]));
  if (!changed) return {invalidate:[],retry:[]};
  const features=store.features(), reports=store.reports();
  const dependent=new Set(features.filter(f=>f.selection?.sourceId===old.id||(f.evidence||[]).some(e=>e.sourceId===old.id)||f.terrain?.sourceId===old.id).map(f=>store.db.prepare('SELECT job_id FROM features WHERE id=?').get(f.id).job_id));
  const matches=new Set(store.db.prepare('SELECT job_id,payload FROM imports WHERE source_id=?').all(old.id).filter(r=>{
    try {return JSON.parse(r.payload).features?.length>0;} catch {return false;}
  }).map(r=>r.job_id));
  const retry=[];
  for (const job of store.jobs()) {
    if (job.superseded_by || ['queued','importing','processing','researching'].includes(job.phase)) continue;
    const settings=store.featureSettings(job.id);
    const explicit=[settings.preferredSourceId,settings.valleyFloor?.sourceId,settings.terrain?.sourceId].includes(old.id);
    const recommended=reports.find(r=>r.job_id===job.id)?.data.candidateIds?.includes(old.id);
    // Contextual waterbody approval is consumed by an explicit gap investigation, not a river-wide retry.
    const relevant=dependent.has(job.id)||explicit||(!contextualSource(source)&&job.type===source.type&&(matches.has(job.id)||recommended));
    if (relevant && newStatus==='approved' && (dependent.has(job.id)||explicit||job.status!=='resolved')) retry.push(job.id);
  }
  return {invalidate:[...dependent],retry};
}
