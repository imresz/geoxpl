"""Bounded terrain interpretation. The study window is not a named-feature boundary."""
import hashlib
import json
import math
import sys
from importlib.metadata import version
from pathlib import Path

import lerc
import numpy as np
import pyflwdir
import rasterio
from rasterio.features import rasterize, shapes
from rasterio.transform import from_origin
from rasterio.warp import calculate_default_transform, reproject, transform_geom, Resampling
from scipy import ndimage as ndi
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union
from skimage.morphology import h_minima
from skimage.segmentation import watershed

ALGORITHM = 'terrain-reasoning/1.0.0'
CELL = 30
MAX_CELLS = 5_000_000
SCALES = (750, 1500, 3000)


def progress(message):
    print('terrain reasoning: ' + message, file=sys.stderr, flush=True)


def decode_tile(data):
    info = lerc.getLercBlobInfo(data)
    if info[0] != 0 or info[3:7] != (1, 257, 257, 1) or info[-1] > 0.101:
        raise ValueError('Unsupported numeric elevation tile dimensions, bands or compression error.')
    result, values, valid = lerc.decode(data)
    if result != 0 or values.shape != (257, 257) or (valid is not None and not valid.all()) or not np.isfinite(values).all():
        raise ValueError('Elevation tile has missing or invalid height samples.')
    if values.min() < -100 or values.max() > 2300:
        raise ValueError('Elevation tile contains implausible Victorian heights.')
    return values.astype(np.float32)


def mosaic(manifest):
    p = manifest['plan']
    nx, ny = p['x1'] - p['x0'] + 1, p['y1'] - p['y0'] + 1
    if p['level'] not in (13,14) or p['size'] != 256 or nx < 1 or ny < 1 or nx * ny > 1200 or len(manifest['entries']) != nx * ny:
        raise ValueError('Incomplete or oversized elevation manifest.')
    grid = np.full((ny * 256 + 1, nx * 256 + 1), np.nan, dtype=np.float32)
    seen = set()
    for entry in manifest['entries']:
        x, y = entry['x'] - p['x0'], entry['y'] - p['y0']
        if not 0 <= x < nx or not 0 <= y < ny or (x, y) in seen or entry['level'] != p['level']:
            raise ValueError('Duplicate or out-of-range elevation tile.')
        data = Path(entry['path']).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['checksum']:
            raise ValueError('Elevation snapshot checksum changed.')
        values = decode_tile(data)
        target = grid[y*256:y*256+257, x*256:x*256+257]
        overlap = np.isfinite(target)
        if overlap.any() and np.max(np.abs(target[overlap] - values[overlap])) > 0.202:
            raise ValueError('Elevation cache tile seams are inconsistent.')
        target[:] = values
        seen.add((x, y))
    if not np.isfinite(grid).all():
        raise ValueError('Elevation mosaic is incomplete.')
    # Elevation cache tiles have 257 shared-edge node samples, not 256 image pixels.
    resolution = p['resolution']
    transform = from_origin(p['origin'][0] + p['x0']*256*resolution - resolution/2,
                            p['origin'][1] - p['y0']*256*resolution + resolution/2, resolution, resolution)
    return grid, transform


def keep_anchored(mask, anchors):
    labels, _ = ndi.label(mask, structure=np.ones((3, 3)))
    ids = np.unique(labels[anchors & mask])
    return np.isin(labels, ids[ids > 0])


def terrain_masks(elevation, river, transform, study, cell=CELL, flood=None):
    if elevation.ndim != 2 or elevation.shape != river.shape or elevation.shape != study.shape or elevation.size > MAX_CELLS:
        raise ValueError('Unsupported terrain grid dimensions.')
    if not np.isfinite(elevation).all() or not river.any() or not study.any():
        raise ValueError('Complete elevations, mapped drainage and a study area are required.')
    progress('deriving bounded D8 drainage')
    flow = pyflwdir.from_dem(elevation, transform=transform, latlon=False, max_depth=5)
    accumulation = flow.accuflux(np.ones(elevation.shape, dtype=np.float32)) * cell**2
    channels = accumulation >= 500_000
    seed_indices = np.flatnonzero(river & study)
    snapped, offsets = flow.snap(idxs=seed_indices, mask=channels, max_length=300, unit='m')
    accepted = (snapped >= 0) & (snapped < elevation.size) & (offsets <= 300)
    accepted[accepted] &= channels.ravel()[snapped[accepted]]
    if accepted.mean() < 0.35:
        raise ValueError('Mapped river and terrain drainage agree too weakly for a supported valley candidate.')
    anchors = np.zeros(elevation.size, dtype=bool)
    anchors[snapped[accepted]] = True
    anchors = anchors.reshape(elevation.shape) & study
    if not anchors.any():
        raise ValueError('No supported drainage anchors lie inside the study area.')
    routing = flow.basins(idxs=np.flatnonzero(anchors)) > 0
    hand = flow.hand(anchors, elevation)
    smooth = ndi.gaussian_filter(elevation, 1, mode='nearest')
    dy, dx = np.gradient(smooth, cell)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))
    floor = None
    segmentation_anchors = anchors
    if flood is not None:
        if flood.shape != study.shape or not flood.any() or (flood & ~study).any():
            raise ValueError('Flood support must lie in the declared study area.')
        near = ndi.distance_transform_edt(~flood) * cell <= 300
        relative = smooth - ndi.gaussian_filter(smooth, 1500/cell, mode='nearest')
        additions = near & study & routing & (slope <= 3) & (hand >= 0) & (hand <= 10) & (relative <= 5)
        floor = keep_anchored(flood | additions, flood)
        segmentation_anchors = anchors | floor
    masks, diagnostics = [], []
    for radius in SCALES:
        progress(f'classifying relative terrain at {radius} m')
        regional = ndi.gaussian_filter(smooth, radius/cell, mode='nearest')
        tpi = smooth - regional
        local_var = np.maximum(ndi.gaussian_filter(smooth**2, radius/cell, mode='nearest') - regional**2, 0)
        threshold = np.maximum(5, np.sqrt(local_var)*0.5)
        ridges = tpi > threshold
        lows = tpi < -threshold
        competing = h_minima(np.round(tpi*2).astype(np.int32), 10) & ~ndi.binary_dilation(segmentation_anchors, iterations=10)
        competing[[0, -1], :] = True
        competing[:, [0, -1]] = True
        markers = np.zeros(elevation.shape, dtype=np.int32)
        markers[competing] = 2
        markers[segmentation_anchors] = 1
        candidate = watershed(tpi, markers, connectivity=2) == 1
        candidate = keep_anchored((candidate & routing & study) | segmentation_anchors, segmentation_anchors)
        if not candidate.any():
            raise ValueError('The terrain rule did not retain a supported candidate.')
        masks.append(candidate)
        diagnostics.append({'radiusMetres': radius, 'areaKm2': float(candidate.sum()*cell**2/1e6),
                            'ridgeShare': float(ridges[candidate].mean()), 'relativeLowShare': float(lows[candidate].mean()),
                            'gentleSlopeShare': float((slope[candidate] < 5).mean())})
    core = masks[0] & masks[1] & masks[2]
    envelope = masks[0] | masks[1] | masks[2]
    central = masks[1]
    edge = central & ~ndi.binary_erosion(central)
    study_edge = study & ~ndi.binary_erosion(study, iterations=2)
    local_relief = ndi.maximum_filter(smooth, size=max(3, int(1000/cell))) - ndi.minimum_filter(smooth, size=max(3, int(1000/cell)))
    weak = float((local_relief[edge] <= 10).mean())
    hand_values = hand[central & (hand >= 0)]
    info = {'analysisCellMetres': cell, 'analysisCrs': 'EPSG:3577', 'scales': diagnostics,
            'intersectionOverUnion': float(core.sum()/envelope.sum()),
            'stableCoreKm2': float(core.sum()*cell**2/1e6), 'outerEnvelopeKm2': float(envelope.sum()*cell**2/1e6),
            'uncertainFringeKm2': float((envelope & ~core).sum()*cell**2/1e6),
            'weakReliefEdgeShare': weak, 'studyCutEdgeShare': float((edge & study_edge).sum()/max(1, edge.sum())),
            'medianSlopeDegrees': float(np.median(slope[central])),
            'heightAboveDrainageMedianMetres': float(np.median(hand_values)) if hand_values.size else None,
            'drainage': {'method': 'PyFlwDir D8; max depression fill depth 5m', 'minimumChannelAreaKm2': 0.5,
                         'maximumSnapMetres': 300, 'mappedCellMatchShare': float(accepted.mean()),
                         'medianAcceptedSnapMetres': float(np.median(offsets[accepted])),
                         'routingSupportKm2': float((routing & study).sum()*cell**2/1e6)},
            'terrainSeparation': 'weak' if weak >= 0.3 else 'more_distinct',
            'rules': [
                'Use only saved mapped river geometry in the analyst-selected study area; do not use dotted river estimates.',
                'Trace mapped river cells down modelled terrain flow paths by at most 300m to channels draining at least 0.5km2.',
                'Use supported drainage to exclude neighbouring basins, then use relative-elevation watershed segmentation to separate adjoining terrain lows.',
                'Compare 750m, 1500m and 3000m terrain neighbourhoods; retain the 1500m candidate as the displayed central interpretation.',
                'Classify ridges, relative lows and slopes for diagnostic evidence. A drainage catchment alone is not the valley boundary.',
                'Clip to the declared study area and identify its artificial cuts; never treat the study rectangle as a natural named-feature boundary.'
            ],
            'limitations': [
                'These are experimental physical-terrain interpretations, not gazetted, tourism, wine-region, flood-risk or property boundaries.',
                'Core and envelope describe agreement across tested settings, not probability, positional accuracy or a validated confidence interval.',
                'The nominal 10m source has mixed epochs and about 5m vertical RMSE; resampling does not improve its accuracy.',
                'D8 routing and snapping are model assumptions. Canals, crossings, dams, deep depressions and older mapped river offsets can affect support.',
                'Connected tributary terrain can be included. The named valley and its longitudinal limits still require interpretation.',
                'Study-area cuts are analyst choices, not detected ridgelines.'
            ]}
    if weak >= 0.3:
        info['limitations'].append('Low relief near much of the candidate edge is comparable to DEM vertical uncertainty. No sharp outer valley edge is established, even if parameter agreement is high.')
    if floor is not None:
        info['_floorMask'] = floor
        info['rules'].insert(2, 'Use river-connected, high-reliability modelled 1% AEP flood mapping as supporting floor evidence; retain its scenario and dates. Do not equate it with a minimum or complete valley boundary.')
        info['limitations'].extend([
            'Flood support comes from a retained published archive. Selected study and record dates are shown; newer mapping may exist. No present-day property clearance or emergency advice is provided.',
            'Only selected river-connected high-reliability modelled records were used. Unmapped and excluded areas are unknown, not safe or outside the valley.',
            'The floor candidate includes a bounded terrain-derived fringe beyond the selected flood polygons. It is not a published flood extent or a verified minimum valley.',
            'Expanding the study reduces some clipping but cannot establish a sharp natural edge on a low-relief plain.'
        ])
    return central, core, envelope, info


def vector(mask, transform, study_shape):
    pieces = [shape(g) for g, value in shapes(mask.astype('uint8'), mask=mask, transform=transform) if value == 1]
    if not pieces:
        return None
    # Keep common cell edges identical so core/central/envelope remain nested.
    polygon = unary_union(pieces).intersection(study_shape)
    polygon = polygon.buffer(0)
    if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError('Terrain vectorisation produced invalid geometry.')
    return transform_geom('EPSG:3577', 'EPSG:4326', mapping(polygon))


def derive(manifest_path, request):
    manifest = json.loads(Path(manifest_path).read_text())
    progress('decoding and validating numeric elevation tiles')
    raw, src_transform = mosaic(manifest)
    bounds = rasterio.transform.array_bounds(*raw.shape, src_transform)
    transform, width, height = calculate_default_transform('EPSG:3857', 'EPSG:3577', raw.shape[1], raw.shape[0], *bounds, resolution=CELL)
    if width*height > MAX_CELLS:
        raise ValueError('Analysis exceeds the five-million-cell pilot limit.')
    grid = np.full((height, width), np.nan, dtype=np.float32)
    reproject(raw, grid, src_transform=src_transform, src_crs='EPSG:3857', dst_transform=transform, dst_crs='EPSG:3577',
              src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    del raw
    valid = np.isfinite(grid)
    study_shape = shape(transform_geom('EPSG:4326', 'EPSG:3577', mapping(box(*request['scope']))))
    study = rasterize([(mapping(study_shape), 1)], out_shape=grid.shape, transform=transform, dtype='uint8').astype(bool)
    river_shape = shape(transform_geom('EPSG:4326', 'EPSG:3577', request['riverGeometry'])).intersection(study_shape)
    if river_shape.is_empty or river_shape.geom_type not in ('LineString', 'MultiLineString'):
        raise ValueError('No mapped river line intersects the study area.')
    river = rasterize([(mapping(river_shape), 1)], out_shape=grid.shape, transform=transform, dtype='uint8', all_touched=True).astype(bool)
    if (ndi.binary_dilation(study, iterations=100) & ~valid).any():
        raise ValueError('The terrain study area does not have a complete valid elevation margin.')
    nearest = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = grid[tuple(nearest)]
    central, core, envelope, diagnostics = terrain_masks(filled, river, transform, study)
    result = {'algorithmVersion': ALGORITHM, 'geometry': vector(central, transform, study_shape),
              'stableCore': vector(core, transform, study_shape), 'outerEnvelope': vector(envelope, transform, study_shape),
              'diagnostics': {**diagnostics, 'inputTileCount': len(manifest['entries']), 'inputEncoding': 'LERC float heights; shared 257-node edges',
                              'versions': {lib: version(lib) for lib in ['rasterio', 'numpy', 'scipy', 'shapely', 'scikit-image', 'lerc', 'pyflwdir', 'numba']}}}
    return result


if __name__ == '__main__':
    try:
        request = json.loads(Path(sys.argv[2]).read_text())
        print(json.dumps(derive(sys.argv[1], request), allow_nan=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
