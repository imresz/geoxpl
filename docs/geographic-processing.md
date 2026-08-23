# Geographic Processing

## Principles

Never invent geometry. Never assume one source object equals the whole
real-world feature. Preserve raw source data. Store derivations and
overrides separately. Record provenance. State borders do not terminate
features. Prefer explainable deterministic processing. Return
`unresolved` rather than a persuasive wrong result. Rivers are
directed-network problems; valleys are interpreted terrain/drainage
regions. Parks are out of scope.

## Canonical identity

Create an application feature with UUID, type, canonical name, aliases,
locality/catchment context, source identifiers and
`intersects_victoria`. Source IDs are references, not primary identity.

## Rivers

Represent a river as a directed graph. Vertices are
endpoints/confluences/junctions/waterbody entry-exit points. Edges are
watercourse segments with geometry, name, source, length, class, flow
evidence and quality flags.

### Preprocessing

Normalise CRS; validate in staging; snap endpoints only within
documented source-appropriate tolerance; split at true confluences;
build spatial/name indexes and graph; preserve supplied direction; infer
flow only from approved evidence; precompute length; join cross-border
topology. Proximity alone is not connectivity.

### Query-time assembly

1.  Resolve candidate.
2.  Collect matching seed objects by name/aliases and spatial context.
3.  Expand through connected edges satisfying identity rules.
4.  Reject disconnected same-name components unless evidence joins them.
5.  Determine downstream direction and mouth candidate.
6.  Trace upstream main stem.
7.  Rank ambiguous branches by authoritative network identity, name
    continuity, stream hierarchy, hydrological continuity,
    upstream/catchment evidence, then terrain flow evidence.
8.  Record branch decisions.
9.  Merge ordered geometry and compute geodesic length.
10. Assign source and mouth with separate confidence.
11. create display simplifications.
12. persist provenance and cache.

A lake/reservoir does not automatically terminate a river. Derived
connectors through waterbodies require evidence and must be labelled
derived. Return partial/unresolved when continuity, flow or main-stem
choice remains materially ambiguous; partial results must not be called
"whole river".

## Valleys

A valley is a named elongated lowland/depression related to surrounding
higher terrain and commonly a drainage line. Its boundary is normally
interpretive.

Source hierarchy: 1. approved authoritative geomorphological polygon; 2.
approved published geographic polygon; 3. defensible OSM/other approved
open geometry; 4. terrain/drainage-derived extent; 5. reviewed manual
override.

A gazetteer point establishes identity/location, not extent.

### Reusable terrain preprocessing

Precompute hydrologically conditioned DEM where approved, slope, flow
direction/accumulation, catchments/subcatchments, watershed/ridgeline
candidates and any ADR-approved local-relief/terrain-position products.
Never recompute statewide terrain products per query.

### Query-time valley derivation

Resolve valley/seed; identify principal drainage; load relevant
precomputed terrain/catchments; establish analysis corridor; identify
valley floor and side transitions; constrain with ridges/watersheds;
prevent leakage into adjacent drainage systems; generate
polygon/multipolygon; simplify only for display; run coherence checks;
assign method/confidence/warnings; cache.

The production terrain algorithm requires an ADR and validation fixtures
before release.

Quality checks: seed containment, plausible drainage relationship,
topographic coherence, ridge leakage, fragmentation, threshold
sensitivity and agreement/disagreement with approved published extents.

Method enum:
`authoritative_source|published_source|osm_source|terrain_derived|manual_override`.

## Cross-border

After eligibility is established, continue into NSW/SA until the feature
ends. Record source jurisdiction per component and warn where datasets
disagree.

## Derived result

Persist result UUID, feature UUID, canonical geometry, display variants,
method/confidence, source references/import versions, algorithm
name/version, material parameters, generated time, warnings and status
`current|stale|review_required|unresolved|superseded`.

Mark stale when relevant source data, identity mapping, algorithm,
parameters or source exclusions change.

## Manual review

May resolve identity/branch decisions, exclude bad source records or
create override geometry. Never mutate raw imports.

## Geographic tests

Prefer invariants: complete river connectivity; no clipping at state
border; reproducible endpoints; valley contains seed; valley does not
cross major ridge without recorded reason; every output has provenance.
