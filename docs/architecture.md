# geoxpl architecture.md
# Specify workflow



Display layer
	UI
		Web pages
  		MapLibre map
		Search interface

Search layer
    Search
		Figure what to look for
		Present options if unclear

     ┌───────▼────────┐
     │ Geographic API │
     └───────┬────────┘
             │
Computational layer
	Build the info
     ┌───────▼────────┐
     │ Search Engine  │
     │ River Engine   │
     │ Road Engine 
	 │ NationalPark Engine
     │ Boundary Engine
		a geometry/API engine.

     └───────┬────────┘
             │
			 
			 
Search/API checks the processed-feature catalogue.
Search/API submits slow work to the background coordinator.
Background worker invokes the appropriate computational engine.
Engine stores the resulting processed feature.
Worker updates the job status.
API reads the status and result.		 
			 
			 

Background layer

	Background layer contains
- 		a persistent job/request store;
- 		a background worker;
-		data source processing engine which includes
- 		a processed-feature catalogue/cache;
- 		an approved source registry.

The background layer works with the data layer and at the completion of processing sends its output to the cache.

Data layer
     ┌───────▼────────┐
     │ PostGIS + OSM  │
     │ DEM + Govt GIS
	 │ Open data from private data sources
	   Cache
     └────────────────┘
	 
	 
Aministration layer.

Data source approval function
Admin initiated	bulk feature processing
	 
	 
Future Engines in computational layer
     Terrain Engine
	 Gradient Engine
	 Surface Engine
	 Status Engine
	 Additional feature-specific processors;

