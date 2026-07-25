# geoxpl algorithms.md

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

When the user searches for a feature, the system performs only the feature-specific work:

The search bar should consist of a text box to enter the name and drop list of features.
Searching “Murray River” and choosing the river item from the drop down lst, returns cached rivers whose names or aliases match the query. Results are ranked by exact name match and relevance to Victoria. Each candidate includes its name, feature type, locality and summary extent. If no suitable candidate exists, the user may request background processing. That request returns a queued, processing, ready, unavailable or failed status.

The search input comprises a name and a feature type. The feature type is select from a pull down list.
Spelling mistakes, aliases, route numbers, and partial names are supported.
Identically named features are ranked by size.
Search results should display feature name, type and a measure of size, say length, area, height.
If nothing is cached, then the search result should state this and provide an option to search. If this feature has already been searched for then a status of unavailable be returned with no further option to proceed other than to start a frrsh query.
Background processing can return the following statuses: not-processed, in-process or unavailable?
For features outside the Victorian test area, return not-processed.



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
		