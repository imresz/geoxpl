import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTOUR_SOURCE, CONTOUR_MIN_ZOOM, CONTOUR_BOUNDS, contourSource, contourLayer, contourStyle, contourCoverage } from '../src/contours.ts';

test('contours use transparent projected official WMS tiles, constrained to Victorian coverage', () => {
  const source=contourSource(), url=new URL(source.tiles[0]);
  assert.equal(source.type,'raster'); assert.equal(source.tileSize,256);
  assert.equal(url.origin,'https://opendata.maps.vic.gov.au');assert.equal(url.pathname,'/geoserver/wms');
  for(const [key,value] of Object.entries({service:'WMS',request:'GetMap',layers:'open-data-platform:el_contour',srs:'EPSG:3857',format:'image/png',transparent:'true',bbox:'{bbox-epsg-3857}'}))assert.equal(url.searchParams.get(key),value);
  assert.ok(source.tiles[0].includes('{bbox-epsg-3857}'));
  assert.deepEqual(source.bounds,CONTOUR_BOUNDS);assert.equal(source.minzoom,CONTOUR_MIN_ZOOM);
  assert.match(source.attribution,/State of Victoria/);assert.match(source.attribution,/CC BY 4.0/);
  const layer=contourLayer();assert.equal(layer.source,CONTOUR_SOURCE);assert.equal(layer.type,'raster');
});

test('contour styling labels numeric elevations and changes detail by scale without provider string filters', () => {
  assert.match(contourStyle,/IEEERemainder/);assert.doesNotMatch(contourStyle,/PropertyIsLike/);
  assert.match(contourStyle,/<ogc:Literal>500<\/ogc:Literal>/);assert.match(contourStyle,/<ogc:Literal>100<\/ogc:Literal>/);
  assert.match(contourStyle,/<Label><ogc:PropertyName>altitude/);
  assert.equal(new URL(contourSource().tiles[0]).searchParams.get('sld_body'),contourStyle);
});

test('contour availability distinguishes zoom and geographic coverage', () => {
  assert.equal(contourCoverage([145,-38,146,-37],10),null);
  assert.match(contourCoverage([145,-38,146,-37],6),/overview/);
  assert.match(contourCoverage([150.1,-35,153,-33],12),/Outside/);
  assert.match(contourCoverage([144,-42,145,-41],12),/Outside/);
  assert.equal(contourCoverage([140,-38,145,-35],10),null);
});
