import unittest
import tempfile
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from valley import segment, derive


class TerrainTests(unittest.TestCase):
    def fixture(self):
        y, x = np.mgrid[-100:101, -100:101]
        elevation = 150 * (1 - np.cos(x * np.pi / 50)) + 0.04 * y**2
        floor = (abs(x) < 4) & (abs(y) < 18)
        return elevation, floor

    def test_slopes_expand_but_neighbouring_valley_is_excluded(self):
        height, floor = self.fixture()
        result, _ = segment(height, floor)
        self.assertTrue(result[floor].all())
        self.assertGreater(result.sum(), floor.sum() * 2)
        self.assertTrue(result[100, 115])
        self.assertFalse(result[100, 175])
        self.assertFalse(result[100, 195])

    def test_reproducible(self):
        height, floor = self.fixture()
        self.assertTrue(np.array_equal(segment(height, floor)[0], segment(height, floor)[0]))

    def test_missing_height_and_empty_floor_are_rejected(self):
        height, floor = self.fixture()
        with self.assertRaises(ValueError):
            segment(height, np.zeros_like(floor))
        height[100, 100] = np.nan
        with self.assertRaises(ValueError):
            segment(height, floor)

    def test_bad_scales_and_dimensions_are_rejected(self):
        height, floor = self.fixture()
        for scale in [0, 400, 3000, float('nan')]:
            with self.assertRaises(ValueError):
                segment(height, floor, scale_metres=scale)
        with self.assertRaises(ValueError):
            segment(height[:5], floor)

    def test_edge_contact_cannot_be_published(self):
        height, floor = self.fixture()
        floor[0, 100] = True
        with self.assertRaisesRegex(ValueError, 'extract edge'):
            segment(height, floor)

    def test_raster_nodata_wrong_crs_and_wrong_bounds_are_rejected(self):
        bounds = [145, -38, 145.2, -37.8]
        floor = {'type': 'Polygon', 'coordinates': [[[145.05,-37.95],[145.15,-37.95],[145.15,-37.85],[145.05,-37.85],[145.05,-37.95]]]}
        with tempfile.TemporaryDirectory(prefix='geoxpl-terrain-test-') as directory:
            for case in ['nodata', 'crs', 'bounds', 'heights']:
                with self.subTest(case=case):
                    path = Path(directory) / f'{case}.tif'
                    heights = np.full((30,30), 100, dtype='float32')
                    if case == 'nodata':
                        heights[15,15] = -9999
                    if case == 'heights':
                        heights[15,15] = 10000
                    with rasterio.open(path, 'w', driver='GTiff', count=1, width=30, height=30,
                                       dtype='float32', crs='EPSG:3857' if case == 'crs' else 'EPSG:4326',
                                       transform=from_bounds(*bounds,30,30), nodata=-9999) as dst:
                        dst.write(heights,1)
                    request = {'floorGeometry':floor,'requestedBbox':[144,-38,145.2,-37.8] if case == 'bounds' else bounds}
                    with self.assertRaises(ValueError):
                        derive(path, request)


if __name__ == '__main__':
    unittest.main()
