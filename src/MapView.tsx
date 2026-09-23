import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { featureLabel, type Feature, type Interpolation } from './api';
import { LocateFixed, Maximize, MapPin } from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';

const INITIAL: [number, number, number, number] = [137.5, -40.8, 151.2, -32.5];
const FEATURE_PADDING = { top: 70, right: 60, bottom: 110, left: 55 };
const padding = (map: maplibregl.Map) => map.getContainer().clientHeight < 330 ? { top: 35, right: 45, bottom: 50, left: 45 } : FEATURE_PADDING;
export function MapView({ feature, focus }: { feature: Feature | null; focus?: Interpolation | null }) {
  const element = useRef<HTMLDivElement>(null), map = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [center, setCenter] = useState('37.10 S, 144.35 E');
  const [showEstimates, setShowEstimates] = useState(true);
  const bounds = feature?.displayBbox || feature?.bbox || INITIAL;
  const estimates = feature?.interpolations?.features || [];
  const attribution = [...new Set(feature?.evidence.map(e => e.attribution).filter(Boolean) || [])].join(' · ');
  useEffect(() => { setShowEstimates(true); }, [feature?.id]);
  useEffect(() => {
    if (!element.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({ container: element.current, bounds: INITIAL, fitBoundsOptions: { padding: 40 }, attributionControl: false, maxZoom: 18,
        style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>' } }, layers: [{ id: 'basemap', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.45, 'raster-opacity': 0.9 } }] }
      });
    } catch { setError('This browser could not start the map. WebGL is required.'); return; }
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
    m.on('load', () => {
      m.addSource('victoria', { type: 'geojson', data: '/victoria.geojson', attribution: '<a href="https://www.geoboundaries.org/" target="_blank">geoBoundaries (CC BY 4.0)</a>' });
      m.addLayer({ id: 'victoria-outline', type: 'line', source: 'victoria', paint: { 'line-color': '#186454', 'line-width': 1.8, 'line-opacity': 0.65, 'line-dasharray': [4, 3] } });
      m.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'valley-fill', type: 'fill', source: 'selected', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#188a75', 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'feature-halo', type: 'line', source: 'selected', paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
      m.addLayer({ id: 'feature-line', type: 'line', source: 'selected', paint: { 'line-color': '#126fcb', 'line-width': 3.5 } });
      m.addSource('estimated-extent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'estimated-extent-fill', type: 'fill', source: 'estimated-extent', paint: { 'fill-color': '#a33f71', 'fill-opacity': 0.15 } });
      m.addLayer({ id: 'estimated-extent-halo', type: 'line', source: 'estimated-extent', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-dasharray': [0.1, 1.6] } });
      m.addLayer({ id: 'estimated-extent-line', type: 'line', source: 'estimated-extent', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#a33f71', 'line-width': 3, 'line-dasharray': [0.1, 3.2] } });
      m.addSource('interpolated', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'interpolated-halo', type: 'line', source: 'interpolated', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-dasharray': [0.1, 1.6] } });
      m.addLayer({ id: 'interpolated-line', type: 'line', source: 'interpolated', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#a33f71', 'line-width': 3, 'line-dasharray': [0.1, 3.2] } });
      m.addSource('endpoints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'endpoint-points', type: 'circle', source: 'endpoints', paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'kind'], 'source', '#186454', '#b84e36'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      setLoaded(true);
    });
    m.on('moveend', () => { const c = m.getCenter(); setCenter(`${Math.abs(c.lat).toFixed(2)} ${c.lat < 0 ? 'S' : 'N'}, ${Math.abs(c.lng).toFixed(2)} ${c.lng < 0 ? 'W' : 'E'}`); });
    m.on('error', e => { if (e.error?.message?.includes('victoria')) return; setError('Some map tiles are unavailable. Check your internet connection.'); });
    return () => { m.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!loaded || !map.current) return;
    (map.current.getSource('selected') as maplibregl.GeoJSONSource).setData(feature && !feature.extentEstimate ? { type: 'Feature', properties: {}, geometry: feature.geometry } : { type: 'FeatureCollection', features: [] });
    (map.current.getSource('estimated-extent') as maplibregl.GeoJSONSource).setData(feature?.extentEstimate ? { type: 'Feature', properties: {}, geometry: feature.geometry } : { type: 'FeatureCollection', features: [] });
    (map.current.getSource('interpolated') as maplibregl.GeoJSONSource).setData(feature?.interpolations || { type: 'FeatureCollection', features: [] });
    (map.current.getSource('endpoints') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: (['source', 'mouth'] as const).flatMap(kind => feature?.[kind] ? [{ type: 'Feature' as const, properties: { kind }, geometry: { type: 'Point' as const, coordinates: feature[kind]!.coordinates } }] : []) });
    if (feature) map.current.fitBounds(bounds, { padding: padding(map.current), maxZoom: 13, duration: 900 });
    const resize = new ResizeObserver(() => {
      map.current?.resize();
      if (map.current) map.current.fitBounds(bounds, { padding: feature ? padding(map.current) : 35, maxZoom: 13, duration: 0 });
    });
    if (element.current) resize.observe(element.current);
    return () => resize.disconnect();
  }, [feature, loaded]);
  useEffect(() => {
    if (!loaded || !map.current) return;
    for (const layer of ['interpolated-line', 'interpolated-halo', 'estimated-extent-fill', 'estimated-extent-halo', 'estimated-extent-line']) map.current.setLayoutProperty(layer, 'visibility', showEstimates ? 'visible' : 'none');
  }, [showEstimates, loaded]);
  useEffect(() => {
    if (!loaded || !map.current || !focus) return;
    setShowEstimates(true);
    const box = new maplibregl.LngLatBounds();
    focus.geometry.coordinates.forEach(p => box.extend([p[0], p[1]]));
    map.current.fitBounds(box, { padding: padding(map.current), maxZoom: 14, duration: 650 });
  }, [focus, loaded]);
  return <section className="map-region" aria-label="Interactive geographical map">
    <div className="map-canvas" ref={element} />
    <div className="map-summary"><div className="map-location"><MapPin size={14}/><span>{feature ? featureLabel(feature) : 'Southeastern Australia'}</span></div>
    {feature && <section className="map-legend" aria-label="Map legend"><strong>Map legend</strong>{feature.extentEstimate ? <><label><input type="checkbox" aria-label={`Show ${feature.extentEstimate.label.toLowerCase()}`} checked={showEstimates} onChange={e => setShowEstimates(e.target.checked)}/><i className="legend-interpolated"/>{feature.extentEstimate.label}</label><span>Partial; boundary unverified</span></> : <><span><i className="legend-recorded"/>Recorded geometry</span><label><input type="checkbox" aria-label="Show interpolated connections" checked={showEstimates} disabled={!estimates.length} onChange={e => setShowEstimates(e.target.checked)}/><i className="legend-interpolated"/>Interpolated (unverified)</label></>}</section>}
    {error && <div className="map-error" role="status">{error}<button aria-label="Dismiss map message" onClick={() => setError('')}>×</button></div>}</div>
    <div className="map-tools">
      <button title="Fit selected feature" aria-label="Fit selected feature" onClick={() => { if (map.current) map.current.fitBounds(bounds, { padding: feature ? padding(map.current) : 50 }); }}><Maximize size={18}/></button>
      <button title="Return to Victoria" aria-label="Return to Victoria" onClick={() => map.current?.fitBounds(INITIAL, { padding: 40 })}><LocateFixed size={18}/></button>
    </div>
    <span className="map-coordinates">{center}</span>
    {feature && <div className={`overlay-attribution${feature.extentEstimate ? ' estimated-attribution' : ''}`} title={attribution}>{attribution}</div>}
  </section>;
}
