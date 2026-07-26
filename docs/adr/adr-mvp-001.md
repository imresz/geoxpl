# geoxpl adr-mvp-001.md


# ADR 0001: MVP technical architecture

Status: Approved

## Context

GeoXpl needs a browser map, geographic search, PostGIS geometry
storage and asynchronous preprocessing.

## Decision

Use MapLibre for the browser map.
Use PostgreSQL with PostGIS for geographic data.
Expose functionality through a web API.
Run preprocessing through a background worker.
Limit MVP processors to roads, rivers and national parks.

## Alternatives considered

Google Maps, native mobile applications, synchronous preprocessing.

## Consequences

Cross-border geometry can be stored and displayed.
Slow preprocessing will require job statuses.
Android and iOS native applications are outside the MVP.
Additional storage and staging requirements for preprocessing