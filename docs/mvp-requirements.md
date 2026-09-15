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

Free-text search must use case insensitive names and a feature type chosen from a drop down list. List currently contains two item: rive and valley.

Return river/valley candidates intersecting Victoria, provide
locality/catchment context for duplicate names, never silently choose a
materially ambiguous result, and resolve selection to a stable
application feature ID independent of source IDs.

## First-query behaviour

                    SEARCH
                      │
                      ▼
               Resolve feature
                      │
                      ▼
              FEATURE CATALOGUE
                 │          │
              EXISTS     ABSENT
                 │          │
                 ▼          ▼
              Display    Create job
                            │
                            ▼
                     Background Worker
                            │
                   ┌────────┴────────┐
                   ▼                 ▼
             River Processor   Valley Processor
                   │                 │
                   └────────┬────────┘
                            ▼
                    FEATURE CATALOGUE
                            │
                            ▼
                          Display

First-time derivation must not block the interactive request. All uncatalogued features are submitted to the background processing system.

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

Admin can inspect sources/logs, invalidate/rerun feature catalogue, mark manual
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
low-confidence valley; no defensible result; stale feature catalogue after
source/algorithm change.
