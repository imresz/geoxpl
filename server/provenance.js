import { normalize } from './store.js';

export function isProvenancePilot(feature) {
  return (feature.type === 'state_park' && normalize(feature.statePark?.officialName || feature.displayName || feature.name) === 'bunyip state park') ||
    (feature.type === 'river' && ['avoca', 'avoca river'].includes(normalize(feature.name)));
}

const methods = {
  plm25_named_state_park_parcels: 'Selected published PLM25 parcels by name and State Park classification, then merged their boundaries while preserving holes and separate areas.',
  geofabric_directed_main_stem: 'Assembled the river route from the directed Geofabric stream network.'
};

// Project the saved result only. Research suggestions and current source settings are not lineage.
export function mappingLineage(snapshot) {
  return {
    method: snapshot.method,
    description: methods[snapshot.method],
    processorVersion: snapshot.algorithmVersion,
    status: snapshot.status,
    geometryType: snapshot.geometry?.type,
    limitations: [...new Set([
      ...(snapshot.statePark?.limitations || []),
      ...(snapshot.mainStem?.limitations || []),
      ...(snapshot.warnings || []),
      ...(snapshot.interpolationSummary?.notes || [])
    ])],
    evidence: snapshot.evidence?.map(({ sourceName, sourceUrl, sourceVersion, attribution, licence, importId, checksum, objectId, role }) =>
      ({ sourceName, sourceUrl, sourceVersion, attribution, licence, importId, checksum, objectId, role })),
    estimates: snapshot.interpolations?.features.map(({ properties: { id, label, method, certainty, lengthKm, basis, evidenceRecord } }) =>
      ({ id, label, method, certainty, lengthKm, basis, evidenceRecord }))
  };
}
