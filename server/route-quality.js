export function routeQuality(feature) {
  const route=feature?.roadRoute;
  if(!route)return null;
  const local=!!route.contribution,review=!!route.review;
  const published=['vicmap_exact_route_code','dtp_exact_srns_code'].includes(feature.method);
  const numeric=published&&/^Numbered Route /i.test(feature.name||feature.displayName||'');
  return {
    coverage:{code:local?'selected_sections':feature.status==='resolved'?'connected_snapshot':'partial_snapshot',
      label:local?'Selected sections mapped':feature.status==='resolved'?'Connected source snapshot':'Partial alignment mapped',
      note:'Coverage describes the saved lines, not proof of the full signed route. Parallel carriageways are included; this is not a driving itinerary.'},
    designation:{code:local?'local_claim':review?'reviewed_candidate':numeric?'published_numeric_tag':published?'published_assignment':'unverified',
      label:local?'Local designation claim':review?'Reviewed corridor candidate':numeric?'Published numeric tag; scheme unconfirmed':published?'Published route assignment':'Designation unverified',
      note:local?'Attributed local evidence; current signs and permitted turns are unverified.':review?
        'A dated route reference matched to road geometry. Present-day designation, signs and endpoints remain unverified.':
        numeric?'The source records this number but does not establish a metropolitan or other numbering scheme. Current signing is unverified.':published?
        'The source assigns this code to these road records. Present-day signing and permitted turns have not been independently verified.':
        'The available evidence does not independently verify this route designation.'}
  };
}

export const withRouteQuality=feature=>feature ? {...feature,...(feature.roadRoute?{routeQuality:routeQuality(feature)}:{})} : null;
