import unittest
import numpy as np
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from headwaters import sample


class HeadwaterTerrainTests(unittest.TestCase):
    def test_downhill_profile_and_missing_coverage(self):
        data = np.arange(21, 0, -1, dtype='float32').reshape(1, 21)
        coordinates = [[144 + (i + 0.5) / 1000, -37.0005] for i in range(21)]
        with MemoryFile() as memory:
            with memory.open(driver='GTiff', width=21, height=1, count=1,
                             dtype='float32', crs='EPSG:4326', nodata=-9999,
                             transform=from_origin(144, -37, .001, .001)) as raster:
                raster.write(data, 1)
                result = sample(raster, [dict(hydroId=1, coordinates=coordinates)])[0]
                self.assertEqual(result['dropMetres'], 20)
                self.assertEqual(result['uphillSteps'], 0)
                data[0, 10] = -9999
                raster.write(data, 1)
                with self.assertRaises(ValueError):
                    sample(raster, [dict(hydroId=1, coordinates=coordinates)])
                with self.assertRaises(ValueError):
                    sample(raster, [dict(hydroId=1, coordinates=[[0, 0]] * 21)])


if __name__ == '__main__':
    unittest.main()
