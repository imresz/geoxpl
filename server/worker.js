import { importSource } from './importer.js';
import { processGeometry, algorithmVersion } from './processors.js';
import { research, aiConfigured } from './research.js';
import { createHash } from 'node:crypto';
import { deriveTerrainValley } from './terrain.js';
import { drainageFingerprint } from './valley-floor.js';

export function createWorker(store, options = {}) {
  const importer = options.importer || importSource, researcher = options.researcher || research;
  let busy = false, stopped = false;
  store.db.prepare("UPDATE jobs SET phase='queued',message='Resuming interrupted processing' WHERE status='pending' AND phase IN ('importing','processing','researching')").run();
  async function run(job) {
    if (store.getJob(job.id)?.superseded_by) return;
    const settings = store.featureSettings(job.id);
    const sources = store.sources().filter(s => s.status === 'approved' && s.type === job.type && s.format !== 'ga-dem' && (s.format !== 'vic-gmu250' || settings.valleyFloor?.sourceId === s.id)).sort((a, b) => a.id.localeCompare(b.id));
    const forceResearch = store.setting(`research:${job.id}`) === 'true';
    if (forceResearch) store.setting(`research:${job.id}`, 'false');
    const imports = [], failures = [];
    store.updateJob(job.id, 'pending', 'importing', 'Checking approved geographic sources');
    for (const source of sources) {
      try {
        const imported = await importer(source, job.query, undefined, settings, { progress: message => store.updateJob(job.id, 'pending', 'importing', message) });
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
    const output = processGeometry(job, imports, options.boundary || null, settings, { drainage: settings.valleyFloor && store.feature(settings.valleyFloor.drainageFeatureId) });
    const results = output.results || [];
    if (settings.terrain && output.result?.extentEstimate?.kind === 'valley_floor') {
      const floor = output.result;
      const elevation = store.sources().find(s => s.id === settings.terrain.sourceId);
      store.updateJob(job.id, 'pending', 'processing', 'Deriving an estimated valley extent from elevation data');
      try {
        const derived = await (options.terrainProcessor || deriveTerrainValley)(floor, elevation, settings.terrain, {
          runtimeDir: options.runtimeDir,
          saveImport: (checksum, payload, metadata) => store.addImport(elevation.id, job.id, checksum, payload, metadata)
        });
        results[results.indexOf(floor)] = derived;
        output.result = derived;
        store.event(job.id, 'terrain_derived', 'Estimated terrain extent and original valley floor retained separately.');
      } catch (error) {
        floor.warnings.push(`Terrain extension unavailable: ${error.message} Showing the reviewed valley floor only.`);
        store.event(job.id, 'terrain_failed', error.message);
      }
      const currentDrainage = store.feature(settings.valleyFloor.drainageFeatureId);
      if (JSON.stringify(store.featureSettings(job.id)) !== JSON.stringify(settings) ||
          JSON.stringify(store.sources().find(s => s.id === settings.terrain.sourceId)) !== JSON.stringify(elevation) ||
          sources.some(s => JSON.stringify(store.sources().find(c => c.id === s.id)) !== JSON.stringify(s)) ||
          !currentDrainage || currentDrainage.status !== 'resolved' || drainageFingerprint(currentDrainage) !== floor.principalDrainage.checksum) {
        store.invalidateFeature(job.id, 'Terrain inputs changed during processing.');
        return store.updateJob(job.id, 'pending', 'awaiting_review', 'Terrain inputs changed during processing. Review and retry.');
      }
    }
    if (failures.length) for (const result of results) result.selection.importFailures = failures;
    let featureId;
    if (results.length) {
      const saved = store.saveFeatures(job, results);
      if (saved.length === 1) featureId = saved[0].id;
    }
    else store.invalidateFeature(job.id, 'No current usable geometry. Review identity and source selection.');
    if (results.length > 1 && (!forceResearch || output.status === 'resolved')) {
      store.event(job.id, 'matching_features_processed', `${results.length} distinct identities stored separately; selection is left to the user.`);
      return store.updateJob(job.id, output.status, output.status === 'resolved' ? 'completed' : 'awaiting_data', `${output.message}${output.status === 'resolved' ? '' : ' Some extents remain partial; each result shows its own evidence and estimates.'}`);
    }
    if (output.status === 'resolved') return store.updateJob(job.id, 'resolved', 'completed', 'Feature ready', featureId);
    if (output.result?.extentEstimate && !forceResearch) {
      store.event(job.id, 'valley_estimated', 'Partial valley estimate retained; no complete named valley boundary inferred.');
      return store.updateJob(job.id, output.status, 'available_estimate', `${output.result.extentEstimate.label} available. The dotted boundary is not a verified full valley extent.`, featureId);
    }
    if (output.result?.interpolations?.features.length && !forceResearch) {
      store.event(job.id, 'interpolated_connections', `${output.result.interpolations.features.length} estimated connections retained separately from recorded geometry.`);
      return store.updateJob(job.id, output.status, 'awaiting_data', 'Map available with dotted, interpolated connections. These are estimates; the full extent is not verified.', featureId);
    }
    if (output.result?.mainStem && !forceResearch) {
      const candidate = output.result.mainStem.status === 'candidate';
      store.event(job.id, 'main_stem_processed', candidate ? `Candidate: ${output.result.lengthKm.toFixed(1)} km; ${output.result.mainStem.componentRoutes.length} separate component routes. Not verified.` : output.result.mainStem.reason);
      return store.updateJob(job.id, output.status, 'awaiting_data', output.result.method === 'geofabric_directed_main_stem' ? output.result.warnings.join(' ') : candidate ? 'Main-stem candidate prepared. Verified branch choices, endpoints and any missing connections are still needed.' : output.result.mainStem.reason, featureId);
    }
    const diagnostics = { settings, status: output.status, warnings: results.flatMap(r => r.warnings), matches: results.map(r => ({ identityKey: r.identityKey, displayName: r.displayName, status: r.status, warnings: r.warnings, mainStem: r.mainStem })), identity: output.result?.identity, mainStem: output.result?.mainStem, selectedSourceId: results[0]?.selection.sourceId, comparisons: output.comparisons, importFailures: failures };
    if (!forceResearch && store.processingPolicy(job.id).allowResearch === false) {
      store.event(job.id, 'research_skipped', JSON.stringify({ reason: 'Batch policy: approved sources only', diagnostics }));
      return store.updateJob(job.id, output.status, 'awaiting_data', `${output.message} Automatic AI research is disabled for this batch request.`, featureId);
    }
    const relevant = results.length ? sources.filter(s => s.id === results[0].selection.sourceId) : sources;
    const relevantIds = new Set(relevant.map(s => s.id));
    const fingerprint = createHash('sha256').update(JSON.stringify({
      query: job.normalized || job.query, type: job.type, settings, algorithmVersion,
      sources: relevant.map(s => ({ id: s.id, url: s.url, nameField: s.nameField, idField: s.idField, completeness: s.completeness, version: s.version, licence: s.licence, attribution: s.attribution })),
      imports: imports.filter(i => relevantIds.has(i.source.id)).map(i => ({ sourceId: i.source.id, checksum: i.checksum, truncated: i.truncated })),
      evidence: { status: output.status, warnings: diagnostics.warnings, matches: diagnostics.matches, identity: diagnostics.identity, mainStem: diagnostics.mainStem, selectedSourceId: diagnostics.selectedSourceId },
      ai: aiConfigured(), model: process.env.OPENAI_MODEL || ''
    })).digest('hex');
    const cached = !forceResearch && store.reports().find(r => r.job_id === job.id && r.data.fingerprint === fingerprint && !['system', 'rate limit'].includes(r.data.provider));
    if (cached) {
      store.event(job.id, 'research_reused', `Unchanged processing evidence; retained report ${cached.id}`);
      return store.updateJob(job.id, output.status, cached.status === 'pending' ? 'awaiting_review' : 'awaiting_data', cached.status === 'pending' ? 'An existing research report is awaiting review. No new report was generated.' : 'Research has been reviewed. Updated geographic evidence or processing capability is needed; no further review is requested.', featureId);
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
      store.updateJob(job.id, results.length ? 'partially_resolved' : 'missing_capability', 'awaiting_review', 'Research could not finish. An administrator can review the request.', featureId);
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
