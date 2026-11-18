import { normalize } from './store.js';

export function isProvenancePilot(feature) {
  return (feature.type === 'state_park' && normalize(feature.statePark?.officialName || feature.displayName || feature.name) === 'bunyip state park') ||
    (feature.type === 'river' && ['avoca', 'avoca river'].includes(normalize(feature.name))) ||
    isEvidencePilot(feature);
}

function isEvidencePilot(feature) {
  return (feature.type === 'road_route' && !!feature.roadRoute) ||
    (feature.type === 'valley' && normalize(feature.name) === 'yarra valley' && !!feature.extentEstimate);
}

const methods = {
  plm25_named_state_park_parcels: 'Selected published PLM25 parcels by name and State Park classification, then merged their boundaries while preserving holes and separate areas.',
  geofabric_directed_main_stem: 'Assembled the river route from the directed Geofabric stream network.',
  vicmap_2015_metro_corridor_match: 'Matched the 2015 VicRoads route corridor to connected Vicmap road segments.',
  mapped_landform_valley_floor: 'Combined reviewed mapped terraces, fans and floodplains that intersect the principal drainage.',
  floor_anchored_terrain_segmentation: 'Extended the reviewed valley floor onto adjoining slopes using relative elevation. Competing terrain lows help constrain the edge.',
  local_knowledge_vicmap_match: 'An administrator selected Vicmap road segments using an attributed local contribution. Road connectivity does not verify the signed route or permitted turns.',
  vicmap_exact_route_code: 'Selected Vicmap road records carrying this exact route tag. A road may also have separately evidenced memberships of other routes.',
  dtp_exact_srns_code: 'Selected road records carrying this exact DTP SRNS code. Current signing and continuity are not independently verified.'
};

// Project the saved result only. Research suggestions and current source settings are not lineage.
export function mappingLineage(snapshot) {
  return {
    method: snapshot.method,
    description: methods[snapshot.method],
    processorVersion: snapshot.algorithmVersion,
    status: snapshot.status,
    geometryType: snapshot.geometry?.type,
    ...(snapshot.roadRoute?.contribution ? { contribution:snapshot.roadRoute.contribution } : {}),
    ...(snapshot.roadRoute?.review ? { routeReview: snapshot.roadRoute.review, routeSegments: snapshot.roadRoute.segments } : {}),
    ...(snapshot.extentEstimate ? {
      extent: snapshot.extentEstimate, areaKm2: snapshot.areaKm2, floorAreaKm2: snapshot.valleyFloor?.areaKm2,
      scaleSensitivity: snapshot.terrain?.sensitivity
    } : {}),
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
