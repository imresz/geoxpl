import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { featureSearchTerms, now } from './store.js';

export const batchSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  name: z.string().trim().min(3).max(120),
  selectionNote: z.string().trim().min(10).max(3000),
  references: z.array(z.object({ title: z.string().trim().min(1).max(200), url: z.url().startsWith('https://') })).max(10).default([]),
  entries: z.array(z.object({ query: z.string().trim().min(2).max(150), type: z.enum(['river', 'valley']) })).min(1).max(100)
}).strict().refine(value => new Set(value.entries.map(e => `${e.type}:${featureSearchTerms(e.query, e.type)[0]}`)).size === value.entries.length, 'Batch names must be distinct, including optional River suffixes.');

const activePhases = new Set(['queued', 'importing', 'processing', 'researching']);

export function batchStatus(store, id) {
  const batch = store.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
  if (!batch) return null;
  const manifest = JSON.parse(batch.manifest);
  const counts = { resolved: 0, partial: 0, queued: 0, processing: 0, needsAttention: 0, failed: 0 };
  const items = store.db.prepare('SELECT * FROM batch_items WHERE batch_id=? ORDER BY position').all(id).map(item => {
    const job = store.currentJob(item.job_id);
    const matches = store.jobFeatures(job.id).map(f => ({ id: f.id, name: f.displayName || f.name, status: f.status, lengthKm: f.lengthKm }));
    const state = job.status === 'pending' && activePhases.has(job.phase) ? (job.phase === 'queued' ? 'queued' : 'processing')
      : job.status === 'resolved' && matches.length ? 'resolved'
      : job.status === 'failed' ? 'failed' : matches.length ? 'partial' : 'needsAttention';
    counts[state]++;
    return { position: item.position, query: item.query, type: item.type, jobId: job.id, disposition: item.disposition,
      state, status: job.status, phase: job.phase, message: job.message, updated: job.updated, matches,
      allowResearch: store.processingPolicy(job.id).allowResearch };
  });
  const pending = counts.queued + counts.processing;
  return { id, name: manifest.name, selectionNote: manifest.selectionNote, references: manifest.references, created: batch.created,
    status: pending ? 'running' : counts.resolved === items.length ? 'completed' : 'completed_with_issues',
    total: items.length, settled: items.length - pending, reused: items.filter(i => i.disposition === 'reused').length, counts, items };
}

export function listBatches(store) {
  return store.db.prepare('SELECT id FROM batches ORDER BY created DESC,id').all().map(row => batchStatus(store, row.id));
}

export function enqueueBatch(store, input) {
  const manifest = batchSchema.parse(input);
  // The manifest, job creation and no-AI policies commit together, before a worker can see them.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = store.db.prepare('SELECT manifest FROM batches WHERE id=?').get(manifest.id);
    if (existing) {
      if (!isDeepStrictEqual(JSON.parse(existing.manifest), manifest)) throw Error('This batch ID already exists with a different manifest. Use a new ID.');
      store.db.exec('COMMIT');
      return { created: false, batch: batchStatus(store, manifest.id) };
    }
    store.db.prepare('INSERT INTO batches VALUES(?,?,?)').run(manifest.id, JSON.stringify(manifest), now());
    for (const [position, entry] of manifest.entries.entries()) {
      const previousIds = new Set(store.jobs().map(j => j.id));
      const job = store.request(entry.query, entry.type);
      let disposition;
      if (job.status === 'pending' && activePhases.has(job.phase) && previousIds.has(job.id)) disposition = 'joined';
      else if (store.jobFeatures(job.id).length) disposition = 'reused';
      else {
        disposition = previousIds.has(job.id) ? 'retried' : 'queued';
        store.setProcessingPolicy(job.id, { allowResearch: false });
        store.setting(`research:${job.id}`, 'false');
        if (disposition === 'retried') store.retry(job.id);
        store.event(job.id, 'batch_queued', `${manifest.id}: approved sources only; automatic AI research disabled`);
      }
      store.db.prepare('INSERT INTO batch_items VALUES(?,?,?,?,?,?)').run(manifest.id, position + 1, entry.query, entry.type, job.id, disposition);
    }
    store.event(null, 'batch_created', `${manifest.id}: ${manifest.entries.length} entries`);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { created: true, batch: batchStatus(store, manifest.id) };
}
