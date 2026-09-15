# Data Sources

## Governance

Only sources listed here, or added after licence/technical review, may
feed production derivation.

Every import records publisher, product, source location, exact
licence/attribution, retrieval time, release/version, coverage, CRS,
checksum where practical, import ID and transformations.

Never scrape or trace proprietary consumer maps.

## OpenStreetMap

Approved for names/aliases, waterway geometry/topology clues,
waterbodies, cross-border continuity and supplementary named features.

OSM data is licensed under **ODbL 1.0**. Public use must provide
OpenStreetMap attribution and make the ODbL status clear. Preserve OSM
object type, ID, version and import date.

OSM is evidence, not automatic truth. Do not use public OSM tiles or
public Overpass as the production bulk backend; use a regional
extract/update process.

Official information: `https://www.openstreetmap.org/copyright`

## Victoria: Vicmap Hydro

Preferred Victorian authoritative hydrographic vector source where its
semantics fit. Victorian government documentation describes Vicmap Hydro
as statewide, maintained and topologically structured, available through
Data.Vic under a Creative Commons licence.

Record the **exact licence attached to each downloaded release**. Use
for watercourse geometry, hydrographic context and network
corroboration. Do not assume one source feature equals one application
river.

Victorian river names and geometry: https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Hydro/FeatureServer

## Geoscience Australia

Approved for reviewed national elevation/terrain products and other
specifically approved national datasets. Geoscience Australia states its
website material is generally CC BY 4.0 subject to
exceptions/third-party material; still verify and retain each product's
metadata/licence.

Use approved elevation products for valley terrain preprocessing.
https://services.ga.gov.au/

Copyright/licence: `https://www.ga.gov.au/copyright`

## NSW and South Australia

Cross-border data is required only to complete features intersecting
Victoria. 

SA water courses: https://location.sa.gov.au/lms/Reports/ReportMetadata.aspx?p_no=903&pu=yBefore 


NSW water courses:
https://datasets.seed.nsw.gov.au/dataset/nsw-hydrography/access_data

**Codex must not invent a NSW or SA dataset name/licence.** Add one only
after verified source review.

## Source precedence

There is no universal "authoritative source always wins" rule. Resolve
by attribute: - identity/name: gazetteer/government and OSM can
corroborate; - hydro geometry/topology: jurisdictional hydro data
preferred when fit, with OSM as corroboration/gap evidence; -
elevation/terrain: approved DEM; - valley extent: explicit
geomorphological polygon preferred over generic named-region geometry.

Conflicts are retained and logged, not silently overwritten.

## Mixing licences

Keep source records and provenance separable. Do not merge datasets into
a distributable database until licence compatibility/obligations have
been reviewed. ODbL share-alike implications for derived databases
require deliberate handling.

This document is an engineering source policy, not legal advice.

## Attribution

The UI must have a persistent attribution area capable of crediting
every source materially represented in the current map/result. Generated
exports, if later added, must carry required attribution too.

## Updates

Imports are versioned and reproducible. Never update raw tables in place
without retaining an import manifest/history. Determine affected derived
results through dependency records and mark only those stale where
practical.
