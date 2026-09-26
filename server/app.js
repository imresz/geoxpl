import express from 'express';
import rateLimit from 'express-rate-limit';
import { scryptSync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { sourceSchema, aiConfigured } from './research.js';
import { normalize } from './store.js';
import { estimatedConnectionsSchema } from './interpolation.js';
import { valleyFloorSchema, landformEndpoint } from './valley-floor.js';
import { terrainSchema, demEndpoint } from './terrain.js';
import { formationJunctionsSchema } from './geofabric.js';

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
  const summary = f => ({ id: f.id, name: f.name, displayName: f.displayName || f.name, locationLabel: f.locationLabel, locationDescription: f.locationDescription, type: f.type, status: f.status, lengthKm: f.lengthKm, areaKm2: f.areaKm2, extentEstimate: f.extentEstimate, bbox: f.displayBbox || f.bbox });
  const viewJob = job => {
    const requested = job;
    if (job.superseded_by) job = store.currentJob(job.id);
    const matches = store.jobFeatures(job.id);
    return { id: job.id, query: job.query, type: job.type, status: job.status, phase: job.phase, message: job.message, created: job.created, updated: job.updated,
      ...(requested.superseded_by ? { requestedJobId: requested.id, supersededBy: job.id } : {}),
      selectionRequired: matches.length > 1, matches: matches.map(summary), feature: matches.length === 1 && job.feature_id ? store.feature(job.feature_id) : null };
  };
  const session = res => {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(createHash('sha256').update(token).digest('hex'), Date.now() + 8 * 3600000);
    res.cookie('geoxpl_session', token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies || false, maxAge: 8 * 3600000, path: '/' });
  };
  app.get('/api/config', (_req, res) => res.json({ name: 'GeoXpl', interactiveWaitMs: 5000, types: ['river', 'valley'] }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/catalogue', (_req, res) => res.json(store.features().filter(f => f.status === 'resolved').map(summary)));
  app.post('/api/search', rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many searches. Please wait a minute.' } }), (req, res) => {
    const input = z.object({ query: z.string().trim().min(2).max(150), type: z.enum(['river', 'valley']) }).parse(req.body);
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending' AND phase='queued'").get().n;
    if (count > 100) return res.status(429).json({ error: 'The processing queue is full. Please try again later.' });
    const job = store.request(input.query, input.type);
    res.status(job.status === 'resolved' ? 200 : 202).json(viewJob(job));
  });
  app.get('/api/jobs/:id', (req, res) => { const job = store.getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' }); res.json(viewJob(job)); });
  app.get('/api/features/:id', (req, res) => { const f = store.feature(req.params.id); if (!f) return res.status(404).json({ error: 'Feature not found.' }); res.json(f); });
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
  app.get('/api/admin/overview', (_req, res) => res.json({ jobs: store.jobs().map(j => ({ ...j, matches: store.jobFeatures(j.id).map(summary), settings: store.featureSettings(j.id) })), sources: store.sources(), reports: store.reports(), features: store.features().map(({ geometry, recordedNetwork, ...f }) => f), events: store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(), searches: store.db.prepare('SELECT COUNT(*) AS count FROM searches').get().count, imports: store.db.prepare('SELECT id,source_id,job_id,created,checksum FROM imports ORDER BY created DESC LIMIT 100').all(), aiConfigured: aiConfigured(), aiHourlyLimit: Math.max(1, Math.min(30, Number(process.env.AI_REQUESTS_PER_HOUR) || 3)) }));
  const validLandformSource = source => (source.format !== 'vic-gmu250' || (source.type === 'valley' && source.url === landformEndpoint)) && (source.format !== 'ga-dem' || (source.type === 'valley' && source.url === demEndpoint));
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
    store.decideSource(old.id, newStatus, source);
    for (const f of store.features().filter(f => f.evidence.some(e => e.sourceId === old.id))) {
      const j = store.db.prepare('SELECT job_id FROM features WHERE id=?').get(f.id);
      store.invalidateFeature(j.job_id, 'Source configuration or approval changed. Reprocessing required.');
      store.updateJob(j.job_id, 'pending', 'awaiting_review', 'Source approval changed; awaiting reprocessing');
    }
    if (newStatus === 'approved') for (const j of store.jobs().filter(j => !j.superseded_by && j.type === source.type && !['importing', 'processing', 'researching', 'queued'].includes(j.phase))) store.retry(j.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/jobs/:id/retry', (req, res) => {
    const j = store.getJob(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found.' });
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
    const settings = z.object({ aliases: z.array(z.string().trim().min(2).max(150)).max(20), preferredSourceId: z.string().nullable(), estimatedConnections: estimatedConnectionsSchema.optional(), formationJunctions: formationJunctionsSchema.optional(), valleyFloor: valleyFloorSchema.nullable().optional(), terrain: terrainSchema.nullable().optional() }).parse(req.body);
    const previous = store.featureSettings(job.id);
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
      if (!drainage || drainage.type !== 'river' || drainage.status !== 'resolved') return res.status(400).json({ error: 'Select a current resolved river as the principal drainage.' });
      definition.recordIds = [...new Set(definition.recordIds)].sort();
    }
    if (settings.preferredSourceId && !store.sources().some(s => s.id === settings.preferredSourceId && s.type === job.type && s.status === 'approved' && s.format !== 'ga-dem')) return res.status(400).json({ error: 'Select an approved vector source of the same feature type.' });
    if (JSON.stringify(settings) === JSON.stringify(store.featureSettings(job.id))) return res.json({ ok: true, unchanged: true });
    store.setFeatureSettings(job.id, settings);
    store.invalidateFeature(job.id, 'Feature identity or source selection changed. Reprocessing required.');
    store.retry(job.id); res.json({ ok: true });
  });
  app.post('/api/admin/jobs/:id/research', (req, res) => {
    const job = store.getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.superseded_by) return res.status(409).json({ error: 'This request is superseded. Use the current request.' });
    if (['queued', 'importing', 'processing', 'researching'].includes(job.phase)) return res.status(409).json({ error: 'A processing attempt is already active.' });
    store.setting(`research:${job.id}`, 'true');
    store.event(job.id, 'research_requested', 'Administrator requested fresh research');
    res.json(viewJob(store.retry(job.id)));
  });
  app.patch('/api/admin/reports/:id', (req, res) => {
    const input = z.object({ status: z.enum(['approved', 'rejected']), notes: z.string().max(4000) }).parse(req.body);
    const report = store.db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id); if (!report) return res.status(404).json({ error: 'Report not found.' });
    const data = { ...JSON.parse(report.data), adminNotes: input.notes, reviewed: new Date().toISOString() };
    store.db.prepare('UPDATE reports SET data=?,status=? WHERE id=?').run(JSON.stringify(data), input.status, report.id);
    store.event(report.job_id, `research_${input.status}`, input.notes || 'Administrator reviewed recommendation');
    const job = store.getJob(report.job_id);
    const latest = store.reports().find(r => r.job_id === report.job_id);
    if (job?.phase === 'awaiting_review' && job.status !== 'resolved' && latest?.id === report.id) {
      store.updateJob(job.id, job.status, 'awaiting_data', 'Research has been reviewed. Updated geographic evidence or processing capability is needed; no further review is requested.');
    }
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
  app.use((err, _req, res, _next) => { const validation = err instanceof z.ZodError; res.status(validation ? 400 : 500).json({ error: validation ? err.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') : 'The request could not be completed.' }); if (!validation) console.error(err); });
  return app;
}
