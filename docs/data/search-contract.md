# geoxpl search-contract.md
#Specify search criterion


Search results should display feature name, type and a measure of size, say length, area, height.
If nothing is cached, then the search result should state this and provide an option to search. If this feature has already been searched for then return its current status and the option to start a fresh query.

The search bar should consist of a text box to enter the name and drop list of features.
Searching “Murray River” and choosing the river item from the drop down lst, returns cached rivers whose names or aliases match the query. Results are ranked by exact name match and relevance to Victoria. Each candidate includes its name, feature type, locality and summary extent. If no suitable candidate exists, the user may request background processing. The request returns one of the following statuses:
-	queued.	Accepted but not started
-	processing.	Background processing is running
-	ready.	A usable feature was produced
-	unavailable.	Processing completed but no defensible result was possible
-	failed.	A technical failure occurred and retry may be possible
-	out_of_scope.	Feature is outside the MVP area or type


The search input comprises a name and a feature type. The feature type is select from a pull down list.
Spelling mistakes, aliases, route numbers, and partial names are supported.

Identically named features are ranked in the following order:
1. selected feature type;
2. exact name or alias match;
3. intersection with the Victorian scope;
4. confidence/data quality;
5. size only as a final tie-breaker.