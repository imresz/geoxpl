import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { bbox, coordEach, featureCollection } from '@turf/turf';
import { normalize, featureSearchTerms, now } from './store.js';
import { publicJson } from './network.js';
import { algorithmVersion } from './processors.js';
import { gapAnchor, gapVersion, investigateGap } from './gap-investigation.js';
import { headwaterAnchor, headwaterVersion, investigateHeadwaters } from './headwater-investigation.js';
import { sourceSchema } from './research.js';

const active = j => j?.status === 'pending' && ['queued', 'importing', 'processing', 'researching'].includes(j.phase);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decode = row => row && ({ ...row, input: JSON.parse(row.input), result: JSON.parse(row.result) });
const getAction = (store, id) => decode(store.db.prepare('SELECT * FROM report_actions WHERE id=?').get(id));
const getReport = (store, id) => { const r = store.db.prepare('SELECT * FROM reports WHERE id=?').get(id); if (!r) throw Error('Report not found.'); return { ...r, data: JSON.parse(r.data) }; };
const getFlow = (store, id) => { const r = store.db.prepare('SELECT * FROM report_workflows WHERE report_id=?').get(id); return r ? { ...r, steps: JSON.parse(r.steps) } : { state: getReport(store,id).status === 'rejected' ? 'dismissed' : 'active', reason: '', steps: {} }; };
function saveFlow(store, id, flow) { store.db.prepare('INSERT INTO report_workflows VALUES(?,?,?,?,?) ON CONFLICT(report_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,steps=excluded.steps,updated=excluded.updated').run(id, flow.state, flow.reason, JSON.stringify(flow.steps), now()); }
function editable(store, id, allowDeferred = false) {
  const report = getReport(store, id), job = store.getJob(report.job_id);
  if (!job || job.superseded_by) throw Error('This request is superseded or unavailable. Open its current result.');
  const latest = store.db.prepare('SELECT id FROM reports WHERE job_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(job.id);
  if (latest.id !== id) throw Error('This report is historical. Open the latest report before taking action.');
  if (!allowDeferred && getFlow(store, id).state !== 'active') throw Error('Resume this report before taking action.');
  return { report, job };
}
function record(store, reportId, kind, status, input = {}, result = {}, baseline = '') {
  const id = randomUUID(), time = now();
  store.db.prepare('INSERT INTO report_actions VALUES(?,?,?,?,?,?,?,?,?)').run(id, reportId, kind, status, JSON.stringify(input), JSON.stringify(result), baseline, time, time);
  store.event(getReport(store, reportId).job_id, `report_${kind}`, JSON.stringify({ reportId, actionId: id, status }));
  return getAction(store, id);
}
function updateAction(store, id, status, result) { store.db.prepare('UPDATE report_actions SET status=?,result=?,updated=? WHERE id=?').run(status, JSON.stringify(result), now(), id); }
const summary = (store, job) => ({ id: job.id, name: job.query, type: job.type, status: job.status, phase: job.phase, updated: job.updated,
  matches: store.jobFeatures(job.id).map(f => ({ id: f.id, name: f.displayName || f.name, status: f.status, lengthKm: f.lengthKm, areaKm2: f.areaKm2 })) });
function snapshot(store, reportId, input) {
  const report = getReport(store, reportId), job = store.getJob(report.job_id);
  let anchor;
  if(input.operation==='gap') {try {anchor=gapAnchor(store,job);} catch {anchor=null;} }
  if(input.operation==='headwaters') {try {anchor=headwaterAnchor(store,job);} catch {anchor=null;} }
  return hash({ report: { id: report.id, nextSteps: report.data.nextSteps, candidates: report.data.candidates, evidence: report.data.evidence }, job: summary(store, job), settings: store.featureSettings(job.id),
    sources: store.sources().filter(s => input.operation !== 'source' || s.id === input.sourceId), algorithmVersion,
    ...(input.operation === 'gap' ? {gapVersion,anchor} : {}), ...(input.operation === 'headwaters' ? {headwaterVersion,anchor} : {}) });
}
export const investigationSchema = z.object({ operation: z.enum(['source', 'prerequisite', 'retry', 'gap', 'headwaters']), sourceId: z.string().max(100).optional(),
  targetName:z.string().trim().min(2).max(150).optional(), radiusKm:z.number().min(0.5).max(20).optional(), discover:z.boolean().optional(), refresh:z.boolean().optional(),
  query: z.string().trim().min(2).max(150).optional(), aliases: z.array(z.string().trim().min(2).max(150)).max(20).default([]), stepIndex: z.number().int().min(0).optional()
}).strict().superRefine((input, ctx) => {
  if (input.operation === 'source' && !input.sourceId) ctx.addIssue({ code: 'custom', message: 'Select a registered source.' });
  if (input.operation === 'prerequisite' && !input.query) ctx.addIssue({ code: 'custom', message: 'Enter the prerequisite river name.' });
  if (input.operation !== 'source' && (input.aliases.length || input.sourceId)) ctx.addIssue({ code: 'custom', message: 'Source and aliases only apply to source checks.' });
  if (input.operation !== 'prerequisite' && input.query) ctx.addIssue({ code: 'custom', message: 'Only prerequisite processing accepts a separate river name.' });
  if (input.operation === 'gap' && !input.targetName) ctx.addIssue({code:'custom',message:'Enter the destination waterbody name.'});
  if (input.operation !== 'gap' && ['targetName','radiusKm','discover'].some(k=>input[k]!==undefined)) ctx.addIssue({code:'custom',message:'Gap settings only apply to geographic-gap investigation.'});
  if (!['gap','headwaters'].includes(input.operation)&&input.refresh!==undefined) ctx.addIssue({code:'custom',message:'Refresh applies to geographic investigations only.'});
});
function validStep(report, index) { if (index !== undefined && !report.data.nextSteps?.[index]) throw Error('Recommendation not found.'); }

export function workflowView(store, id) {
  const report = getReport(store, id), job = store.getJob(report.job_id), flow = getFlow(store, id);
  let readOnlyReason = '';
  try { editable(store, id, true); } catch (error) { readOnlyReason = error.message; }
  const actions = store.db.prepare('SELECT * FROM report_actions WHERE report_id=? ORDER BY created DESC,rowid DESC').all(id).map(decode).map(action => {
    if (action.result.targetJobId) {
      const target = store.currentJob(action.result.targetJobId);
      if (target) action.outcome = summary(store, target);
    }
    if (action.kind === 'investigate' && action.status === 'ready' && action.baseline !== snapshot(store, id, action.input)) action.stale = true;
    if(action.input.operation==='gap'||action.input.operation==='headwaters') {
      // Keep full query snapshots in SQLite, not in the browser's polling responses.
      action.result={...action.result,checks:action.result.checks?.map(({records,...check})=>check),routes:action.result.routes?.map(({geometry,...route})=>route),branches:undefined};
      if(action.input.operation==='headwaters'&&action.result.anchor) action.result.anchor={...action.result.anchor,context:undefined};
    }
    return action;
  });
  return { report, job: summary(store, job), state: flow.state, reason: flow.reason, readOnlyReason, actions,
    steps: (report.data.nextSteps || []).map((text, index) => ({ index, text, owner: 'unassigned', status: 'open', note: '', ...flow.steps[index] })) };
}

export function queueInvestigation(store, id, raw) {
  const input = investigationSchema.parse(raw), { report, job } = editable(store, id);
  validStep(report, input.stepIndex);
  if (active(job)) throw Error('Wait for the feature processing attempt to finish.');
  if (input.operation === 'headwaters') {
    headwaterAnchor(store,job);
    if (!input.refresh) {
      const baseline=snapshot(store,id,input);
      const cached=store.db.prepare("SELECT * FROM report_actions WHERE report_id=? AND kind='investigate' AND status='ready' ORDER BY created DESC").all(id).map(decode)
        .find(a=>a.input.operation==='headwaters'&&a.baseline===baseline&&Date.now()-Date.parse(a.updated)<30*86400000);
      if(cached)return cached;
    }
  }
  if (input.operation === 'gap') {
    gapAnchor(store,job);
    input.radiusKm ??= 10; input.discover ??= true;
    if (!input.refresh) {
      const baseline=snapshot(store,id,input);
      const cached=store.db.prepare("SELECT * FROM report_actions WHERE report_id=? AND kind='investigate' AND status='ready' ORDER BY created DESC").all(id).map(decode)
        .find(a=>a.input.operation==='gap'&&a.input.targetName===input.targetName&&a.input.radiusKm===input.radiusKm&&a.input.discover===input.discover&&a.baseline===baseline&&Date.now()-Date.parse(a.updated)<30*86400000);
      if (cached) return cached;
    }
  }
  if (store.db.prepare("SELECT id FROM report_actions WHERE report_id=? AND kind='investigate' AND status IN ('queued','running')").get(id)) throw Error('An investigation is already queued or running.');
  if (input.operation === 'source' && !store.sources().some(s => s.id === input.sourceId && s.status !== 'rejected')) throw Error('Choose a current, non-rejected registered source.');
  if (input.operation === 'prerequisite' && job.type !== 'valley') throw Error('Prerequisite river processing is available for valley reports.');
  if (input.operation === 'source' && input.aliases.length && store.sources().find(s => s.id === input.sourceId).type !== job.type) throw Error('Aliases must be checked against a source for the requested feature type.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare("UPDATE report_actions SET status='stale',updated=? WHERE report_id=? AND kind='investigate' AND status='ready'").run(now(), id);
    const action = record(store, id, 'investigate', 'queued', input, {}, snapshot(store, id, input));
    store.db.exec('COMMIT'); return action;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

function sampleGeometry(records) {
  let count = 0;
  const features = records.map(r => ({ type: 'Feature', properties: {}, geometry: r.geometry }));
  for (const f of features) {
    if (!['Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon'].includes(f.geometry?.type)) throw Error('Preview contains unsupported geometry.');
    coordEach(f, c => { if (++count > 50000 || c.length < 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw Error('Preview geometry exceeds WGS84 limits.'); });
  }
  const collection = featureCollection(features), bounds = bbox(collection);
  if (!bounds.every(Number.isFinite)) throw Error('Preview geometry has empty coordinates.');
  return { collection, bounds };
}

export async function probeSource(source, query, type, aliases, load = publicJson) {
  if (source.status === 'rejected') throw Error('Rejected sources cannot be investigated.');
  if (!['arcgis','geojson'].includes(source.format)) return { applicable: false, source, message: 'This adapter requires a reviewed geographic definition. Review landform IDs, principal drainage and scope in Feature settings; source availability alone cannot supply them.', owner: 'specialist' };
  const terms = featureSearchTerms(query, type, aliases), base = source.url.replace(/\/$/, '');
  const requests = [], checkedAt = now();
  const fetchData = async url => { requests.push(url); const data = await load(url); if (data.error) throw Error(data.error.message || 'Source query failed.'); return data; };
  let records, total, fields;
  if (source.format === 'arcgis') {
    if (!/\/(MapServer|FeatureServer)\/\d+$/.test(base)) throw Error('Choose a numeric ArcGIS layer, not a catalogue page.');
    const meta = await fetchData(`${base}?f=json`); fields = meta.fields?.map(f => f.name) || [];
    if (![source.nameField, source.idField].every(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) && fields.includes(f))) throw Error('Configured name or identifier field is missing.');
    const ids = new Set();
    for (const term of terms) {
      const params = new URLSearchParams({ f: 'json', where: `UPPER(${source.nameField}) IN ('${term.toUpperCase().replaceAll("'", "''")}')`, returnIdsOnly: 'true' });
      const data = await fetchData(`${base}/query?${params}`);
      if (data.exceededTransferLimit || !Array.isArray(data.objectIds)) throw Error('The source did not return a complete matching-ID response.');
      for (const id of data.objectIds) { if (!Number.isSafeInteger(id) || id < 0) throw Error('Invalid object identifier.'); ids.add(id); }
      if (ids.size > 25000) throw Error('The source check exceeds 25,000 matches.');
    }
    total = ids.size; records = [];
    if (total) {
      const params = new URLSearchParams({ f: 'geojson', objectIds: [...ids].sort((a,b) => a-b).slice(0,5).join(','), outFields: `${source.nameField},${source.idField}`, outSR: '4326', returnGeometry: 'true' });
      const data = await fetchData(`${base}/query?${params}`);
      if (!Array.isArray(data.features) || data.exceededTransferLimit || data.features.length !== Math.min(total,5)) throw Error('Sample records were missing or incomplete.');
      records = data.features;
    }
  } else {
    const data = await fetchData(base);
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw Error('Expected a GeoJSON FeatureCollection.');
    if (data.crs && !JSON.stringify(data.crs).match(/4326|CRS84/)) throw Error('GeoJSON must use WGS84.');
    records = data.features.filter(f => terms.includes(normalize(String(f.properties?.[source.nameField] || ''))));
    total = records.length; if (total > 25000) throw Error('The source check exceeds 25,000 matches.');
    records = records.slice(0,5); fields = [...new Set(records.flatMap(r => Object.keys(r.properties || {})))];
  }
  const result = { applicable: source.type === type && source.status === 'approved' && total > 0, source, checkedAt, requests, terms, fields, total,
    records: records.map(r => ({ id: r.properties?.[source.idField] ?? r.id, name: r.properties?.[source.nameField] })),
    message: total ? `${total} exact-name records found. A sample does not establish the full extent or feature identity.` : 'No exact-name records returned by this query. This does not establish that the feature is absent from every source.' };
  if (records.some(r => !terms.includes(normalize(String(r.properties?.[source.nameField] || ''))))) throw Error('Sample names do not match the requested names.');
  if (records.length) {
    try { result.preview = sampleGeometry(records); }
    catch (error) { result.previewError = error.message; result.applicable = false; }
  }
  if (source.type !== type) result.message += ' The source feature type differs from the requested feature.';
  if (source.status !== 'approved') result.message += ' Source approval and licence review are still required.';
  return result;
}

export async function runInvestigation(store, actionId, options = {}) {
  const action = getAction(store, actionId);
  if (!action || action.status !== 'queued') return;
  try {
    const { job } = editable(store, action.report_id);
    if (action.baseline !== snapshot(store, action.report_id, action.input)) throw Error('Inputs changed since this investigation was queued. Start a new investigation.');
    updateAction(store, action.id, 'running', { ...action.result, message: 'Checking the selected operation' });
    let result;
    if (action.input.operation === 'source') {
      const source = store.sources().find(s => s.id === action.input.sourceId);
      result = await probeSource(source, job.query, job.type, [...new Set([...store.featureSettings(job.id).aliases, ...action.input.aliases])], options.load);
      result.beforeSettings = store.featureSettings(job.id);
      result.proposedAliases = [...new Set(action.input.aliases.map(normalize))].filter(a => !featureSearchTerms(job.query,job.type,store.featureSettings(job.id).aliases).includes(a));
      if (result.proposedAliases.length) result.message += ' Suggested aliases still require your identity decision; name matches alone do not prove equivalence.';
    } else if (action.input.operation === 'gap' || action.input.operation === 'headwaters') {
      const save = async checkpoint=>{
        if (getAction(store,action.id)?.status!=='running') throw Error('Investigation cancelled.');
        if (snapshot(store,action.report_id,action.input)!==action.baseline) throw Error('Inputs changed during investigation. Start a new investigation.');
        updateAction(store,action.id,'running',checkpoint);
      };
      result = action.input.operation === 'gap' ? await investigateGap(store,job,action.input,action.result,save,options) : await investigateHeadwaters(store,job,action.result,save,options);
    } else if (action.input.operation === 'prerequisite') {
      const terms = featureSearchTerms(action.input.query, 'river');
      const matches = store.jobs().filter(j => !j.superseded_by && j.type === 'river' && terms.includes(j.normalized));
      result = { applicable: true, query: action.input.query, existing: matches.map(j => summary(store,j)), message: 'Process this river as a separate request using approved data only. This will not associate it with the valley or approve a valley boundary.' };
    } else {
      result = { applicable: store.sources().some(s => s.status === 'approved' && s.type === job.type && s.format !== 'ga-dem'), before: summary(store, job), settings: store.featureSettings(job.id),
        message: 'Retry this feature with its current settings and approved sources. Automatic AI research will be disabled; the result may remain partial or unavailable.' };
    }
    if (getAction(store, action.id).status !== 'running') return;
    editable(store, action.report_id);
    if (snapshot(store, action.report_id, action.input) !== action.baseline) { updateAction(store, action.id, 'stale', { ...result, message: 'Inputs changed during investigation. Investigate again before applying.' }); return; }
    if (action.input.operation === 'gap') {
      store.db.exec('BEGIN IMMEDIATE');
      try {
        result.candidateIds=[];
        for (const raw of result.discovered || []) {
          const candidate=sourceSchema.parse(raw), existing=store.sources().find(s=>s.url.toLowerCase()===candidate.url.toLowerCase());
          if (existing?.status==='rejected') continue;
          result.candidateIds.push(existing?.id || store.addSource(candidate));
        }
        store.db.prepare('UPDATE report_actions SET baseline=? WHERE id=?').run(snapshot(store,action.report_id,action.input),action.id);
        updateAction(store,action.id,'ready',result);
        store.db.exec('COMMIT');
      } catch(error) {store.db.exec('ROLLBACK');throw error;}
    } else updateAction(store, action.id, 'ready', result);
    store.event(job.id, 'report_investigated', JSON.stringify({ reportId: action.report_id, actionId }));
  } catch (error) {
    if (['queued','running'].includes(getAction(store, actionId)?.status)) updateAction(store, actionId, 'failed', { message: error.message });
  }
}

export function applyInvestigation(store, reportId, actionId, raw) {
  const input = z.object({ confirmed: z.literal(true), useSource: z.boolean().default(false), useAliases: z.boolean().default(false), useEstimate:z.boolean().default(false), note: z.string().trim().max(2000).default('') }).strict().parse(raw);
  const { job } = editable(store, reportId), action = getAction(store, actionId);
  if (!action || action.report_id !== reportId || action.kind !== 'investigate') throw Error('Investigation not found.');
  if (action.status === 'applied') return workflowView(store, reportId);
  if (action.status !== 'ready' || !action.result.applicable) throw Error('This investigation is not ready to apply.');
  if (action.baseline !== snapshot(store, reportId, action.input)) throw Error('Inputs or results changed. Investigate again before applying.');
  if (active(job)) throw Error('Wait for active feature processing to finish.');
  if (action.input.operation !== 'source' && (input.useSource || input.useAliases)) throw Error('Source changes require a source investigation.');
  if (input.useAliases && !input.note) throw Error('Record why the proposed aliases identify the same feature.');
  if (input.useEstimate && action.input.operation!=='gap') throw Error('Estimated connections require a gap investigation.');
  if (action.input.operation==='gap' && (!input.useEstimate || !input.note || !action.result.estimate)) throw Error('Explicitly approve the estimated connection and record your review evidence.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    let target = job, changed = false, newTarget = false;
    const before = summary(store, job);
    if (action.input.operation === 'prerequisite') {
      const previousIds = new Set(store.jobs().map(j => j.id));
      target = store.request(action.input.query, 'river'); newTarget = !previousIds.has(target.id);
    }
    if (action.input.operation === 'source') {
      const source = store.sources().find(s => s.id === action.input.sourceId);
      if (source.status !== 'approved' || source.type !== job.type || !['arcgis','geojson'].includes(source.format)) throw Error('Source approval/type changed. Investigate again.');
      const previous = store.featureSettings(job.id), settings = { ...previous };
      if (input.useAliases) {
        settings.aliases = [...new Set([...settings.aliases,...action.result.proposedAliases].map(normalize))].sort();
        if (settings.aliases.length > 20) throw Error('At most 20 aliases are supported.');
      }
      if (input.useSource) settings.preferredSourceId = source.id;
      changed = hash(previous) !== hash(settings);
      if (changed) {
        // These reviewed interpretations depend on the old identity and source selection.
        if (previous.valleyFloor || previous.terrain || previous.formationJunctions?.length || previous.estimatedConnections?.length) throw Error('Existing geographic reviews require Feature settings review before changing identity or source. No changes were applied.');
        store.setFeatureSettings(job.id, settings);
        store.invalidateFeature(job.id, 'Research action changed feature settings; reprocessing required.');
      }
    }
    if (action.input.operation==='gap') {
      const previous=store.featureSettings(job.id), connection=action.result.estimate;
      const connections=[...(previous.estimatedConnections||[])];
      if (!connections.some(c=>hash(c)===hash(connection))) connections.push(connection);
      if (connections.length>32) throw Error('At most 32 estimated connections are supported.');
      store.setFeatureSettings(job.id,{...previous,estimatedConnections:connections});
      changed=hash(previous.estimatedConnections||[])!==hash(connections);
      if (changed) store.invalidateFeature(job.id,'Reviewed terminal connection estimate added; reprocessing required.');
    }
    const reused = action.input.operation === 'prerequisite' && target.status === 'resolved' && store.jobFeatures(target.id).length;
    const joined = active(target);
    if (!reused && !joined) { store.setProcessingPolicy(target.id,{ allowResearch:false }); store.setting(`research:${target.id}`,'false'); store.retry(target.id); }
    else if (newTarget) {
      store.setProcessingPolicy(target.id,{ allowResearch:false }); store.setting(`research:${target.id}`,'false');
    }
    const outcome = { targetJobId: target.id, before: action.input.operation === 'prerequisite' ? action.result.existing : before, changed,
      ...(action.input.operation === 'source' ? { settingsBefore: action.result.beforeSettings, settingsAfter: store.featureSettings(job.id), selectedSourceName: input.useSource ? action.result.source.name : null, addedAliases: input.useAliases ? action.result.proposedAliases : [] } : {}),
      message: reused ? 'Existing resolved river reused. No valley association was created.' : joined ? 'River request is queued or already processing. No valley association was created.' : 'Changes applied and request queued without automatic AI research.' };
    updateAction(store, action.id, 'applied', { ...action.result, ...outcome });
    record(store, reportId, 'apply', 'completed', { investigationId: action.id, ...input }, outcome);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return workflowView(store, reportId);
}

export function changeReportState(store, id, raw) {
  const input = z.object({ state:z.enum(['active','deferred','dismissed']), reason:z.string().trim().max(2000) }).strict().parse(raw);
  editable(store,id,true);
  if (input.state !== 'active' && !input.reason) throw Error('A reason is required.');
  const flow = getFlow(store,id); flow.state=input.state; flow.reason=input.reason;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    saveFlow(store,id,flow);
    store.db.prepare('UPDATE reports SET status=? WHERE id=?').run(input.state === 'active' ? 'pending' : input.state,id);
    if (input.state !== 'active') store.db.prepare("UPDATE report_actions SET status='cancelled',updated=? WHERE report_id=? AND kind='investigate' AND status IN ('queued','running','ready')").run(now(),id);
    record(store,id,input.state,'completed',{ reason:input.reason });
    store.db.exec('COMMIT');
  } catch(error) { store.db.exec('ROLLBACK'); throw error; }
  return workflowView(store,id);
}

export function updateRecommendation(store,id,index,raw) {
  const input=z.object({ owner:z.enum(['unassigned','geoxpl','decision','specialist']),status:z.enum(['open','handled','deferred']),note:z.string().trim().max(2000) }).strict().parse(raw);
  const {report}=editable(store,id); validStep(report,index);
  if(input.status !== 'open' && !input.note) throw Error('Record a reason or evidence for handling/deferment.');
  const flow=getFlow(store,id); flow.steps[index]=input;
  store.db.exec('BEGIN IMMEDIATE');
  try { saveFlow(store,id,flow); record(store,id,'recommendation','completed',{index,...input}); store.db.exec('COMMIT'); }
  catch(error) { store.db.exec('ROLLBACK'); throw error; }
  return workflowView(store,id);
}

export function recordReportReview(store,id,status,notes) { record(store,id,'review','completed',{status,notes}); }
