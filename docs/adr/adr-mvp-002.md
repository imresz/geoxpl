# geoxpl adr-mvp-001.md


# ADR 0002: MVP technical architecture

Status: Proposed

## Context

GeoXpl needs an admin area to approve data sources and to initiate bulk feature processing.

## Decision

Use a separate url.
Security not yet required for MVP.
Expose functionality through a web API.


## Alternatives considered

Google Maps, native mobile applications, synchronous preprocessing.

## Consequences

Security risk in short term.
May casue heavy workload initially.

