import unittest
import tempfile
import hashlib
from pathlib import Path
from unittest.mock import patch
import numpy as np
from rasterio.transform import from_origin
from shapely.geometry import box, shape
from reasoning import terrain_masks, vector, decode_tile, mosaic


class ReasoningTests(unittest.TestCase):
    def fixture(self, amplitude=100):
        y, x = np.mgrid[0:181, 0:241]
        height = (amplitude*(1-np.cos((x-70)*np.pi/70)) + (181-y)*0.15).astype('float32')
        river = (x == 70) & (y > 20) & (y < 160)
        study = (x > 20) & (x < 220) & (y > 20) & (y < 160)
        return height, river, study, from_origin(0, 6000, 30, 30)

    def test_sides_included_neighbouring_valley_excluded_and_nested(self):
        height, river, study, transform = self.fixture()
        central, core, outer, info = terrain_masks(height, river, transform, study)
        self.assertTrue(central[90, 85])
        self.assertFalse(central[90, 210])
        self.assertTrue((~core | central).all())
        self.assertTrue((~central | outer).all())
        self.assertGreater(central.sum(), river.sum()*2)
        self.assertEqual(len(info['scales']), 3)
        self.assertIn('not probability', ' '.join(info['limitations']))

    def test_flat_case_has_explicit_weak_relief_not_false_confidence(self):
        height, river, study, transform = self.fixture(1)
        _, _, _, info = terrain_masks(height, river, transform, study)
        self.assertEqual(info['terrainSeparation'], 'weak')
        self.assertIn('No sharp outer valley edge', ' '.join(info['limitations']))

    def test_missing_heights_and_drains_rejected(self):
        height, river, study, transform = self.fixture()
        with self.assertRaises(ValueError):
            terrain_masks(height, river & False, transform, study)
        height[30, 30] = np.nan
        with self.assertRaises(ValueError):
            terrain_masks(height, river, transform, study)
        with self.assertRaises((ValueError, TypeError)):
            decode_tile(b'not an elevation tile')

    def test_node_georeferencing_checksums_and_shared_seams(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tile.lerc'
            path.write_bytes(b'synthetic')
            plan = {'level':14,'size':256,'x0':0,'x1':1,'y0':0,'y1':0,'resolution':10,'origin':[0,0]}
            entries = [{'level':14,'x':x,'y':0,'path':str(path),'checksum':hashlib.sha256(b'synthetic').hexdigest()} for x in [0,1]]
            tiles = [np.tile(np.arange(257,dtype='float32'),(257,1)),np.tile(np.arange(256,513,dtype='float32'),(257,1))]
            with patch('reasoning.decode_tile',side_effect=tiles):
                grid, transform = mosaic({'plan':plan,'entries':entries})
            self.assertEqual(grid.shape,(257,513))
            self.assertEqual(transform*(0.5,0.5),(0,0))
            with patch('reasoning.decode_tile',side_effect=[tiles[0],tiles[1]+1]):
                with self.assertRaisesRegex(ValueError,'seams'):
                    mosaic({'plan':plan,'entries':entries})
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'checksum'):
                mosaic({'plan':plan,'entries':entries})


if __name__ == '__main__':
    unittest.main()
