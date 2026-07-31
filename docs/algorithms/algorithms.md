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


An MVP feature is in scope when its authoritative or defensibly derived geometry intersects Victoria. Once eligible, GeoXpl processes and displays its complete defensible extent, including portions outside Victoria.

The search engine queries the data Processed-feature catalogue and or calls the required feature engines following the search contract to return a status and if available a result.

The engine(s) are called to do the following:

-	identify the intended feature
-	assemble relevant geometry
-	infer start and end points
-	calculate extent
-	calculate confidence
-	return display-ready GeoJSON
-	Then the result is cached.
	

When a feature is queried
	1. Look in cache or Processed-feature catalogue. Present if found
	2	a. If not found and can be quickly generated, pre-process then cache then present.
	2	b. If not found and will require significant pre-processing, return status=queued and show a try again soon message, then in the background perform preprocessing and caching.
	3. Search approved sources. If these are insufficient, discover candidate sources, set the internal job status to awaiting_source_approval, and resume processing only after approval.
		
The API returns display-ready GeoJSON and MapLibre renders it in the browser.