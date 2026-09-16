import express from 'express';
import rateLimit from 'express-rate-limit';
import { scryptSync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { sourceSchema, aiConfigured } from './research.js';

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
  const viewJob = job => ({ id: job.id, query: job.query, type: job.type, status: job.status, phase: job.phase, message: job.message, created: job.created, updated: job.updated, feature: job.feature_id ? store.feature(job.feature_id) : null });
  const session = res => {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(createHash('sha256').update(token).digest('hex'), Date.now() + 8 * 3600000);
    res.cookie('geoxpl_session', token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies || false, maxAge: 8 * 3600000, path: '/' });
  };
  app.get('/api/config', (_req, res) => res.json({ name: 'GeoXpl', interactiveWaitMs: 5000, types: ['river', 'valley'] }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/catalogue', (_req, res) => res.json(store.features().filter(f => f.status === 'resolved').map(({ geometry, ...f }) => f)));
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
  app.get('/api/admin/overview', (_req, res) => res.json({ jobs: store.jobs(), sources: store.sources(), reports: store.reports(), features: store.features().map(({ geometry, ...f }) => f), events: store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(), searches: store.db.prepare('SELECT COUNT(*) AS count FROM searches').get().count, imports: store.db.prepare('SELECT id,source_id,job_id,created,checksum FROM imports ORDER BY created DESC LIMIT 100').all(), aiConfigured: aiConfigured(), aiHourlyLimit: Math.max(1, Math.min(30, Number(process.env.AI_REQUESTS_PER_HOUR) || 3)) }));
  app.post('/api/admin/sources', (req, res) => res.status(201).json({ id: store.addSource(sourceSchema.parse(req.body)) }));
  app.patch('/api/admin/sources/:id', (req, res) => {
    const old = store.sources().find(s => s.id === req.params.id); if (!old) return res.status(404).json({ error: 'Source not found.' });
    const { status, ...body } = req.body;
    const newStatus = z.enum(['pending', 'approved', 'rejected']).parse(status);
    const source = sourceSchema.parse(body);
    if (newStatus === 'approved' && (!source.licence.trim() || !source.attribution.trim())) return res.status(400).json({ error: 'Verified licence and attribution are required for approval.' });
    store.decideSource(old.id, newStatus, source);
    for (const f of store.features().filter(f => f.evidence.some(e => e.sourceId === old.id))) {
      f.status = 'partially_resolved'; f.warnings = [...f.warnings, 'Source configuration or approval changed. Reprocessing required.'];
      store.db.prepare('UPDATE features SET data=? WHERE id=?').run(JSON.stringify(f), f.id);
      const j = store.db.prepare('SELECT job_id FROM features WHERE id=?').get(f.id);
      store.updateJob(j.job_id, 'pending', 'awaiting_review', 'Source approval changed; awaiting reprocessing');
    }
    if (newStatus === 'approved') for (const j of store.jobs().filter(j => j.type === source.type && !['importing', 'processing', 'researching', 'queued'].includes(j.phase))) store.retry(j.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/jobs/:id/retry', (req, res) => {
    const j = store.getJob(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found.' });
    if (['queued', 'importing', 'processing', 'researching'].includes(j.phase)) return res.json(viewJob(j));
    res.json(viewJob(store.retry(j.id)));
  });
  app.patch('/api/admin/reports/:id', (req, res) => {
    const input = z.object({ status: z.enum(['approved', 'rejected']), notes: z.string().max(4000) }).parse(req.body);
    const report = store.db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id); if (!report) return res.status(404).json({ error: 'Report not found.' });
    const data = { ...JSON.parse(report.data), adminNotes: input.notes, reviewed: new Date().toISOString() };
    store.db.prepare('UPDATE reports SET data=?,status=? WHERE id=?').run(JSON.stringify(data), input.status, report.id);
    store.event(report.job_id, `research_${input.status}`, input.notes || 'Administrator reviewed recommendation');
    if (input.status === 'approved') { const j = store.getJob(report.job_id); if (!['queued','importing','processing','researching'].includes(j.phase)) store.retry(j.id); }
    else store.updateJob(report.job_id, 'insufficient_data', 'completed', 'No approved path to resolve this feature.');
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
  app.use((err, _req, res, _next) => { const validation = err instanceof z.ZodError; res.status(validation ? 400 : 500).json({ error: validation ? err.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') : 'The request could not be completed.' }); if (!validation) console.error(err); });
  return app;
}
