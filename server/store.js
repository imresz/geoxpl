import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const normalize = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU');
export const now = () => new Date().toISOString();
export function createStore(path = 'runtime/geoxpl.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, query TEXT NOT NULL, normalized TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL, feature_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(normalized,type));
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, job_id TEXT NOT NULL, created TEXT NOT NULL, checksum TEXT NOT NULL, payload TEXT NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS features(id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS derivations(id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, job_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS searches(id INTEGER PRIMARY KEY, query TEXT NOT NULL, type TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_calls(id INTEGER PRIMARY KEY, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS feature_settings(job_id TEXT PRIMARY KEY REFERENCES jobs(id), data TEXT NOT NULL);
  `);
  const getJob = id => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  const event = (job, action, detail) => db.prepare('INSERT INTO events(job_id,action,detail,created) VALUES(?,?,?,?)').run(job, action, detail, now());
  return {
    db, getJob, event,
    featureSettings(id) { const r = db.prepare('SELECT data FROM feature_settings WHERE job_id=?').get(id); return r ? JSON.parse(r.data) : { aliases: [], preferredSourceId: null }; },
    setFeatureSettings(id, data) { db.prepare('INSERT INTO feature_settings VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(data)); event(id, 'identity_updated', 'Feature aliases and source selection updated'); },
    invalidateFeature(jobId, reason) {
      const r = db.prepare('SELECT id,data FROM features WHERE job_id=?').get(jobId);
      if (!r) return;
      const data = JSON.parse(r.data); data.status = 'partially_resolved'; data.warnings = [...new Set([...data.warnings, reason])];
      db.prepare('UPDATE features SET data=? WHERE id=?').run(JSON.stringify(data), r.id);
      db.prepare('UPDATE jobs SET feature_id=NULL WHERE id=?').run(jobId);
    },
    setting(key, value) { if (value !== undefined) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, String(value)); return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; },
    request(query, type) {
      const canonical = query.trim().replace(/\s+/g, ' ');
      db.prepare('INSERT INTO searches(query,type,created) VALUES(?,?,?)').run(canonical, type, now());
      const existing = db.prepare('SELECT * FROM jobs WHERE normalized=? AND type=?').get(normalize(canonical), type);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare('INSERT INTO jobs(id,query,normalized,type,status,phase,message,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(id, canonical, normalize(canonical), type, 'pending', 'queued', 'Preparing feature', now(), now());
      event(id, 'queued', 'New search request'); return getJob(id);
    },
    updateJob(id, status, phase, message, featureId = null) {
      db.prepare('UPDATE jobs SET status=?,phase=?,message=?,feature_id=COALESCE(?,feature_id),updated=? WHERE id=?').run(status, phase, message, featureId, now(), id);
      event(id, phase, message); return getJob(id);
    },
    retry(id) { db.prepare('UPDATE jobs SET attempts=attempts+1 WHERE id=?').run(id); return this.updateJob(id, 'pending', 'queued', 'Queued for another attempt'); },
    jobs() { return db.prepare('SELECT * FROM jobs ORDER BY updated DESC').all(); },
    sources() { return db.prepare('SELECT * FROM sources ORDER BY created DESC').all().map(r => ({ ...JSON.parse(r.data), id: r.id, status: r.status, created: r.created })); },
    addSource(data) {
      const id = randomUUID(); db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(id, JSON.stringify(data), 'pending', now());
      event(null, 'source_proposed', data.name); return id;
    },
    decideSource(id, status, data) { db.prepare('UPDATE sources SET status=?,data=? WHERE id=?').run(status, JSON.stringify(data), id); event(null, `source_${status}`, data.name); },
    addImport(sourceId, jobId, checksum, payload, metadata) {
      const existing = db.prepare('SELECT id FROM imports WHERE source_id=? AND job_id=? AND checksum=? AND metadata=? LIMIT 1').get(sourceId, jobId, checksum, JSON.stringify(metadata));
      if (existing) { event(jobId, 'snapshot_reused', 'Unchanged import snapshot retained'); return existing.id; }
      const id = randomUUID(); db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?)').run(id, sourceId, jobId, now(), checksum, JSON.stringify(payload), JSON.stringify(metadata)); return id;
    },
    saveFeature(job, data) {
      const existing = db.prepare('SELECT id FROM features WHERE job_id=?').get(job.id);
      const id = existing?.id || randomUUID();
      const result = { ...data, id, name: job.query, type: job.type, aliases: this.featureSettings(job.id).aliases, created: now() };
      db.prepare('INSERT INTO derivations VALUES(?,?,?,?)').run(randomUUID(), id, JSON.stringify(result), now());
      db.prepare('INSERT INTO features VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(id, job.id, JSON.stringify(result), now());
      return result;
    },
    feature(id) { const r = db.prepare('SELECT data FROM features WHERE id=?').get(id); return r ? JSON.parse(r.data) : null; },
    features() { return db.prepare('SELECT data FROM features ORDER BY created DESC').all().map(r => JSON.parse(r.data)); },
    report(jobId, data) { const id = randomUUID(); db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(id, jobId, JSON.stringify(data), 'pending', now()); return id; },
    reports() { return db.prepare('SELECT * FROM reports ORDER BY created DESC').all().map(r => ({ ...r, data: JSON.parse(r.data) })); },
    close() { db.close(); }
  };
}
