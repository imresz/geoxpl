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
     └───────┬────────┘
             │
The computational layer interacts with the background layer by receiving requests to process identification and caching of geographical features. The computational layer receives a status from the background layer

Background layer

	Background layer contains
- 		a persistent job/request store;
- 		a background worker;
-		data source processing engine which includes
- 		a processed-feature catalogue/cache;
- 		an approved source registry.
- 		a geometry/API engine.

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
	 Feature-specific processors;

