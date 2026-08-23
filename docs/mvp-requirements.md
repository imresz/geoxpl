# MVP Requirements

## Purpose

Build a web exploration map where a user searches for a named **river or
valley associated with Victoria** and sees its meaningful extent rather
than merely a geocoder point. It is not navigation, cadastral mapping,
or a legal boundary product.

## Geographic scope

A feature is eligible if it intersects Victoria. Processing must not
stop at the Victorian border: follow that same feature through NSW or SA
to its logical/natural extent. Do not include unrelated same-name
features. NSW/SA-only discovery is not required. Complete VIC/NSW/SA
source ingestion is allowed when simpler than arbitrary buffers.

## Rivers

Display the best-supported complete **named main stem** with geometry,
source/headwater and mouth/downstream endpoint when defensible,
displayed length, sources/source IDs, method, confidence, warnings,
import version and algorithm version. Tributaries are excluded unless
selected themselves.

## Valleys

Display approximate polygon/multipolygon extent, associated principal
drainage line when identified, boundary basis, confidence, warnings,
sources and versions. Derived boundaries must visibly say **Approximate
extent**.

## Search

Free-text search must use canonical names and aliases, return
river/valley candidates intersecting Victoria, provide
locality/catchment context for duplicate names, never silently choose a
materially ambiguous result, and resolve selection to a stable
application feature ID independent of source IDs.

## First-query behaviour

Use **cache first, derive on demand**: 1. resolve; 2. check current
cache; 3. return cache if current; 4. otherwise run feature processor;
5. cache success; 6. if work exceeds interactive budget, return approved
provisional geometry if available and queue deeper processing; 7. never
fabricate geometry/endpoints.

Targets after warm-up: candidate search p95 \<1 s; cached result p95 \<1
s; uncached river target \<5 s with 10 s synchronous ceiling; valley
work exceeding 10 s becomes a background job.

## Map

Use a legally usable attributed basemap; fit to full feature with
padding; retain cross-border context; highlight rivers; show endpoint
markers when supported; render valley uncertainty clearly.

## Result metadata

Expose canonical name/type, application feature ID, sources/object IDs,
method, confidence, generated time, source/import version, algorithm
version and warnings. Confidence enum: `high|medium|low|unresolved`. Do
not invent numeric confidence before calibration.

## Administrator

Admin can inspect sources/logs, invalidate/rerun cache, mark manual
review, disable bad source objects, apply/remove documented overrides
without altering raw data, inspect versions, trigger/monitor imports and
failed jobs. Overrides record actor, timestamp, reason, superseded
result and provenance.

## Integrity

Raw imports are immutable from application workflows. Derived data and
overrides are separate. Traceability is mandatory:

`display -> derived/override -> source records + algorithm/version`

## Exclusions

No roads, gradients, mountain ranges, parks, routing, user accounts,
public editing, nationwide/overseas search, automatic OSM editing,
cadastral claims or native mobile app.

## Acceptance scenarios

Test at least: VIC-only river; river extending into NSW; eligible
feature extending into SA; duplicate names; river through lake/reservoir
or data gap; valley with approved polygon; terrain-derived valley;
low-confidence valley; no defensible result; stale cache after
source/algorithm change.
