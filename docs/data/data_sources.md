Raw source data

This includes:

OpenStreetMap roads, rivers and named features
digital elevation models
catchments and drainage basins
government landform datasets
Wikidata and geographic names

Preprocessed data

This is where expensive general-purpose work is done ahead of time:

import OSM into PostGIS
build road and river connectivity graphs
classify OSM features
create spatial indexes
simplify geometry for different zoom levels
ingest elevation rasters
calculate catchment adjacency
link OSM features to Wikidata
normalise names and aliases

When the user searches for a feature, the app performs only the feature-specific work:

identify the intended feature
assemble relevant geometry
infer start and end points
calculate extent
calculate confidence
return display-ready GeoJSON