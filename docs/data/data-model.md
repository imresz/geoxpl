# geoxpl



Geographic features can be stand alone or also have components.
Use an authoritative polygon where one exists.
Otherwise use an existing OpenStreetMap polygon or relation.
Otherwise calculate an approximate boundary from elevation and drainage data.
Clearly label calculated boundaries as excact or approximate with a confidence level.

Geographic rules.
	Unless otherwise stated below, geographic features are uncertain polygons
	Roads are linear.
	Rivers are directed graphs.
	Mountains are dots with text showing the elevation
	Mountain ranges are uncertain polygons and may have a ridgeline. They may have sub ranges or belong to a parent range.
	Gorges are uncertain polygons and may have a line of maximum depth.
	Valleys are uncertain polygons and may be derived.
	NationalParks have defined boundaries.
	Volcanoes may be two concentric uncertain polygons, one indicating the cone and one indicating the base.
	
 