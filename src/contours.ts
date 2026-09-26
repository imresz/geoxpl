import type { RasterLayerSpecification, RasterSourceSpecification } from 'maplibre-gl';

export const CONTOUR_SOURCE = 'vicmap-contours';
export const CONTOUR_MIN_ZOOM = 7;
export const CONTOUR_BOUNDS: [number, number, number, number] = [140.5013, -39.1592, 150.068, -32.9999];
export const CONTOUR_PREFERENCE = 'geoxpl.contours';
export const CONTOUR_METADATA = 'https://discover.data.vic.gov.au/dataset/vicmap-elevation-10-20-contours-relief';
const layerName = 'open-data-platform:el_contour';
const line = (width: number) => `<LineSymbolizer><Stroke><CssParameter name="stroke">#896342</CssParameter><CssParameter name="stroke-width">${width}</CssParameter></Stroke></LineSymbolizer>`;
const every = (metres: number) => `<ogc:Filter><ogc:PropertyIsEqualTo><ogc:Function name="IEEERemainder"><ogc:PropertyName>altitude</ogc:PropertyName><ogc:Literal>${metres}</ogc:Literal></ogc:Function><ogc:Literal>0</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>`;
const label = `<TextSymbolizer><Label><ogc:PropertyName>altitude</ogc:PropertyName></Label><Font><CssParameter name="font-family">Arial</CssParameter><CssParameter name="font-size">12</CssParameter></Font><LabelPlacement><LinePlacement/></LabelPlacement><Halo><Radius>1</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo><Fill><CssParameter name="fill">#725035</CssParameter></Fill><VendorOption name="followLine">true</VendorOption><VendorOption name="repeat">180</VendorOption></TextSymbolizer>`;

// Numeric filters avoid the provider's default style applying string functions to altitude.
export const contourStyle = `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>${layerName}</Name><UserStyle><FeatureTypeStyle>
<Rule>${every(500)}<MinScaleDenominator>1000000</MinScaleDenominator><MaxScaleDenominator>8000000</MaxScaleDenominator>${line(0.9)}${label}</Rule>
<Rule>${every(100)}<MinScaleDenominator>100000</MinScaleDenominator><MaxScaleDenominator>1000000</MaxScaleDenominator>${line(0.9)}${label}</Rule>
<Rule><MaxScaleDenominator>100000</MaxScaleDenominator>${line(0.55)}</Rule>
<Rule>${every(100)}<MaxScaleDenominator>100000</MaxScaleDenominator>${line(1.1)}${label}</Rule>
</FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;

export function contourSource(): RasterSourceSpecification {
  const params = new URLSearchParams({ service: 'WMS', version: '1.1.1', request: 'GetMap', layers: layerName,
    styles: '', format: 'image/png', transparent: 'true', srs: 'EPSG:3857', width: '256', height: '256', sld_body: contourStyle });
  return { type: 'raster', tiles: [`https://opendata.maps.vic.gov.au/geoserver/wms?${params}&bbox={bbox-epsg-3857}`],
    tileSize: 256, minzoom: CONTOUR_MIN_ZOOM, maxzoom: 18, bounds: [...CONTOUR_BOUNDS],
    attribution: `<a href="${CONTOUR_METADATA}" target="_blank">Vicmap Elevation &copy; State of Victoria (DTP)</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank">CC BY 4.0</a>)` };
}

export function contourLayer(): RasterLayerSpecification {
  return { id: CONTOUR_SOURCE, type: 'raster', source: CONTOUR_SOURCE, minzoom: CONTOUR_MIN_ZOOM,
    paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } };
}

export function contourCoverage(bounds: [number, number, number, number], zoom: number): string | null {
  if (bounds[2] < CONTOUR_BOUNDS[0] || bounds[0] > CONTOUR_BOUNDS[2] || bounds[3] < CONTOUR_BOUNDS[1] || bounds[1] > CONTOUR_BOUNDS[3]) return 'Outside Victorian contour coverage';
  if (zoom < CONTOUR_MIN_ZOOM) return 'Contours hidden at overview scale';
  return null;
}
