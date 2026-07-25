# geoxpl architecture.md


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
	 │ Render Engine
	   Background coordinator
     └───────┬────────┘
             │
Data layer
     ┌───────▼────────┐
     │ PostGIS + OSM  │
     │ DEM + Govt GIS
	 │ Open data from private data sources
     └────────────────┘
	 
	 
Future Engines
     │ Terrain Engine │
	 │ Gradient Engine
	 │ Surface Engine
	   Status Engine
