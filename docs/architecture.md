# geoxpl architecture.md



		UI
			Browser
  			MapLibre map
			Search interface

          Search
             │
     ┌───────▼────────┐
     │ Geographic API │
     └───────┬────────┘
             │
     ┌───────▼────────┐
     │ Search Engine  │
     │ River Engine   │
     │ Road Engine    │
     │ Terrain Engine │
     │ Boundary Engine│
     └───────┬────────┘
             │
     ┌───────▼────────┐
     │ PostGIS + OSM  │
     │ DEM + Govt GIS │
     └────────────────┘