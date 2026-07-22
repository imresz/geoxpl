# geoxpl

Do not analyse the raw world from scratch on every query. Preprocess the difficult data, then assemble or derive the requested feature on demand.

Raw source data
      ↓
Preprocessed geographic data
      ↓
Query-time feature analysis
      ↓
Cached result



Raw source data

	This includes:

	OpenStreetMap roads, rivers and named features
	digital elevation models
	catchments and drainage basins
	government landform datasets
	Wikidata and geographic names

	These datasets are not yet optimised for your app.

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

	This work might take minutes or hours, but it happens periodically, not while a user waits.

Query-time analysis

	When the user searches for a feature, the app performs only the feature-specific work:

	identify the intended feature
	assemble relevant geometry
	infer start and end points
	calculate extent
	calculate confidence
	return display-ready GeoJSON

	Then the result is cached.
	

When a feature is queried
	1. Look in cache. Present if found
	2	a. If not found and can be quickly generated, pre-process then cache then present.
	2	b. If not found and will require significant pre-processing, show a try again soon message, then in the 	background perform pre and caching
	3. If cannot be pre-processed look for more raw data. and try preprocessing again.
		