"""Experimental floor-anchored terrain segmentation, not a named-boundary survey."""
import json
import math
import sys
from importlib.metadata import version

import numpy as np
import rasterio
from rasterio.features import rasterize, shapes
from rasterio.warp import calculate_default_transform, reproject, transform_geom, Resampling
from scipy import ndimage as ndi
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from skimage.morphology import h_minima
from skimage.segmentation import watershed

ALGORITHM = 'terrain-valley/1.0.0'
CELL_METRES = 90
MAX_CELLS = 4_000_000


def segment(elevation, floor, cell_metres=90, scale_metres=1000):
    print(f'terrain: segment {scale_metres}m', file=sys.stderr, flush=True)
    if elevation.ndim != 2 or elevation.shape != floor.shape or elevation.size > MAX_CELLS:
        raise ValueError('Terrain grid dimensions exceed the supported limits.')
    if not np.isfinite(elevation).all() or not floor.any():
        raise ValueError('Complete finite elevation coverage and a nonempty reviewed floor are required.')
    if not 500 <= scale_metres <= 2500:
        raise ValueError('Terrain analysis scale must be between 500 and 2500 metres.')
    # Regional detrending separates terrain position from absolute upstream elevation.
    smooth = ndi.gaussian_filter(elevation.astype(np.float64), 1.0, mode='nearest')
    tpi = smooth - ndi.gaussian_filter(smooth, scale_metres / cell_metres, mode='nearest')
    print('terrain: minima', file=sys.stderr, flush=True)
    surface = np.round(tpi * 2).astype(np.int32)
    minima = h_minima(surface, 10).astype(bool)
    competing = minima & ~ndi.binary_dilation(floor, iterations=2)
    competing[[0, -1], :] = True
    competing[:, [0, -1]] = True
    markers = np.zeros(elevation.shape, dtype=np.int32)
    markers[competing] = 2
    markers[floor] = 1
    print('terrain: watershed', file=sys.stderr, flush=True)
    result = watershed(surface, markers=markers, connectivity=2, watershed_line=False) == 1
    result |= floor
    print(f'terrain: segmented {int(result.sum())} cells', file=sys.stderr, flush=True)
    if result[:3, :].any() or result[-3:, :].any() or result[:, :3].any() or result[:, -3:].any():
        raise ValueError('Terrain estimate reaches the extract edge; a larger elevation extract is needed.')
    return result, {'competingMarkerCells': int(competing.sum()), 'analysisScaleMetres': scale_metres,
                    'minimaProminenceMetres': 5, 'smoothingSigmaCells': 1, 'markerExclusionCells': 2, 'heightQuantisationMetres': 0.5}


def derive(path, request):
    print('terrain: reading raster', file=sys.stderr, flush=True)
    floor_geo = shape(request['floorGeometry'])
    if not floor_geo.is_valid or floor_geo.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError('The reviewed valley floor must be a valid polygon.')
    scale = request.get('analysisScaleMetres', 1000)
    if not isinstance(scale, (float, int)) or not math.isfinite(scale) or not 750 <= scale <= 2000:
        raise ValueError('Unsupported terrain analysis scale.')
    with rasterio.open(path) as src:
        if src.driver != 'GTiff' or src.count != 1 or src.crs != rasterio.crs.CRS.from_epsg(4326):
            raise ValueError('Expected a single-band WGS84 elevation GeoTIFF, not a rendered map.')
        if src.width * src.height > MAX_CELLS or src.width < 16 or src.height < 16 or src.dtypes[0] not in ('float32', 'float64', 'int16', 'int32'):
            raise ValueError('Elevation raster size or height encoding is unsupported.')
        west, south, east, north = src.bounds
        fw, fs, fe, fn = floor_geo.bounds
        if not (west < fw < fe < east and south < fs < fn < north):
            raise ValueError('Elevation extract does not contain the complete reviewed floor.')
        expected = request['requestedBbox']
        if max(abs(a-b) for a, b in zip(src.bounds, expected)) > 0.003:
            raise ValueError('Elevation georeferencing does not match the requested geographic extract.')
        raw = src.read(1, masked=True)
        if np.ma.getmaskarray(raw).any() or not np.isfinite(raw).all() or raw.min() < -500 or raw.max() > 9000:
            raise ValueError('Missing or implausible elevations; the estimate was not generated.')
        transform, width, height = calculate_default_transform(src.crs, 'EPSG:3577', src.width, src.height, *src.bounds, resolution=CELL_METRES)
        if width * height > MAX_CELLS:
            raise ValueError('Projected elevation grid exceeds the cell limit.')
        grid = np.full((height, width), np.nan, dtype=np.float64)
        reproject(raw.filled(np.nan), grid, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=transform, dst_crs='EPSG:3577', src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
        metadata = {'crs': 'EPSG:3577', 'cellMetres': CELL_METRES, 'width': width, 'height': height,
                    'inputBounds': list(src.bounds), 'inputShape': [src.height, src.width], 'inputDtype': src.dtypes[0],
                    'minElevationMetres': float(raw.min()), 'maxElevationMetres': float(raw.max())}
    valid = np.isfinite(grid)
    print('terrain: projected', file=sys.stderr, flush=True)
    if not valid.any():
        raise ValueError('No valid projected elevations.')
    # A metric bounding grid contains corner voids. Their nearest valid heights are used only outside the valid mask.
    nearest = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = grid[tuple(nearest)]
    floor_projected = shape(transform_geom('EPSG:4326', 'EPSG:3577', mapping(floor_geo)))
    floor = rasterize([(mapping(floor_projected), 1)], out_shape=grid.shape, transform=transform, dtype='uint8').astype(bool)
    if (floor & ~valid).any() or not floor.any():
        raise ValueError('Reviewed floor falls outside valid elevation coverage.')
    masks = []
    base_parameters = None
    scales = [scale * 0.75, scale, scale * 1.25]
    for radius in scales:
        mask, parameters = segment(filled, floor, CELL_METRES, radius)
        if (ndi.binary_dilation(mask, iterations=3) & ~valid).any():
            raise ValueError('Terrain estimate reaches the edge of valid elevation coverage.')
        masks.append(mask)
        if radius == scale:
            base_parameters = parameters
    result = masks[1]
    print('terrain: vectorizing', file=sys.stderr, flush=True)
    if result.sum() < floor.sum() * 1.03 or result.sum() > floor.sum() * 10:
        raise ValueError('Terrain expansion is negligible or excessive; review the scale and floor association.')
    pieces = [shape(geom) for geom, value in shapes(result.astype('uint8'), mask=result, transform=transform) if value == 1]
    polygon = unary_union(pieces).simplify(CELL_METRES / 2, preserve_topology=True).union(floor_projected)
    print('terrain: geometry complete', file=sys.stderr, flush=True)
    if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError('Terrain estimate did not produce a valid polygon.')
    output = transform_geom('EPSG:3577', 'EPSG:4326', mapping(polygon))
    if not shape(output).is_valid:
        raise ValueError('Terrain boundary became invalid when converted to map coordinates.')
    intersection = masks[0] & masks[1] & masks[2]
    combined = masks[0] | masks[1] | masks[2]
    metadata.update({'parameters': base_parameters,
                     'sensitivity': {'scalesMetres': scales, 'areaKm2': [float(m.sum()*CELL_METRES**2/1e6) for m in masks],
                                     'intersectionOverUnion': float(intersection.sum()/combined.sum())},
                     'floorAreaKm2': floor_projected.area / 1e6, 'terrainAreaKm2': polygon.area / 1e6,
                     'versions': {lib: version(lib) for lib in ['rasterio', 'numpy', 'scipy', 'shapely', 'scikit-image']}})
    return {'geometry': output, 'algorithmVersion': ALGORITHM, 'diagnostics': metadata}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected local GeoTIFF and request JSON paths.')
        with open(sys.argv[2], encoding='utf-8') as handle:
            request = json.load(handle)
        print(json.dumps(derive(sys.argv[1], request), allow_nan=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
