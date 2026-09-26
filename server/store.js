import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const normalize = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU');
export function featureSearchTerms(query, type, aliases = []) {
  const name = normalize(query || '');
  const base = type === 'river' && name !== 'river' ? name.replace(/ river$/, '') : '';
  return [...new Set([...(base ? [`${base} river`, base] : [name]), ...aliases.map(normalize)].filter(Boolean))];
}
export const now = () => new Date().toISOString();
export function createStore(path = 'runtime/geoxpl.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
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
    CREATE TABLE IF NOT EXISTS job_policies(job_id TEXT PRIMARY KEY REFERENCES jobs(id), allow_research INTEGER NOT NULL CHECK(allow_research IN (0,1)));
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batch_items(batch_id TEXT NOT NULL REFERENCES batches(id), position INTEGER NOT NULL, query TEXT NOT NULL, type TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), disposition TEXT NOT NULL, PRIMARY KEY(batch_id,position), UNIQUE(batch_id,job_id));
  `);
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'superseded_by')) {
    db.exec('ALTER TABLE jobs ADD COLUMN superseded_by TEXT REFERENCES jobs(id)');
  }
  if (!db.prepare('PRAGMA table_info(features)').all().some(column => column.name === 'identity_key')) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE features_many(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, identity_key TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(job_id,identity_key));
      INSERT INTO features_many(id,job_id,identity_key,data,created) SELECT id,job_id,'single',data,created FROM features;
      DROP TABLE features;
      ALTER TABLE features_many RENAME TO features;
      COMMIT;`);
  }
  const getJob = id => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  const currentJob = id => {
    let job = getJob(id);
    const visited = new Set();
    while (job?.superseded_by) {
      if (visited.has(job.id)) throw Error('Cyclic request replacement.');
      visited.add(job.id); job = getJob(job.superseded_by);
    }
    return job;
  };
  const event = (job, action, detail) => db.prepare('INSERT INTO events(job_id,action,detail,created) VALUES(?,?,?,?)').run(job, action, detail, now());
  const invalidateDrainageDependents = ids => {
    if (!ids.length) return;
    const reason = 'Principal river geometry changed or was withdrawn. Retry to refresh the valley-floor estimate.';
    for (const row of db.prepare('SELECT id,job_id,data FROM features WHERE active=1').all()) {
      const data = JSON.parse(row.data);
      if (!ids.includes(data.principalDrainage?.featureId)) continue;
      data.status = 'partially_resolved'; data.warnings = [...new Set([...(data.warnings || []), reason])];
      db.prepare('UPDATE features SET active=0,data=? WHERE id=?').run(JSON.stringify(data), row.id);
      db.prepare("UPDATE jobs SET feature_id=NULL,status='insufficient_data',phase='awaiting_data',message=?,updated=? WHERE id=?").run(reason, now(), row.job_id);
      event(row.job_id, 'drainage_changed', reason);
    }
  };
  return {
    db, getJob, currentJob, event,
    processingPolicy(id) { const row = db.prepare('SELECT allow_research FROM job_policies WHERE job_id=?').get(id); return { allowResearch: row ? !!row.allow_research : true }; },
    setProcessingPolicy(id, { allowResearch }) { db.prepare('INSERT INTO job_policies VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET allow_research=excluded.allow_research').run(id, allowResearch ? 1 : 0); },
    supersedeJob(id, replacementId) {
      const old = getJob(id), replacement = currentJob(replacementId);
      if (!old || !replacement || old.id === replacement.id || old.type !== replacement.type ||
          !featureSearchTerms(old.query, old.type).includes(replacement.normalized)) throw Error('Replacement must be the same named feature and type.');
      if (old.superseded_by) {
        if (currentJob(old.id)?.id === replacement.id) return old;
        throw Error('This request already has a replacement.');
      }
      if (['queued', 'importing', 'processing', 'researching'].includes(old.phase)) throw Error('Wait for active processing to finish.');
      if (this.jobFeatures(old.id).length) throw Error('A request with active geometry cannot be superseded.');
      if (replacement.status !== 'resolved' || !this.jobFeatures(replacement.id).length) throw Error('Replacement must have a current resolved result.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE jobs SET superseded_by=?,status='superseded',phase='superseded',message=?,updated=? WHERE id=?")
          .run(replacement.id, `Superseded by ${replacement.query}. Original history retained.`, now(), old.id);
        event(old.id, 'superseded', JSON.stringify({ replacementJobId: replacement.id, previousStatus: old.status, previousPhase: old.phase, previousMessage: old.message }));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return getJob(old.id);
    },
    featureSettings(id) { const r = db.prepare('SELECT data FROM feature_settings WHERE job_id=?').get(id); return r ? JSON.parse(r.data) : { aliases: [], preferredSourceId: null }; },
    setFeatureSettings(id, data) { db.prepare('INSERT INTO feature_settings VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(data)); event(id, 'identity_updated', 'Feature aliases and source selection updated'); },
    invalidateFeature(jobId, reason) {
      const affected = db.prepare('SELECT id,data FROM features WHERE job_id=? AND active=1').all(jobId);
      for (const r of affected) {
        const data = JSON.parse(r.data); data.status = 'partially_resolved'; data.warnings = [...new Set([...(data.warnings || []), reason])];
        db.prepare('UPDATE features SET data=?,active=0 WHERE id=?').run(JSON.stringify(data), r.id);
      }
      db.prepare('UPDATE jobs SET feature_id=NULL WHERE id=?').run(jobId);
      invalidateDrainageDependents(affected.map(r => r.id));
    },
    setting(key, value) { if (value !== undefined) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, String(value)); return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; },
    request(query, type) {
      const canonical = query.trim().replace(/\s+/g, ' ');
      db.prepare('INSERT INTO searches(query,type,created) VALUES(?,?,?)').run(canonical, type, now());
      const terms = featureSearchTerms(canonical, type);
      // Older databases can have both spellings: prefer usable geometry, preserving all history.
      const existing = db.prepare(`SELECT * FROM jobs WHERE superseded_by IS NULL AND type=? AND normalized IN (${terms.map(() => '?').join(',')})
        ORDER BY EXISTS(SELECT 1 FROM features WHERE job_id=jobs.id AND active=1) DESC,
          (status='resolved') DESC, (status='pending') DESC, created, id LIMIT 1`).get(type, ...terms);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare('INSERT INTO jobs(id,query,normalized,type,status,phase,message,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(id, canonical, normalize(canonical), type, 'pending', 'queued', 'Preparing feature', now(), now());
      event(id, 'queued', 'New search request'); return getJob(id);
    },
    updateJob(id, status, phase, message, featureId = null) {
      db.prepare('UPDATE jobs SET status=?,phase=?,message=?,feature_id=COALESCE(?,feature_id),updated=? WHERE id=?').run(status, phase, message, featureId, now(), id);
      event(id, phase, message); return getJob(id);
    },
    retry(id) { if (getJob(id)?.superseded_by) throw Error('This request is superseded. Use the current request.'); db.prepare('UPDATE jobs SET attempts=attempts+1 WHERE id=?').run(id); return this.updateJob(id, 'pending', 'queued', 'Queued for another attempt'); },
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
    saveFeature(job, data) { return this.saveFeatures(job, [data])[0]; },
    saveFeatures(job, data) {
      const keys = data.map(f => f.identityKey || 'single');
      if (new Set(keys).size !== keys.length) throw Error('Matching features require distinct stable identity keys.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT id,identity_key FROM features WHERE job_id=?').all(job.id);
        db.prepare('UPDATE features SET active=0 WHERE job_id=?').run(job.id);
        const saved = data.map((value, index) => {
          const key = keys[index];
          const existing = previous.find(f => f.identity_key === key) || (data.length === 1 && previous.length === 1 && previous[0].identity_key === 'single' ? previous[0] : null);
          const id = existing?.id || randomUUID();
          const result = { ...value, identityKey: key, id, name: job.query, displayName: value.displayName || job.query, type: job.type, aliases: this.featureSettings(job.id).aliases, created: now() };
          db.prepare('INSERT INTO derivations VALUES(?,?,?,?)').run(randomUUID(), id, JSON.stringify(result), now());
          db.prepare('INSERT INTO features(id,job_id,identity_key,active,data,created) VALUES(?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET identity_key=excluded.identity_key,active=1,data=excluded.data').run(id, job.id, key, JSON.stringify(result), now());
          return result;
        });
        db.prepare('UPDATE jobs SET feature_id=? WHERE id=?').run(saved.length === 1 ? saved[0].id : null, job.id);
        if (job.type === 'river') invalidateDrainageDependents(previous.map(f => f.id));
        db.exec('COMMIT'); return saved;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    feature(id) { const r = db.prepare('SELECT data FROM features WHERE id=? AND active=1').get(id); return r ? JSON.parse(r.data) : null; },
    jobFeatures(id) { return db.prepare('SELECT data FROM features WHERE job_id=? AND active=1 ORDER BY identity_key').all(id).map(r => JSON.parse(r.data)); },
    features() { return db.prepare('SELECT data FROM features WHERE active=1 ORDER BY created DESC').all().map(r => JSON.parse(r.data)); },
    report(jobId, data) { const id = randomUUID(); db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(id, jobId, JSON.stringify(data), 'pending', now()); return id; },
    reports() { return db.prepare('SELECT * FROM reports ORDER BY created DESC').all().map(r => ({ ...r, data: JSON.parse(r.data) })); },
    close() { db.close(); }
  };
}
