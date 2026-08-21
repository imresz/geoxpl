#GeoXpl mvp-functional-requirements.md

SEARCH (WORKFLOW, INPUTS, MATCHING AND RANKING, PRESENTATION, RESPONSE)

The search contract.


Present a web page with a search bar for free-form text entry and also a drop-down list of geographic featured. The initial map should be centred on Victorian and include surrounding regions as necessay to display a feature. 
The search input comprises a name and a feature type. The feature type is select from a pull down list.
Matching is case-insensitive and supports exact primary names, approved aliases and exact route numbers. Partial, typo-tolerant and general fuzzy matching are future features.

The seach function should in the first instance query the processed-feature catalog for a match. The match will have the status of ready in the catalog.

Searching for a feature by name and choosing the feature type from a drop down lst, returns stored rivers whose names or aliases match the query. Results are ranked by exact name match and relevance to Victoria. Each candidate includes its name, feature type, locality and summary extent. 

If a match is found with a status of processing, queued or awaiting_source_approval then a message to this effect should be displayed. The user should be invited to try again later. A message should be sent to the Administrator that this query result ocurred.

If the search result returned unavailable, failed or out_of_scope, return  message to the user and send a message to the Administrator that this query result occurred.

If nothing is stored in Processed-feature catalogue, then the search result should note the status. If the status is failed or unavailable then the option to start a fresh query should be given.



The selected search results should display feature name, type and a measure of size, say length, area, height on an interactive map.
Choosing one of the returned options displays the feature on an interactive map. 










Identically named features are ranked in the following order:
1. selected feature type;
2. exact name or alias match;
3. intersection with the Victorian scope;
4. confidence/data quality;
5. size only as a final tie-breaker.


The search status=ready returns the following for rendering
stable feature ID and type;
name and aliases;
GeoJSON geometry;
bounding box for map fitting;
length or area where applicable;
provenance for each geometry;
confidence and derivation method;
external information links.





BACKGROUND-PROCESSING WORKFLOW

A separate sub system handles the pre-processing. Pre-processing is where the searched for geographic feature does not exist in the catalogue and so must be identified and then stored in the catalogue.
Pre-processing attempts to identify a region extent by using osm data, wikipedia, federal, state and local government records and other sources of data identified as useful.

Published processing uses approved sources only.

The preprocessing step can comprise specialized geographical features "engines" which support the search engine. For example the would be a rivers geography engine, a roads engine, a National Park engine etc. Each engine uses its own form of geographic rules for identifying regions.

The extent of a region does not have to be exact.

Provenance means the source of the info is traceable but where there is contradiction or controversy, boundaries can be estimated and a low, medium or high confidence level attached. 

Pre-processing can be triggered by unmatched search requests as well as manually by the system administrator.





JOB STATUSES AND TRANSITIONS
If no suitable candidate exists, the user may request background processing.
The request returns one of the following statuses:
-	queued.	Accepted but not started.
-	processing.	Background processing is running.
-	awaiting_source_approval. For internal use. Public search return status = processing.
-	ready.	A usable feature was produced.
-	unavailable.	Processing completed but no defensible result was possible.
-	failed.	A technical failure occurred and retry may be possible.
-	out_of_scope.	Feature is outside the MVP area or type. Processing amy be needed to determine this.




DEDUPLICATION AND RETRY RULES.




MAP CONTROLS AND FEATURE-INFORMATION DISPLAY
All the normal map functionality should be enabled: pan, zoom, base map, attribution, current-location permission, and feature-info panel.


ADMINISTRATION WORKFLOW

A url to a password protected admin area should also be available.

Administration functions include adding data sources, approving the results of pre-processing, initiating pre-processing for a feature, deleting pre-processing results, adding new geogeographical features.

ESSENTIAL PERFORMANCE, ACCESSIBILITY AND SECURITY REQUIREMENTS
Administration area is password protected.


