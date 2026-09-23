import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { area, bbox, bboxPolygon, buffer, feature, booleanValid, difference, featureCollection, coordEach, polygon, intersect } from '@turf/turf';
import { publicBytes } from './network.js';

export const demEndpoint = 'https://services.ga.gov.au/gis/services/DEM_SRTM_1Second_2024/MapServer/WCSServer';
export const terrainVersion = 'terrain-valley/1.0.0';
export const terrainSchema = z.object({ sourceId: z.string().min(1), analysisScaleMetres: z.number().int().min(750).max(2000) }).strict();
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

export function coverageRequest(floor) {
  const bounds = bbox(buffer(bboxPolygon(floor.bbox), 12, { units: 'kilometers' }));
  if (!bounds.every(Number.isFinite) || bounds[0] < 113 || bounds[1] < -44 || bounds[2] > 154 || bounds[3] > -10) throw Error('The requested elevation extract is outside Australian DEM coverage.');
  const cells = Math.ceil((bounds[2]-bounds[0])*1200) * Math.ceil((bounds[3]-bounds[1])*1200);
  if (cells > 1_200_000) throw Error('The valley requires more than 1.2 million elevation cells; split the reviewed scope before terrain processing.');
  const params = new URLSearchParams({ service: 'WCS', version: '1.0.0', request: 'GetCoverage', coverage: '1', crs: 'EPSG:4326', response_crs: 'EPSG:4326',
    bbox: bounds.join(','), resx: String(1/1200), resy: String(1/1200), format: 'GeoTIFF', interpolation: 'bilinear' });
  return { url: `${demEndpoint}?${params}`, bounds, cells };
}

export function runTerrain(python, raster, input, timeout = 300000) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(python, [join(project, 'terrain', 'valley.py'), raster, input], { windowsHide: true, maxBuffer: 8_000_000, timeout }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') return reject(Error('Terrain Python environment is missing. Install terrain/requirements.txt in .venv-terrain.'));
        let detail;
        try { detail = JSON.parse(stderr.trim().split(/\r?\n/).at(-1)).error; } catch { /* Non-JSON interpreter errors should not expose local configuration. */ }
        return reject(Error(detail || (error.killed ? 'Terrain processing exceeded the five-minute limit.' : 'Terrain processor failed. Check the Python environment and elevation input.')));
      }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(Error('Terrain processor did not return valid JSON.')); }
    });
    child.on('error', () => {});
  });
}

export async function deriveTerrainValley(floor, source, config, options = {}) {
  const settings = terrainSchema.parse(config);
  if (!source || source.id !== settings.sourceId || source.status !== 'approved' || source.type !== 'valley' || source.format !== 'ga-dem' || source.url !== demEndpoint || !source.licence?.trim() || !source.attribution?.trim()) throw Error('An approved Geoscience Australia DEM source with licence and attribution is required.');
  if (floor.extentEstimate?.kind !== 'valley_floor') throw Error('Terrain processing requires a reviewed valley-floor estimate.');
  const request = coverageRequest(floor);
  const python = options.python || process.env.TERRAIN_PYTHON || join(project, '.venv-terrain', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!options.run) await access(python).catch(() => { throw Error('Terrain Python environment is missing. Install terrain/requirements.txt in .venv-terrain.'); });
  const root = resolve(options.runtimeDir || dirname(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite'), 'terrain');
  await mkdir(root, { recursive: true });
  const bytes = await (options.load || publicBytes)(request.url, 32_000_000, 'image/tiff');
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 32_000_000 || !['49492a00','4d4d002a'].includes(bytes.subarray(0,4).toString('hex'))) throw Error('Elevation service returned no usable GeoTIFF. Rendered map images cannot be used as heights.');
  const checksum = digest(bytes), filename = `${checksum}.tif`, raster = join(root, filename);
  const existing = await readFile(raster).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!existing || digest(existing) !== checksum) {
    const temporary = join(root, `${randomUUID()}.tif`);
    try { await writeFile(temporary, bytes); await rename(temporary, raster); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  const inputData = { floorGeometry: floor.geometry, requestedBbox: request.bounds, analysisScaleMetres: settings.analysisScaleMetres };
  const input = join(root, `${randomUUID()}.json`);
  let calculated;
  try {
    await writeFile(input, JSON.stringify(inputData));
    calculated = await (options.run || runTerrain)(python, raster, input);
  } finally { await unlink(input).catch(() => {}); }
  if (calculated.algorithmVersion !== terrainVersion || !['Polygon','MultiPolygon'].includes(calculated.geometry?.type)) throw Error('Terrain processor returned an invalid extent.');
  const shape = feature(calculated.geometry), bounds = bbox(shape);
  let count = 0;
  coordEach(shape, coordinate => { if (++count > 100000 || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) throw Error('Terrain output has unsupported coordinates.'); });
  const polygons = (shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates).map(polygon);
  if (!polygons.length || polygons.length > 128 || polygons.some(p => !booleanValid(p))) throw Error('Terrain processor returned an invalid extent.');
  // GEOS-valid raster polygons can touch at a corner; Turf's MultiPolygon validity check rejects some such contacts.
  for (let i=0;i<polygons.length;i++) for (let j=i+1;j<polygons.length;j++) {
    const overlap = intersect(featureCollection([polygons[i],polygons[j]]));
    if (overlap && area(overlap) > 0.01) throw Error('Terrain output contains overlapping polygon components.');
  }
  if (!bounds.every(Number.isFinite) || bounds.some((v,i) => i < 2 ? v < request.bounds[i] : v > request.bounds[i])) throw Error('Terrain output lies outside the approved elevation extract.');
  const areaKm2 = area(shape)/1e6;
  if (!Number.isFinite(areaKm2) || areaKm2 < floor.areaKm2 || areaKm2 > floor.areaKm2 * 10) throw Error('Terrain output failed the area expansion check.');
  const omittedFloor = difference(featureCollection([feature(floor.geometry), shape]));
  if (omittedFloor && area(omittedFloor) > floor.areaKm2 * 1e6 * 0.0001) throw Error('Terrain output does not retain the reviewed valley floor.');
  const agreement = calculated.diagnostics?.sensitivity?.intersectionOverUnion;
  if (!Number.isFinite(agreement) || agreement < 0 || agreement > 1) throw Error('Terrain processor omitted its scale-sensitivity assessment.');
  const metadata = { adapter: 'ga-dem-wcs/1', requestUrl: request.url, requestedBbox: request.bounds, coverage: '1',
    acquisition: 'SRTM February 2000; processed service edition 2024', inputResolutionArcSeconds: 3, sourceNativeResolutionArcSeconds: 1, checksum, filename, bytes: bytes.length };
  const importId = options.saveImport?.(checksum, { type: 'RasterSnapshot', filename, checksum }, metadata) || null;
  return { ...floor, geometry: calculated.geometry, bbox: bounds, displayBbox: bounds, areaKm2,
    valleyFloor: { geometry: floor.geometry, bbox: floor.bbox, areaKm2: floor.areaKm2, extentEstimate: floor.extentEstimate },
    extentEstimate: { ...floor.extentEstimate, kind: 'terrain_valley', label: 'Estimated valley extent',
      scopeNote: 'Terrain-derived extension of the reviewed valley floor onto adjoining slopes. Neighbouring terrain lows constrain the outline. This is an experimental physical-valley interpretation, not an official named boundary.',
      sourceScale: '90 m analysis grid; approximate terrain boundary' },
    terrain: { ...calculated.diagnostics, raster: metadata, sourceId: source.id, floorChecksum: digest(JSON.stringify(floor.geometry)) },
    status: 'partially_resolved', confidence: 'estimated', method: 'floor_anchored_terrain_segmentation', algorithmVersion: terrainVersion,
    warnings: ['Estimated floor-and-slope extent, not a surveyed or authoritative named-valley boundary.',
      'The reviewed floor anchors the geographic scope. Connected tributary flats can remain included; named upstream and downstream limits need review.',
      `Terrain-scale agreement is ${(agreement*100).toFixed(0)}% across the tested settings. This measures sensitivity, not a probability of correctness.`,
      'Derived from older SRTM elevations on a 90 m grid. Not suitable for property, flood-risk or planning decisions.'],
    evidence: [...floor.evidence, { sourceId: source.id, sourceName: source.name, sourceUrl: source.url, licence: source.licence, attribution: source.attribution,
      sourceVersion: source.version || 'DEM SRTM 1Second 2024 service', importId, checksum, objectId: 'WCS coverage 1, bounded raster extract', role: 'terrain_elevation' }] };
}
