# geoxpl data_sources.md
Raw source data
The initial data ingest

OpenStreetMap roads, rivers and named features
Digital elevation models
Catchments and drainage basins
Government landform datasets.
Wikidata and geographic names


Trust levels in order from high to low
Government
OpenStreetMap roads, rivers and named features
Private data sources with public access
Wikidata and geographic names
Other private sources



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


