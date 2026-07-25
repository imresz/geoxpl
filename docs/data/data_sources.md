# geoxpl data_sources.md
Raw source data
The initial data ingest

OpenStreetMap roads, rivers and named features
Digital elevation models
Catchments and drainage basins
Government landform datasets.
Wikidata and geographic names


Data sources are assessed per feature attribute for authority, fitness, coverage, completeness, currency, provenance and licence.

Data sources:
•	Authoritative: Establishes official names, boundaries, classifications or legal status.
•	Operational: Provides current conditions such as closures, warnings or flood status.
•	Reference: Provides descriptions, aliases and links.
•	Supplementary: Fills gaps or improves geometry where authoritative data is incomplete.
•	Derived: Produced by a GeoXpl algorithm from one or more source datasets.

Conflict Rules
When sources disagree, GeoXpl should:
1.	Keep both original records rather than overwriting one.
2.	Compare individual attributes rather than choosing one winning dataset.
3.	Prefer authoritative data for legal boundaries and official names.
4.	Prefer operational data for current status.
5.	Prefer the most complete, connected and suitable geometry for display.
6.	Record which source was selected for each displayed attribute.
7.	Lower confidence or expose the disagreement when it cannot be resolved.
8.	Never merge geometries silently; record the transformation that produced the result.


Confidence.
High confidence: Suitable authoritative source, or several reliable sources agree.
Medium confidence: Good source with gaps, transformations or minor disagreement.
Low confidence: Sparse data, significant inference, unresolved disagreement or uncertain extent.


Preprocessed data

This is where expensive general-purpose work is done ahead of time and performed by the computational layer :

import OSM into PostGIS
build road and river connectivity graphs
classify OSM features
create spatial indexes
simplify geometry for different zoom levels
ingest elevation rasters
calculate catchment adjacency
link OSM features to Wikidata
normalise names and aliases


