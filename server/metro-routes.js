import { createHash } from 'node:crypto';
import { bbox, length, multiLineString } from '@turf/turf';
import { routeSource } from './road-routes.js';

export const metroSource = {
  ...routeSource,
  name: 'Vicmap Transport Road Line (metropolitan route review)',
  format: 'vic-metro-route-review',
  nameField: 'ezi_road_name',
  notes: 'Vicmap geometry matched to the October 2015 VicRoads metropolitan route maps. Current route membership is not verified.'
};
const manual = 'https://www.vicroads.vic.gov.au/~/media/files/technical-documents-new/traffic-engineering-manual-v2/tem-vol-2-part-215--as174215-direction-signs-information-signs-and-route-numbering.pdf#page=158';
const domain = 'https://bigbuild.vic.gov.au/__data/assets/pdf_file/0008/848699/MT-AZ-ConstructionUpdate-March-2024.pdf';
const plans = {
  '24': {
    names: ['LORNE STREET', 'HIGH STREET', 'HIGH STREET ROAD'],
    starts: [43912570, 43912572], ends: [15339553, 52206527],
    checks: [
      ['endpoint', 'Queens Road / Lorne Street', 'The street junction is corroborated, but the current signed western terminus and any approach-only shields are unverified.', 'https://www.portphillip.vic.gov.au/media/lbyjdxfx/copp-places-for-people-public-space-strategy-2022-2032-volume-3.pdf'],
      ['turn', 'Lorne Street / High Street', 'Vicmap connects these roads at St Kilda Road. Confirm which movements carry the Route 24 shield.', null],
      ['turn', 'High Street / High Street Road', 'The named roads connect in Vicmap. Confirm route signing across the name change.', 'https://bigbuild.vic.gov.au/__data/assets/pdf_file/0008/859589/SRL-Burwood-Structure-Planning-Boundary-map.pdf'],
      ['endpoint', 'High Street Road / Burwood Highway', 'Newer records corroborate the approach to Burwood Highway, not the exact signed eastern terminus.', 'https://www.parliament.vic.gov.au/parliamentary-activity/hansard/hansard-details/HANSARD-2145855009-33369']
    ],
    signage: 'Vicmap does not tag the matched segments as Route 24. A Monash Council document identifies one High Street Road section as Route 24, but continuous current signing has not been verified.',
    signageUrl: 'https://www.monlib.vic.gov.au/files/content/public/v/3/about-us/council/council-meetings/agendas-minutes/2021/27-july-2021/2.2-attachment-3-council-meeting-27-july-2021.pdf'
  },
  '26': {
    names: ['KERFERD ROAD', 'ALBERT ROAD', 'KINGS WAY', 'ST KILDA ROAD', 'TOORAK ROAD', 'BURWOOD HIGHWAY'],
    starts: [2328371], ends: [15339780, 76270871],
    checks: [
      ['endpoint', 'Beaconsfield Parade / Kerferd Road', 'Council records corroborate the junction, not the exact signed western terminus.', 'https://haveyoursay.portphillip.vic.gov.au/yani-barripbarripuyt'],
      ['turn', 'Kerferd Road / Albert Road', 'Vicmap connects the named roads. Confirm current route shields at the transition.', null],
      ['turn', 'Albert Road / Kings Way', 'Confirm the signed movement after the Domain precinct intersection changes.', domain],
      ['turn', 'Kings Way / St Kilda Road', 'Confirm the signed movement and whether the ALT1-tagged Kings Way sections overlap Route 26.', domain],
      ['turn', 'St Kilda Road / Toorak Road', 'The candidate uses Toorak Road east of St Kilda Road. Confirm the current signed movement after the Domain precinct works.', domain],
      ['turn', 'Toorak Road / Burwood Highway', 'Newer plans confirm the Warrigal Road junction. Check where Route 26 signage continues, overlaps with C412, or ends.', 'https://bigbuild.vic.gov.au/__data/assets/pdf_file/0006/920328/SRL-East-Draft-Structure-Plan-Housing-Needs-Assessment-Burwood.pdf'],
      ['endpoint', 'Burwood Highway / Mount Dandenong Tourist Road', 'Parks Victoria confirms the junction at Upper Ferntree Gully, not whether it remains the signed Route 26 terminus.', 'https://sitecore-prd.parks.vic.gov.au/places-to-see/parks/dandenong-ranges-national-park/things-to-do/1000-steps-walk']
    ],
    signage: 'Vicmap tags some matched Burwood Highway segments C412 and some Kings Way segments ALT1. Those tags do not establish whether Route 26 is still signed or where designations overlap.'
  }
};

export function buildMetroRoute(code, snapshot) {
  const plan = plans[code];
  const { audit, features: records } = snapshot;
  if (!Object.hasOwn(plans, code) || snapshot.type !== 'FeatureCollection' || audit?.code !== code ||
      audit.status !== 'candidate_only_current_signing_unverified' || !Number.isFinite(Date.parse(audit.retrievedAt)) ||
      !Array.isArray(records) || !records.length) throw Error('Expected a dated metropolitan route review snapshot.');
  const ids = new Set(), pfis = new Set(), junctions = [];
  let lastNode, roadIndex = -1;
  const lines = records.map(({ id, properties: p, geometry: g }) => {
    const from = p?.audit_from_node, to = p?.audit_to_node;
    const name = plan.names.indexOf(p?.ezi_road_name);
    const forward = from === p?.from_ufi && to === p?.to_ufi;
    const reverse = to === p?.from_ufi && from === p?.to_ufi;
    if (typeof id !== 'string' || !id || ids.has(id) || !Number.isSafeInteger(p?.pfi) || p.pfi <= 0 || pfis.has(p.pfi) ||
        ![from, to].every(n => Number.isSafeInteger(n) && n > 0) ||
        (!forward && !reverse) || (lastNode !== undefined && from !== lastNode) ||
        (name !== roadIndex && name !== roadIndex + 1) || name < 0 ||
        g?.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2 ||
        g.coordinates.some(c => !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) ||
          c[0] < 144.92 || c[0] > 145.34 || c[1] < -38.02 || c[1] > -37.78)) throw Error('Invalid or disconnected Vicmap review segment.');
    ids.add(id); pfis.add(p.pfi); lastNode = to;
    const line = forward ? g.coordinates : [...g.coordinates].reverse();
    if (name !== roadIndex) junctions.push({ node: from, coordinates: line[0] });
    roadIndex = name;
    return line;
  });
  if (!plan.starts.includes(records[0].properties.audit_from_node) || !plan.ends.includes(lastNode) ||
      roadIndex !== plan.names.length - 1) throw Error('The review path does not reach the documented candidate endpoints.');
  junctions.push({ node: lastNode, coordinates: lines.at(-1).at(-1) });
  const geometry = multiLineString(lines);
  const checks = plan.checks.map(([kind, label, note, evidenceUrl], i) => ({ ...junctions[i], kind, label, note, evidenceUrl }));
  const tagged = records.reduce((counts, { properties: p }) => {
    if (p.route_no) counts.set(p.route_no, (counts.get(p.route_no) || 0) + 1);
    return counts;
  }, new Map());
  return {
    checksum: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    result: {
      identityKey: `vicmap:metro-route:${code}`, displayName: `Metropolitan Route ${code} (Victoria)`,
      geometry: geometry.geometry, bbox: bbox(geometry), lengthKm: null, areaKm2: null,
      status: 'partially_resolved', confidence: 'candidate_alignment', method: 'vicmap_2015_metro_corridor_match',
      algorithmVersion: 'vicmap-metro-review/1', warnings: [],
      roadRoute: {
        code, retrievedAt: audit.retrievedAt, segments: records.length, components: 1,
        largestComponent: records.length, unverified: 0, mappedKm: length(geometry),
        names: records.map(r => r.properties.ezi_road_name).filter((n,i,a) => i === 0 || n !== a[i-1]),
        review: { baseline: manual, checks, signage: plan.signage, signageUrl: plan.signageUrl,
          codes: [...tagged].map(([code, count]) => ({ code, count })) }
      }
    }
  };
}
