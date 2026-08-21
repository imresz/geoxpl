#GeoXpl mvp-geographic-feature-rules.md


RULES COMMON TO EVERY FEATURE.


PROVENANCE AND UNCERTAINTY.
If official data exists on a single map, then the extent/path is certain.
If many official sources are required and there is not agreement, then the extent/path is probable
If unoffical sources are used and there is agreement then the extent/path is possible.
If unoffical sources are used and there is onlty some agreement then the extent/path is maybe.


ROAD DEFINITION AND ASSEMBLY.
Represent a road as single or double solid line.
Include a route number if known.

ROUTE DEFINITION AND ASSEMBLY.
Represent a route as a single or double solid line
A route is made of one or more roads.
Show all roads from a route number.

RIVER MAIN-STEM AND ANABRANCH RULES.
Represent a river as a directed graph. Use graph traversal to identify the main stem source-to-mouth and calculate the longest upstream path.



NATIONAL PARK BOUNDARY RULES.
Use an authoritative, versioned Polygon or MultiPolygon.
Do not derive a replacement boundary in the MVP.




SOURCE-SELECTION PRIORITY DURING PROCESSING.

CALCULATION AND VALIDATION RULES.