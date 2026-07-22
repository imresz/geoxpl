           UI

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
	 
	 
	 MVP below choose above or below
	 
	 
	 Browser
  │
  ├── MapLibre map
  └── Search interface
          │
          ▼
      Web API
          │
  ┌───────┼────────┐
  │       │        │
Search   Road     River
Engine   Engine   Engine
  │       │        │
  └───────┼────────┘
          ▼
      PostgreSQL
       + PostGIS
          │
    OSM Australia extract