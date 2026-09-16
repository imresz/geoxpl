import { importSource } from './importer.js';
import { processGeometry } from './processors.js';
import { research } from './research.js';

export function createWorker(store, options = {}) {
  const importer = options.importer || importSource, researcher = options.researcher || research;
  let busy = false, stopped = false;
  store.db.prepare("UPDATE jobs SET phase='queued',message='Resuming interrupted processing' WHERE status='pending' AND phase IN ('importing','processing','researching')").run();
  async function run(job) {
    const imports = [], failures = [];
    store.updateJob(job.id, 'pending', 'importing', 'Checking approved geographic sources');
    for (const source of store.sources().filter(s => s.status === 'approved' && s.type === job.type)) {
      try {
        const imported = await importer(source, job.query);
        const id = store.addImport(source.id, job.id, imported.checksum, imported.payload, { ...imported.metadata, truncated: imported.truncated });
        imports.push({ ...imported, source, id });
        store.event(job.id, 'imported', `${source.name}: ${imported.payload.features.length} records`);
      } catch (e) { failures.push(`${source.name}: ${e.message}`); store.event(job.id, 'import_failed', failures.at(-1)); }
    }
    const currentSources = store.sources();
    if (imports.some(i => JSON.stringify(currentSources.find(s => s.id === i.source.id)) !== JSON.stringify(i.source))) {
      return store.updateJob(job.id, 'pending', 'awaiting_review', 'A source changed during import. Review it and retry.');
    }
    store.updateJob(job.id, 'pending', 'processing', 'Assembling and validating geometry');
    const output = processGeometry(job, imports, options.boundary || null);
    if (failures.length && output.result) { output.result.warnings.push(...failures); output.result.status = output.status = 'partially_resolved'; output.result.confidence = 'review_required'; }
    let featureId;
    if (output.result) featureId = store.saveFeature(job, output.result).id;
    if (output.status === 'resolved') return store.updateJob(job.id, 'resolved', 'completed', 'Feature ready', featureId);
    store.updateJob(job.id, 'pending', 'researching', 'Investigating missing data or capability', featureId);
    try {
      const report = await researcher(job, store, [output.message, ...failures].join(' '));
      report.candidateIds = [];
      for (const candidate of report.candidates) {
        const exists = store.sources().find(s => s.url.toLowerCase() === candidate.url.toLowerCase());
        report.candidateIds.push(exists?.id || store.addSource(candidate));
      }
      store.report(job.id, report);
      store.updateJob(job.id, output.result ? 'partially_resolved' : 'pending', 'awaiting_review', 'Processing needs administrator review. Please try again later.', featureId);
    } catch (e) {
      store.report(job.id, { provider: 'system', summary: e.message, nextSteps: ['Check AI configuration or register a suitable source, then retry.'], evidence: [], candidates: [] });
      store.updateJob(job.id, output.result ? 'partially_resolved' : 'missing_capability', 'awaiting_review', 'Research could not finish. An administrator can review the request.', featureId);
    }
  }
  async function tick() {
    if (busy || stopped) return;
    const job = store.db.prepare("SELECT * FROM jobs WHERE status='pending' AND phase='queued' ORDER BY created LIMIT 1").get();
    if (!job) return;
    busy = true;
    try { await run(job); } catch (e) { store.updateJob(job.id, 'failed', 'failed', 'Processing failed. An administrator can retry.'); store.event(job.id, 'error', e.message); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, 350); timer.unref();
  return { tick, run, stop() { stopped = true; clearInterval(timer); }, get busy() { return busy; } };
}
