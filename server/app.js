import express from 'express';
import rateLimit from 'express-rate-limit';
import { scryptSync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { sourceSchema, aiConfigured } from './research.js';
import { normalize } from './store.js';
import { estimatedConnectionsSchema } from './interpolation.js';
import { valleyFloorSchema, landformEndpoint, eligibleValleyDrainage } from './valley-floor.js';
import { terrainSchema, demEndpoint } from './terrain.js';
import { terrainReasoningSchema,pilotInput } from './terrain-reasoning.js';
import { vicmapDemEndpoint } from './vicmap-dem.js';
import { formationJunctionsSchema } from './geofabric.js';
import { enqueueBatch, listBatches, batchStatus } from './batches.js';
import { workflowView, queueInvestigation, applyInvestigation, changeReportState, updateRecommendation, recordReportReview } from './report-workflow.js';
import { sourceChangeTargets } from './source-selection.js';
import { isProvenancePilot, mappingLineage } from './provenance.js';
import { routeCode, routeJobName } from './road-routes.js';
import { batchRouteEntry } from './road-route-batch.js';
import { readFileSync } from 'node:fs';
import { localRouteView, localRouteRoads, saveLocalRoute, previewLocalRoute, publishLocalRoute, withdrawLocalRoute, localRouteOptions, localRouteAlternatives } from './local-routes.js';
import { routeMembershipReport } from './route-memberships.js';
import { routeQuality,withRouteQuality } from './route-quality.js';
import { routeSearchInput,namedRouteMatches,findRouteDiscovery,getRouteDiscovery,listRouteDiscoveries,queueRouteDiscovery,routeDiscoveryView } from './route-discovery.js';
import { listBooks,bookDetail,saveBook,bookCitationFeatures,listBookCitations,saveBookCitation,withdrawBookCitation,bookReferenceCount,withBookReferenceCount,publicBookCitations } from './book-references.js';

export function createApp(store, config = {}) {
  const app = express(); app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      if (origin && new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Cross-origin changes are not allowed.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    }
    next();
  });
  const tokenFrom = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('geoxpl_session='))?.slice(15);
  const authenticated = req => {
    const token = tokenFrom(req); if (!token) return false;
    return !!store.db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(createHash('sha256').update(token).digest('hex'), Date.now());
  };
  const requireAdmin = (req, res, next) => authenticated(req) ? next() : res.status(401).json({ error: 'Administrator sign-in required.' });
  const summary = f => ({ id: f.id, name: f.name, displayName: f.displayName || f.name, locationLabel: f.locationLabel, locationDescription: f.locationDescription, type: f.type, status: f.status, lengthKm: f.lengthKm, areaKm2: f.areaKm2, extentEstimate: f.extentEstimate, bbox: f.displayBbox || f.bbox,
    ...(f.roadRoute ? {routeQuality:routeQuality(f)} : {}),
    ...(f.roadRoute?.contribution ? {localContribution:{author:f.roadRoute.contribution.author}} : {}) });
  const viewJob = job => {
    const requested = job;
    if (job.superseded_by) job = store.currentJob(job.id);
    const matches = [...store.jobFeatures(job.id),...localRouteAlternatives(store,job)];
    return { id: job.id, query: job.query, type: job.type, status: job.status, phase: job.phase, message: job.message, created: job.created, updated: job.updated,
      ...(requested.superseded_by ? { requestedJobId: requested.id, supersededBy: job.id } : {}),
      selectionRequired: matches.length > 1, matches: matches.map(summary), feature: matches.length === 1 ?
        withBookReferenceCount(store,job.type==='road_route' ? withRouteQuality(matches[0]) : job.feature_id ? store.feature(job.feature_id) : null) : null };
  };
  const discoveryResult=(input,row)=>({routeSearch:{query:input.query,
    matches:input.code?[]:namedRouteMatches(store,input,input.locality?(row?.state==='available'?row.data.records:[]):undefined).map(summary),
    discovery:routeDiscoveryView(store,row),offer:input.code&&!input.historical&&!row?{query:input.query,label:input.label}:null,
    message:input.historical?'Historical National Route 1 is separate from current route codes and has no mapped alignment here.':
      input.locality?'Road and locality evidence is checked before matching saved route sections.':'Matches refer to saved route alignments, not driving directions.'}});
  const session = res => {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(createHash('sha256').update(token).digest('hex'), Date.now() + 8 * 3600000);
    res.cookie('geoxpl_session', token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies || false, maxAge: 8 * 3600000, path: '/' });
  };
  app.get('/api/config', (_req, res) => res.json({ name: 'GeoXpl', interactiveWaitMs: 5000, types: ['river', 'valley', 'national_park', 'state_forest', 'state_park', 'road_route'] }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/route-discoveries',(_req,res)=>res.json(listRouteDiscoveries(store).map(r=>({id:r.id,query:r.input.query,state:r.state,updated:r.updated}))));
  app.get('/api/route-discoveries/:id',(req,res)=>{
    const row=getRouteDiscovery(store,req.params.id);if(!row)return res.status(404).json({error:'Route research not found.'});
    res.json(discoveryResult(row.input,row));
  });
  app.post('/api/route-discoveries',rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false}), (req,res)=>{
    const query=z.string().trim().min(2).max(150).parse(req.body.query);
    try{const input=routeSearchInput(query),row=queueRouteDiscovery(store,input);res.status(['queued','running'].includes(row.state)?202:200).json(discoveryResult(input,row));}
    catch(error){res.status(409).json({error:error.message});}
  });
  app.get('/api/catalogue', (req, res) => {
    const status = z.enum(['resolved', 'partially_resolved', 'all']).default('resolved').parse(req.query.status);
    res.json(store.features().filter(f => status === 'all' ? ['resolved', 'partially_resolved'].includes(f.status) : f.status === status).map(summary));
  });
  app.post('/api/search', rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many searches. Please wait a minute.' } }), (req, res) => {
    const input = z.object({ query: z.string().trim().min(2).max(150), type: z.enum(['river', 'valley', 'national_park', 'state_forest', 'state_park', 'road_route']), confirmType: z.boolean().default(false) }).parse(req.body);
    if (input.type === 'road_route') {
      let parsed;try{parsed=routeSearchInput(input.query);}catch(e){return res.status(400).json({error:e.message});}
      const code = parsed.code;
      const query = normalize(input.query);
      const byName = store.db.prepare("SELECT * FROM jobs WHERE type='road_route' AND normalized=? AND superseded_by IS NULL");
      const find = name => byName.get(normalize(name));
      const numeric = code && /^[0-9]+$/.test(code);
      const explicitMetro = /^(?:state|metro|metropolitan) route /.test(query);
      const explicitTag = /^numbered route /.test(query);
      const job = !code ? null : !numeric ? find(routeJobName(code)) : explicitTag ? find(`Numbered Route ${code}`) :
        find(`Metropolitan Route ${code}`) || (!explicitMetro && find(`Numbered Route ${code}`));
      if (!job) {
        let row=findRouteDiscovery(store,parsed);
        if(!parsed.code&&parsed.locality&&!parsed.historical&&!row) {
          try{row=queueRouteDiscovery(store,parsed);}catch(e){return res.status(429).json({error:e.message});}
        }
        return res.json(discoveryResult(parsed,row));
      }
      return res.status(job.status === 'pending' ? 202 : 200).json(viewJob(job));
    }
    if (!input.confirmType) {
      const matches = store.searchNameMatches(input.query);
      if (!matches.some(match => match.type === input.type)) {
        const alternatives = matches.map(match => ({ query: match.name, type: match.type, saved: true }));
        if (input.type !== 'river' && / (creek|river|brook|stream)$/.test(normalize(input.query)) && !alternatives.some(match => match.type === 'river')) {
          alternatives.push({ query: input.query, type: 'river', saved: false });
        }
        if (alternatives.length) return res.json({ alternatives });
      }
    }
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending' AND phase='queued' AND type!='road_route'").get().n;
    if (count > 100) return res.status(429).json({ error: 'The processing queue is full. Please try again later.' });
    const job = store.request(input.query, input.type);
    res.status(job.status === 'resolved' ? 200 : 202).json(viewJob(job));
  });
  app.get('/api/jobs/:id', (req, res) => { const job = store.getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' }); res.json(viewJob(job)); });
  app.get('/api/features/:id', (req, res) => { const f = store.feature(req.params.id); if (!f) return res.status(404).json({ error: 'Feature not found.' }); res.json(withBookReferenceCount(store,withRouteQuality(f))); });
  app.get('/api/features/:id/provenance', (req, res) => {
    const { id } = req.params;
    const feature = store.feature(id);
    const hasBooks=feature&&bookReferenceCount(store,id)>0;
    if (!feature || (!isProvenancePilot(feature)&&!hasBooks)) return res.status(404).json({ error: 'Mapping history is not available for this feature.' });
    const revisions = store.featureRevisions(id);
    const revisionId = req.query.revision ?? revisions[0]?.id;
    const revision = typeof revisionId === 'string' ? store.featureRevision(id, revisionId) : null;
    if (req.query.revision !== undefined && !revision) return res.status(404).json({ error: 'Geometry revision not found.' });
    res.json({ revisions, revisionId, lineage: revision ? mappingLineage(revision) : null,
      ...(hasBooks?{bookReferences:publicBookCitations(store,id,revisionId)}:{}),
      ...(revision?.type==='road_route' ? {routeQuality:routeQuality(revision),routeMemberships:routeMembershipReport(store.db,id,revisionId)} : {}) });
  });
  app.get('/api/admin/session', (req, res) => res.json({ authenticated: authenticated(req), setupRequired: !store.setting('password'), localSetup: config.localSetup !== false }));
  const loginLimit = rateLimit({ windowMs: 60000, limit: 8, message: { error: 'Too many sign-in attempts. Wait a minute.' } });
  app.post('/api/admin/setup', loginLimit, (req, res) => {
    if (config.localSetup === false || store.setting('password')) return res.status(403).json({ error: 'Administrator setup is not available.' });
    const password = z.string().min(12).max(200).parse(req.body.password);
    const salt = randomBytes(16).toString('hex');
    store.setting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    session(res); store.event(null, 'admin_setup', 'Local administrator created'); res.json({ ok: true });
  });
  app.post('/api/admin/login', loginLimit, (req, res) => {
    const password = z.string().min(1).max(200).parse(req.body.password);
    const saved = store.setting('password');
    if (!saved) return res.status(401).json({ error: 'Administrator setup required.' });
    const [salt, hash] = saved.split(':');
    if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'))) return res.status(401).json({ error: 'Incorrect password.' });
    session(res); res.json({ ok: true });
  });
  app.post('/api/admin/logout', requireAdmin, (req, res) => { const token = tokenFrom(req); store.db.prepare('DELETE FROM sessions WHERE token=?').run(createHash('sha256').update(token).digest('hex')); res.clearCookie('geoxpl_session', { path: '/' }); res.json({ ok: true }); });
  app.use('/api/admin', requireAdmin);
  const bookOperation=fn=>(req,res)=>{
    try{res.json(fn(req));}catch(e){res.status(e instanceof z.ZodError?400:e.status||409).json({error:e instanceof z.ZodError?e.issues.map(i=>i.message).join('; '):e.message});}
  };
  app.get('/api/admin/books',bookOperation(()=>listBooks(store)));
  app.get('/api/admin/books/:id',bookOperation(req=>bookDetail(store,z.uuid().parse(req.params.id))));
  app.post('/api/admin/books',bookOperation(req=>saveBook(store,null,req.body)));
  app.put('/api/admin/books/:id',bookOperation(req=>saveBook(store,z.uuid().parse(req.params.id),req.body)));
  app.get('/api/admin/book-reference-features',bookOperation(()=>bookCitationFeatures(store)));
  app.get('/api/admin/book-citations',bookOperation(req=>listBookCitations(store,req.query.featureId===undefined?undefined:z.uuid().parse(req.query.featureId))));
  app.post('/api/admin/book-citations',bookOperation(req=>saveBookCitation(store,null,req.body)));
  app.put('/api/admin/book-citations/:id',bookOperation(req=>saveBookCitation(store,z.uuid().parse(req.params.id),req.body)));
  app.post('/api/admin/book-citations/:id/withdraw',bookOperation(req=>withdrawBookCitation(store,z.uuid().parse(req.params.id),req.body)));
  app.get('/api/admin/route-discoveries',(_req,res)=>res.json(listRouteDiscoveries(store).map(row=>routeDiscoveryView(store,row,{history:true}))));
  app.post('/api/admin/route-discoveries/:id/retry',(req,res)=>{
    const row=getRouteDiscovery(store,req.params.id);if(!row)return res.status(404).json({error:'Route research not found.'});
    try{res.json(queueRouteDiscovery(store,row.input,{retry:true}));}catch(e){res.status(409).json({error:e.message});}
  });
  const contributionBoundary = () => config.boundary || JSON.parse(readFileSync(new URL('../public/victoria.geojson', import.meta.url)));
  const localOperation = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch(error) {
      res.status(error instanceof z.ZodError ? 400 : 409).json({error:error instanceof z.ZodError ? 'Check the contribution fields.' : error.message});
    }
  };
  app.get('/api/admin/local-routes', localOperation(() => localRouteOptions(store)));
  app.get('/api/admin/local-routes/:code', localOperation(req => localRouteView(store,req.params.code)));
  app.post('/api/admin/local-routes/:code/roads', localOperation(req => localRouteRoads(store,req.params.code,req.body,contributionBoundary(),config.contributionLoader)));
  app.put('/api/admin/local-routes/:code', localOperation(req => saveLocalRoute(store,req.params.code,req.body)));
  app.post('/api/admin/local-routes/:code/preview', localOperation(req => previewLocalRoute(store,req.params.code,contributionBoundary())));
  app.post('/api/admin/local-routes/:code/publish', localOperation(req => publishLocalRoute(store,req.params.code,req.body,contributionBoundary())));
  app.post('/api/admin/local-routes/:code/withdraw', localOperation(req => withdrawLocalRoute(store,req.params.code,req.body)));
  const reportOperation = fn => (req, res) => {
    try { res.json(fn(req)); }
    catch (error) { res.status(error instanceof z.ZodError ? 400 : 409).json({ error: error instanceof z.ZodError ? error.issues.map(i => i.message).join('; ') : error.message }); }
  };
  app.get('/api/admin/reports/:id/workflow', reportOperation(req => workflowView(store, req.params.id)));
  app.get('/api/admin/research-decisions', (_req, res) => {
    const candidates = store.db.prepare(`SELECT report_id FROM report_actions a
      WHERE kind='investigate' AND status='ready' AND rowid=(
        SELECT MAX(rowid) FROM report_actions WHERE report_id=a.report_id AND kind='investigate'
      )`).all();
    res.json(candidates.filter(({ report_id }) => {
      const view = workflowView(store, report_id);
      const result = view.actions.find(action => action.kind === 'investigate');
      return !view.readOnlyReason && view.state === 'active' && result?.status === 'ready' && !result.stale && result.result.applicable;
    }).map(({ report_id }) => report_id));
  });
  app.post('/api/admin/reports/:id/investigate', reportOperation(req => queueInvestigation(store, req.params.id, req.body)));
  app.post('/api/admin/reports/:id/actions/:actionId/apply', reportOperation(req => applyInvestigation(store, req.params.id, req.params.actionId, req.body)));
  app.post('/api/admin/reports/:id/state', reportOperation(req => changeReportState(store, req.params.id, req.body)));
  app.patch('/api/admin/reports/:id/steps/:index', reportOperation(req => updateRecommendation(store, req.params.id, z.coerce.number().int().min(0).parse(req.params.index), req.body)));
  app.get('/api/admin/batches', (_req, res) => res.json(listBatches(store)));
  app.get('/api/admin/batches/:id', (req, res) => {
    const batch = batchStatus(store, req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });
    res.json(batch);
  });
  app.post('/api/admin/batches', (req, res) => {
    try { const result = enqueueBatch(store, req.body); res.status(result.created ? 201 : 200).json(result.batch); }
    catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid batch manifest.', details: error.issues });
      res.status(409).json({ error: error.message });
    }
  });
  app.get('/api/admin/overview', (_req, res) => res.json({ jobs: store.jobs().map(j => ({ ...j, matches: store.jobFeatures(j.id).map(summary), settings: store.featureSettings(j.id) })), sources: store.sources(), reports: store.reports(), features: store.features().map(({ geometry, recordedNetwork, ...f }) => f.type === 'road_route' ? summary(f) : f), events: store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(), searches: store.db.prepare('SELECT COUNT(*) AS count FROM searches').get().count, imports: store.db.prepare('SELECT id,source_id,job_id,created,checksum FROM imports ORDER BY created DESC LIMIT 100').all(), aiConfigured: aiConfigured(), aiHourlyLimit: Math.max(1, Math.min(30, Number(process.env.AI_REQUESTS_PER_HOUR) || 3)) }));
  const validLandformSource = source => (source.format !== 'vic-gmu250' || (source.type === 'valley' && source.url === landformEndpoint)) && (source.format !== 'ga-dem' || (source.type === 'valley' && source.url === demEndpoint)) && (source.format !== 'vic-dem10m' || (source.type === 'valley' && source.url === vicmapDemEndpoint));
  app.post('/api/admin/sources', (req, res) => {
    const source = sourceSchema.parse(req.body);
    if (!validLandformSource(source)) return res.status(400).json({ error: 'Terrain and GMU250 sources require type Valley and their supported official endpoint.' });
    res.status(201).json({ id: store.addSource(source) });
  });
  app.patch('/api/admin/sources/:id', (req, res) => {
    const old = store.sources().find(s => s.id === req.params.id); if (!old) return res.status(404).json({ error: 'Source not found.' });
    const { status, ...body } = req.body;
    const newStatus = z.enum(['pending', 'approved', 'rejected']).parse(status);
    const source = sourceSchema.parse(body);
    if (!validLandformSource(source)) return res.status(400).json({ error: 'Terrain and GMU250 sources require type Valley and their supported official endpoint.' });
    if (newStatus === 'approved' && (!source.licence.trim() || !source.attribution.trim())) return res.status(400).json({ error: 'Verified licence and attribution are required for approval.' });
    if (newStatus === old.status && JSON.stringify(sourceSchema.parse(old)) === JSON.stringify(source)) return res.json({ ok: true, unchanged: true });
    const targets=sourceChangeTargets(store,old,source,newStatus);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.decideSource(old.id, newStatus, source);
      for (const id of targets.invalidate) {
        store.invalidateFeature(id, 'Source configuration or approval changed. Reprocessing required.');
        const job=store.getJob(id);
        if (!['queued','importing','processing','researching'].includes(job.phase)) store.updateJob(id, 'pending', 'awaiting_review', 'Source approval changed; awaiting reprocessing');
      }
      for (const id of targets.retry) store.retry(id);
      store.db.exec('COMMIT');
    } catch(error) {store.db.exec('ROLLBACK');throw error;}
    res.json({ ok: true, queued:targets.retry.length, invalidated:targets.invalidate.length });
  });
  app.post('/api/admin/jobs/:id/retry', (req, res) => {
    const j = store.getJob(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found.' });
    if (j.type === 'road_route' && (!batchRouteEntry(j.query) || !['failed','source_unavailable'].includes(j.status))) {
      return res.status(409).json({ error: 'Only failed audited route imports can be retried here.' });
    }
    if (j.superseded_by) return res.status(409).json({ error: 'This request is superseded. Use the current request.', replacementJobId: store.currentJob(j.id).id });
    if (['queued', 'importing', 'processing', 'researching'].includes(j.phase)) return res.json(viewJob(j));
    res.json(viewJob(store.retry(j.id)));
  });
  app.post('/api/admin/jobs/:id/supersede', (req, res) => {
    const input = z.object({ replacementJobId: z.string().min(1) }).parse(req.body);
    if (!store.getJob(req.params.id)) return res.status(404).json({ error: 'Job not found.' });
    try { store.supersedeJob(req.params.id, input.replacementJobId); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    res.json(viewJob(store.getJob(req.params.id)));
  });
  app.patch('/api/admin/jobs/:id/settings', (req, res) => {
    const job = store.getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.superseded_by) return res.status(409).json({ error: 'This request is superseded. Use the current request.' });
    if (['queued', 'importing', 'processing', 'researching'].includes(job.phase)) return res.status(409).json({ error: 'Wait for the active attempt to finish before changing feature settings.' });
    const settings = z.object({ aliases: z.array(z.string().trim().min(2).max(150)).max(20), preferredSourceId: z.string().nullable(), estimatedConnections: estimatedConnectionsSchema.optional(), formationJunctions: formationJunctionsSchema.optional(), valleyFloor: valleyFloorSchema.nullable().optional(), terrain: terrainSchema.nullable().optional(),terrainReasoning:terrainReasoningSchema.nullable().optional() }).parse(req.body);
    const previous = store.featureSettings(job.id);
    if(settings.terrainReasoning===undefined&&previous.terrainReasoning)settings.terrainReasoning=previous.terrainReasoning;
    if(settings.terrainReasoning){
      if(job.type!=='valley'||!store.sources().some(s=>s.id===settings.terrainReasoning.sourceId&&s.status==='approved'&&s.format==='vic-dem10m'&&validLandformSource(s)))return res.status(400).json({error:'Terrain reasoning requires an approved Vicmap numeric elevation source.'});
      try{pilotInput(settings.terrainReasoning,store.feature(settings.terrainReasoning.drainageFeatureId));}catch(error){return res.status(400).json({error:error.message});}
    }
    settings.aliases = [...new Set(settings.aliases.map(normalize))].filter(a => a !== job.normalized).sort();
    if (settings.formationJunctions === undefined && previous.formationJunctions && JSON.stringify(previous.aliases) === JSON.stringify(settings.aliases)) settings.formationJunctions = previous.formationJunctions;
    if (settings.formationJunctions?.length && job.type !== 'river') return res.status(400).json({ error: 'Named-watercourse junction reviews apply only to rivers.' });
    if (settings.estimatedConnections === undefined && previous.estimatedConnections && previous.preferredSourceId === settings.preferredSourceId && JSON.stringify(previous.aliases) === JSON.stringify(settings.aliases)) settings.estimatedConnections = previous.estimatedConnections;
    if (settings.valleyFloor === undefined && previous.valleyFloor && previous.preferredSourceId === settings.preferredSourceId && JSON.stringify(previous.aliases) === JSON.stringify(settings.aliases)) settings.valleyFloor = previous.valleyFloor;
    if (settings.terrain === undefined && settings.valleyFloor && previous.terrain && isDeepStrictEqual(previous.valleyFloor, settings.valleyFloor)) settings.terrain = previous.terrain;
    if (settings.terrain && (!settings.valleyFloor || job.type !== 'valley' || !store.sources().some(s => s.id === settings.terrain.sourceId && s.status === 'approved' && s.format === 'ga-dem' && validLandformSource(s)))) return res.status(400).json({ error: 'Terrain processing needs a reviewed valley floor and an approved Geoscience Australia DEM source.' });
    if (settings.valleyFloor) {
      const definition = settings.valleyFloor, drainage = store.feature(definition.drainageFeatureId);
      if (job.type !== 'valley' || definition.sourceId !== settings.preferredSourceId || !store.sources().some(s => s.id === definition.sourceId && s.status === 'approved' && s.type === 'valley' && s.format === 'vic-gmu250')) return res.status(400).json({ error: 'Select an approved GMU250 geometry source for this valley-floor definition.' });
      if (!eligibleValleyDrainage(definition, drainage)) return res.status(400).json({ error: 'Select a current resolved river as the principal drainage, or retain the explicitly reviewed mapped revision.' });
      definition.recordIds = [...new Set(definition.recordIds)].sort();
    }
    if (settings.preferredSourceId && !store.sources().some(s => s.id === settings.preferredSourceId && s.type === job.type && s.status === 'approved' && !['ga-dem','vic-dem10m'].includes(s.format))) return res.status(400).json({ error: 'Select an approved vector source of the same feature type.' });
    if (JSON.stringify(settings) === JSON.stringify(store.featureSettings(job.id))) return res.json({ ok: true, unchanged: true });
    store.setFeatureSettings(job.id, settings);
    store.invalidateFeature(job.id, 'Feature identity or source selection changed. Reprocessing required.');
    store.retry(job.id); res.json({ ok: true });
  });
  app.post('/api/admin/jobs/:id/research', (req, res) => {
    const job = store.getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.type === 'road_route') return res.status(409).json({ error: 'Road route snapshots use the Vicmap import script, not AI research.' });
    if (job.superseded_by) return res.status(409).json({ error: 'This request is superseded. Use the current request.' });
    if (['queued', 'importing', 'processing', 'researching'].includes(job.phase)) return res.status(409).json({ error: 'A processing attempt is already active.' });
    store.setting(`research:${job.id}`, 'true');
    store.event(job.id, 'research_requested', 'Administrator requested fresh research');
    res.json(viewJob(store.retry(job.id)));
  });
  app.patch('/api/admin/reports/:id', (req, res) => {
    const input = z.object({ status: z.enum(['approved', 'rejected']), notes: z.string().max(4000) }).parse(req.body);
    const report = store.db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id); if (!report) return res.status(404).json({ error: 'Report not found.' });
    const flow = store.db.prepare('SELECT state FROM report_workflows WHERE report_id=?').get(report.id);
    if (flow && flow.state !== 'active') return res.status(409).json({ error: 'Resume this report before marking it reviewed.' });
    const data = { ...JSON.parse(report.data), adminNotes: input.notes, reviewed: new Date().toISOString() };
    store.db.exec('BEGIN IMMEDIATE');
    try {
    store.db.prepare('UPDATE reports SET data=?,status=? WHERE id=?').run(JSON.stringify(data), input.status, report.id);
    store.event(report.job_id, `research_${input.status}`, input.notes || 'Administrator reviewed recommendation');
    recordReportReview(store, report.id, input.status, input.notes);
    const job = store.getJob(report.job_id);
    const latest = store.reports().find(r => r.job_id === report.job_id);
    if (job?.phase === 'awaiting_review' && job.status !== 'resolved' && latest?.id === report.id) {
      store.updateJob(job.id, job.status, 'awaiting_data', 'Research has been reviewed. Updated geographic evidence or processing capability is needed; no further review is requested.');
    }
    store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
  app.use((err, _req, res, _next) => { const validation = err instanceof z.ZodError; res.status(validation ? 400 : 500).json({ error: validation ? err.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') : 'The request could not be completed.' }); if (!validation) console.error(err); });
  return app;
}
