# Development

## Technology choices

MVP defaults: - Python 3.13; - FastAPI + Pydantic for API/contracts; -
PostgreSQL 17 + PostGIS 3.x; - SQLAlchemy 2.x and Alembic migrations; -
GeoAlchemy2/Shapely/PyProj for vector operations; - Rasterio/GDAL for
terrain raster processing; - NetworkX acceptable for prototype graph
logic; move heavy traversal into PostgreSQL/pgRouting or a purpose-built
representation only after profiling; - background jobs:
Dramatiq/RQ/Celery choice requires a small ADR; prefer the simplest
reliable option; - TypeScript; - React + Vite; - MapLibre GL JS; -
pytest for backend; Vitest for frontend units; Playwright for
end-to-end; - Ruff + mypy backend; ESLint/Prettier frontend; - Docker
Compose for local PostgreSQL/PostGIS and supporting services.

Pin major dependencies and record upgrades. Avoid adding libraries for
trivial helpers.

## Repository

Suggested layout:

`backend/app/{search,rivers,valleys,terrain,provenance,imports,admin,shared}`

`backend/tests/{unit,integration,geographic_fixtures}`

`frontend/src/{map,search,features,admin,api}`

`data/` contains manifests/scripts only, not large source datasets
committed to Git.

`docs/` contains these specifications plus `adr/`.

## Coding rules

-   Domain language in code must match docs.
-   Type public interfaces.
-   Pure geographic decision functions where practical.
-   No raw SQL string interpolation.
-   CRS must be explicit at module boundaries.
-   Never compare geographic coordinates as if planar unless using an
    explicitly appropriate projected CRS.
-   Store canonical analysis geometry separately from display
    simplifications.
-   No hidden magic tolerances: named constants/config with rationale
    and tests.
-   No source-specific assumptions in generic domain code unless
    isolated in adapters.
-   Raw imports are read-only after ingestion.
-   Every derivation writes provenance.
-   Do not swallow geometry/topology errors.
-   Deterministic algorithms for identical inputs/version/parameters.

## Testing

Three levels: 1. unit tests for ranking, topology decisions,
confidence/status logic; 2. integration tests against PostGIS/raster
fixtures; 3. real geographic regression fixtures representing MVP
acceptance scenarios.

Tests assert invariants and key landmarks rather than exact full
geometry when upstream datasets can legitimately change.

Every bug involving wrong geographic extent gets a regression fixture
when legally/practically possible.

## Database migrations

All schema changes through Alembic. Migrations are forward-reviewed,
reproducible and must not rewrite immutable raw imports casually. Large
data rebuilds belong in explicit import/processing jobs, not opaque
schema migrations.

## Configuration

Use environment variables/settings for DB, object storage, queue and
source locations. Keep algorithm versions and material parameters
explicit. Secrets never committed.

## API contracts

Pydantic response models are versioned. Geometry status, confidence,
provenance and warnings are first-class fields, not free-text
afterthoughts.

## Performance

Before optimisation, capture query plan/timing. Add spatial indexes
deliberately and test their use. Never trade geographic correctness for
speed silently. If a fast approximation is returned, label it
provisional.

## Documentation and ADRs

Create an ADR for material choices such as: - exact NSW/SA source
datasets; - DEM product/resolution; - valley derivation algorithm; -
graph engine change; - background queue; - cache technology; - material
snapping/tolerance policy.

An ADR records context, decision, alternatives, consequences and date.

## Codex operating rules

Before implementation, Codex must read `docs/README.md` and every
document relevant to the task.

For each task Codex should: 1. restate affected requirements briefly; 2.
inspect existing code/tests before changing them; 3. propose an
implementation plan for non-trivial changes; 4. make the smallest
coherent change; 5. add/update tests; 6. run relevant lint/type/test
commands; 7. report changed files, tests run, assumptions and unresolved
issues.

Codex must not: - broaden MVP scope; - invent geographic datasets,
licences, identifiers or coordinates; - hard-code unexplained geographic
exceptions; - alter raw source data to make tests pass; - remove failing
tests without justification; - silently change domain definitions; - add
a microservice because a module is called an "engine"; - hide
uncertainty to make output look complete.

If the docs do not answer a geographic/product question, stop
implementation at the decision boundary and create a proposed ADR/issue
rather than guessing.

## Definition of done

A change is done only when: - requirement is traceable; - code follows
module boundaries; - tests cover normal and failure/ambiguity cases; -
provenance remains intact; - lint/type/tests pass; - docs/ADR updated
when behaviour or architecture changed; - no new unreviewed data source
or licence obligation was introduced.
