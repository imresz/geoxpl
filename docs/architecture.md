# Architecture

## Style

Use a **modular monolith plus background worker** for MVP. Engines are
logical modules, not microservices. Do not distribute them without an
ADR demonstrating need.

## Components

**Web client:** MapLibre GL JS, search/results UI, provenance panel and
job-status polling. No geographic inference in browser.

**API/application layer:** validation, orchestration, admin
authorisation, response contracts and job dispatch.

**Search Resolver:** normalises query, searches names/aliases,
constrains eligibility to features intersecting Victoria,
ranks/disambiguates and resolves stable feature UUID. It does not derive
geometry.

**River Processor:** graph traversal, main-stem assembly, flow
decisions, endpoints, length, warnings and confidence.

**Valley Processor:** approved polygon selection and terrain/drainage
derivation.

**Terrain Service:** reads DEM/derived tiles and exposes elevation,
slope, flow, catchment and ridge products. It does not decide the
identity of a named valley.

**Provenance/Result Service:** immutable derivation records,
dependencies, versions, confidence/warnings and selection of current
derived result versus manual override.

**Background Worker:** expensive valley derivation, imports, terrain
preprocessing, stale refresh and admin reruns.

**Import Pipeline:** obtains approved releases, records
metadata/checksums, loads immutable raw/staging data, creates normalised
layers/topology/indexes and records import manifests.

## Storage

Use PostgreSQL/PostGIS schemas: - source-specific `raw_*`: immutable
imports; - `core`: canonical features/aliases; - `network`: normalised
hydro graph; - `derived`: results/dependencies; - `admin`:
overrides/review/audit; - `jobs`: job metadata if required.

Store DEM/large terrain products as Cloud Optimized GeoTIFFs or
ADR-approved tiled format, with metadata in PostgreSQL. PostgreSQL is
sufficient for persistent result caching initially. Add Redis only after
measurement demonstrates need.

## Flows

Search: `Browser -> API -> Resolver -> indexes -> candidates -> Browser`

Cached: `Browser -> API -> Result Service -> result/override -> Browser`

Uncached river:
`Browser -> API -> River Processor -> graph -> Result Service -> cache -> Browser`

Expensive valley:
`Browser -> API -> queue -> Worker -> Valley Processor -> Terrain Service/source data -> Result Service -> cache -> Browser polling`

Import:
`Approved source -> Import Pipeline -> raw/staging -> normalisation/topology -> dependency impact -> mark affected results stale`

## API

Version from start at `/api/v1`.

Minimum: - `GET /search?q=...` - `GET /features/{feature_id}` -
`GET /jobs/{job_id}` - controlled `POST /features/{feature_id}/derive` -
admin invalidate/review/source-exclusion/override endpoints.

Prefer GeoJSON-compatible responses. Allow simplified detail variants
for large geometry while retaining canonical server geometry.

## Module boundaries

Modules: `search`, `rivers`, `valleys`, `terrain`, `provenance`,
`imports`, `admin`. Cross-module work uses explicit interfaces, not
casual access to another module's private repository/tables.

## Versioning and stale data

Every result depends on feature identity version, source import IDs,
algorithm version and material parameters. Dependency changes mark
results stale without deleting history.

## Failure states

Use explicit states:
`not_found|ambiguous|processing|partial|unresolved|failed|stale`. Never
encode failure as empty geometry.

## Security

Public endpoints are read-only. Admin mutations require
authentication/authorisation. Parameterise SQL, validate inputs,
constrain import paths and never execute source-supplied code.

## Observability

Structured logs include request/job ID, feature ID, processor, algorithm
version, import IDs, duration, status and warnings. Measure resolver,
DB, river, valley and terrain timings.

## Scaling

First optimise indexes, query plans, geometry simplification, reusable
terrain products and derived caches. Microservices are not a performance
strategy.
