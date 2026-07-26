# geoxpl algorithms.md
# specify preprocessing, graph assembly and geometry derivation

Do not analyse the raw world from scratch on every query. Preprocess the difficult data, then assemble or derive the requested feature on demand.

The background activity

Raw source data
      ↓
Preprocessed geographic data
      ↓
Query-time feature analysis
      ↓
Cached result
      ↓






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


Query-time analysis

When the user searches for a feature, the system performs only the feature-specific work.


For features outside the Victorian test area, return out_of_scope.

The search engine queries cached data and or calls the required feature engines following the search contract to return a status and if available a result.

The engine(s) are called to do the following:

-	identify the intended feature
-	assemble relevant geometry
-	infer start and end points
-	calculate extent
-	calculate confidence
-	return display-ready GeoJSON
-	Then the result is cached.
	

When a feature is queried
	1. Look in cache. Present if found
	2	a. If not found and can be quickly generated, pre-process then cache then present.
	2	b. If not found and will require significant pre-processing, return status=queued and show a try again soon message, then in the background perform preprocessing and caching.
	3. If cannot be pre-processed look for more raw data. and try preprocessing again. 
		
The render engine is called to display the result.