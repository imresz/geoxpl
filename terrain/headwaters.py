"""Sample local elevation diagnostics without choosing a named headwater."""
import json
import sys
import numpy as np
import rasterio
from rasterio.warp import transform


def sample(dataset, profiles):
    result = []
    for profile in profiles:
        coordinates = profile['coordinates']
        if len(coordinates) != 21:
            raise ValueError('Twenty-one profile samples are required.')
        x, y = transform('EPSG:4326', dataset.crs,
                         [c[0] for c in coordinates], [c[1] for c in coordinates])
        if any(not (dataset.bounds.left <= a < dataset.bounds.right and
                    dataset.bounds.bottom < b <= dataset.bounds.top) for a, b in zip(x, y)):
            raise ValueError('Elevation profile falls outside raster coverage.')
        values = list(dataset.sample(zip(x, y), indexes=1, masked=True))
        if any(np.ma.is_masked(v[0]) or not np.isfinite(v[0]) for v in values):
            raise ValueError('Elevation profile contains missing terrain coverage.')
        heights = [float(v[0]) for v in values]
        result.append(dict(hydroId=profile['hydroId'], status='sampled',
                           upstreamMetres=heights[0], downstreamMetres=heights[-1],
                           dropMetres=heights[0] - heights[-1],
                           uphillSteps=sum(b - a > 5 for a, b in zip(heights, heights[1:])),
                           elevationsMetres=heights))
    return result


if __name__ == '__main__':
    with open(sys.argv[2], encoding='utf-8') as handle:
        data = json.load(handle)
    with rasterio.open(sys.argv[1]) as dataset:
        if dataset.count != 1 or dataset.width * dataset.height > 1200000 or not dataset.crs:
            raise ValueError('Unsupported elevation raster.')
        print(json.dumps(dict(profiles=sample(dataset, data['profiles']))))
