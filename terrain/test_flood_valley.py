import unittest
import tempfile
import io
import zipfile
import hashlib
from pathlib import Path
import shapefile
import numpy as np
from rasterio.crs import CRS
from rasterio.warp import transform_geom
from rasterio.transform import from_origin
from shapely.geometry import box, mapping, shape, LineString
from flood_valley import flood_records,outlined,ALLOWED_FIELDS
from reasoning import terrain_masks


class FloodValleyTests(unittest.TestCase):
    def archive(self,path):
        shp,shx,dbf=io.BytesIO(),io.BytesIO(),io.BytesIO()
        writer=shapefile.Writer(shp=shp,shx=shx,dbf=dbf,shapeType=5)
        for name in ALLOWED_FIELDS:
            writer.field(name,'N' if name in ('ModifiedDa','Scale') else 'C',size=12 if name in ('ModifiedDa','Scale') else 100)
        for number,(bounds,reliability,aep) in enumerate([
            ([143.98,-36.63,144.02,-36.58],'High','1%'),
            ([144.12,-36.63,144.14,-36.58],'High','1%'),
            ([143.96,-36.64,144.04,-36.57],'Low','1%'),
            ([143.96,-36.64,144.04,-36.57],'High','')]):
            ring=list(box(*bounds).exterior.coords)[::-1]
            writer.poly([ring])
            attrs={name:'' for name in ALLOWED_FIELDS}
            attrs.update(StudyID=f'TEST{number}',StudyName='Synthetic flood study',MappingMet='Modelled',Reliabilit=reliability,AEP=aep,ModifiedDa=20150101,Scale=10000)
            writer.record(**attrs)
        writer.close()
        with zipfile.ZipFile(path,'w') as archive:
            for ext,data in [('shp',shp.getvalue()),('shx',shx.getvalue()),('dbf',dbf.getvalue()),('prj',CRS.from_epsg(4283).to_wkt())]:
                archive.writestr('synthetic.'+ext,data)
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def test_selects_only_modelled_high_reliability_explicit_scenario_and_river_association(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'flood.zip';checksum=self.archive(path)
            study=shape(transform_geom('EPSG:4326','EPSG:3577',mapping(box(143.9,-36.7,144.2,-36.5))))
            river=shape(transform_geom('EPSG:4326','EPSG:3577',mapping(LineString([(144,-36.68),(144,-36.52)]))))
            flood,diagnostics=flood_records(path,checksum,study,river)
            self.assertEqual(len(diagnostics['records']),1)
            self.assertEqual(diagnostics['records'][0]['properties']['StudyID'],'TEST0')
            self.assertEqual(diagnostics['excluded']['not_high_modelled_1pct'],2)
            self.assertEqual(diagnostics['excluded']['other_drainage'],1)
            self.assertNotIn('CMAFileLoc',diagnostics['records'][0]['properties'])
            with self.assertRaisesRegex(ValueError,'checksum'):
                flood_records(path,'0'*64,study,river)

    def test_cut_edges_are_separate_from_estimated_edges_and_cover_the_outline(self):
        study=box(0,0,6000,6000);polygon=box(0,1000,4000,5000)
        evidence=outlined(polygon,study)['boundaryEvidence']
        self.assertGreater(evidence['studyCutKm'],4)
        self.assertGreater(evidence['estimatedEdgeKm'],10)
        self.assertAlmostEqual(evidence['studyCutKm']+evidence['estimatedEdgeKm'],polygon.length/1000,places=6)
        inside=outlined(box(1000,1000,4000,5000),study)['boundaryEvidence']
        self.assertEqual(inside['studyCutKm'],0)

    def test_flood_support_is_retained_but_floor_growth_is_bounded(self):
        y,x=np.mgrid[0:181,0:241]
        height=(100*(1-np.cos((x-70)*np.pi/70))+(181-y)*.15).astype('float32')
        river=(x==70)&(y>20)&(y<160)
        study=(x>20)&(x<220)&(y>20)&(y<160)
        flood=(abs(x-70)<3)&(y>50)&(y<130)
        central,core,outer,info=terrain_masks(height,river,from_origin(0,6000,30,30),study,flood=flood)
        floor=info['_floorMask']
        self.assertTrue(floor[flood].all())
        self.assertTrue(central[flood].all())
        self.assertFalse(floor[90,100])
        self.assertTrue((~core|central).all())
        self.assertTrue((~central|outer).all())
        self.assertIn('not a published flood extent',' '.join(info['limitations']))


if __name__=='__main__':
    unittest.main()
