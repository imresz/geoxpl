import { importSource } from './importer.js';
import { processGeometry, algorithmVersion } from './processors.js';
import { research, aiConfigured } from './research.js';
import { createHash } from 'node:crypto';

export function createWorker(store, options = {}) {
  const importer = options.importer || importSource, researcher = options.researcher || research;
  let busy = false, stopped = false;
  store.db.prepare("UPDATE jobs SET phase='queued',message='Resuming interrupted processing' WHERE status='pending' AND phase IN ('importing','processing','researching')").run();
  async function run(job) {
    const settings = store.featureSettings(job.id);
    const sources = store.sources().filter(s => s.status === 'approved' && s.type === job.type).sort((a, b) => a.id.localeCompare(b.id));
    const forceResearch = store.setting(`research:${job.id}`) === 'true';
    if (forceResearch) store.setting(`research:${job.id}`, 'false');
    const imports = [], failures = [];
    store.updateJob(job.id, 'pending', 'importing', 'Checking approved geographic sources');
    for (const source of sources) {
      try {
        const imported = await importer(source, job.query, undefined, settings);
        const id = store.addImport(source.id, job.id, imported.checksum, imported.payload, { ...imported.metadata, truncated: imported.truncated });
        imports.push({ ...imported, source, id });
        store.event(job.id, 'imported', `${source.name}: ${imported.payload.features.length} records`);
      } catch (e) { failures.push(`${source.name}: ${e.message}`); store.event(job.id, 'import_failed', failures.at(-1)); }
    }
    const currentSources = store.sources();
    if (sources.some(source => JSON.stringify(currentSources.find(s => s.id === source.id)) !== JSON.stringify(source)) || JSON.stringify(store.featureSettings(job.id)) !== JSON.stringify(settings)) {
      return store.updateJob(job.id, 'pending', 'awaiting_review', 'A source changed during import. Review it and retry.');
    }
    store.updateJob(job.id, 'pending', 'processing', 'Assembling and validating geometry');
    const output = processGeometry(job, imports, options.boundary || null, settings);
    if (failures.length && output.result) output.result.selection.importFailures = failures;
    let featureId;
    if (output.result) featureId = store.saveFeature(job, output.result).id;
    else store.invalidateFeature(job.id, 'No current usable geometry. Review identity and source selection.');
    if (output.status === 'resolved') return store.updateJob(job.id, 'resolved', 'completed', 'Feature ready', featureId);
    const diagnostics = { settings, status: output.status, warnings: output.result?.warnings || [], identity: output.result?.identity, selectedSourceId: output.result?.selection.sourceId, comparisons: output.comparisons, importFailures: failures };
    const fingerprint = createHash('sha256').update(JSON.stringify({
      query: job.normalized || job.query, type: job.type, settings, algorithmVersion,
      sources: sources.map(s => ({ id: s.id, url: s.url, nameField: s.nameField, idField: s.idField, completeness: s.completeness, version: s.version, licence: s.licence, attribution: s.attribution })),
      imports: imports.map(i => ({ sourceId: i.source.id, checksum: i.checksum, truncated: i.truncated })),
      diagnostics, ai: aiConfigured(), model: process.env.OPENAI_MODEL || ''
    })).digest('hex');
    const cached = !forceResearch && store.reports().find(r => r.job_id === job.id && r.data.fingerprint === fingerprint && !['system', 'rate limit'].includes(r.data.provider));
    if (cached) {
      store.event(job.id, 'research_reused', `Unchanged processing evidence; retained report ${cached.id}`);
      return store.updateJob(job.id, output.status, 'awaiting_review', 'Unchanged processing evidence. Administrator review is required.', featureId);
    }
    store.updateJob(job.id, 'pending', 'researching', 'Investigating missing data or capability', featureId);
    try {
      const report = options.allowResearch === false ? {
        provider: 'processing review', summary: output.message,
        nextSteps: [...diagnostics.warnings, ...failures, 'Review the source comparisons and feature settings. Request new research explicitly when needed.'], evidence: [], candidates: []
      } : await researcher(job, store, [output.message, ...diagnostics.warnings, ...failures].join(' '), diagnostics);
      report.fingerprint = fingerprint; report.diagnostics = diagnostics;
      report.candidateIds = [];
      for (const candidate of report.candidates) {
        const exists = store.sources().find(s => s.url.toLowerCase() === candidate.url.toLowerCase());
        report.candidateIds.push(exists?.id || store.addSource(candidate));
      }
      store.report(job.id, report);
      store.updateJob(job.id, output.status, 'awaiting_review', 'Processing needs administrator review. Please try again later.', featureId);
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
