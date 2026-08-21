# geoxpl adr-mvp-002.md


# ADR 0002: MVP administration and source approval

Status: Approved

## Context

GeoXpl needs an admin area to approve data sources and to initiate bulk feature processing.

## Decision

Use a separate url.
Require authentication.
Expose functionality through a web API.


## Alternatives considered

No admin UI, command-line administration, local-only administration, or authenticated web administration.

## Consequences

Risks not yet addressed: privileged operations, credential management, rate limiting, audit logging and potentially expensive bulk jobs.
May casue heavy workload initially.
Add administrator-only authorization, audit logging, rate limiting and protection against overlapping bulk jobs.

