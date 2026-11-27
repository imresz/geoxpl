"""Experimental flood-supported floor; published flood extents are not valley boundaries."""
import io
import json
import sys
import zipfile
import hashlib
from pathlib import Path
from importlib.metadata import version

import numpy as np
import shapefile
import rasterio
from rasterio.crs import CRS
from rasterio.features import rasterize
from rasterio.warp import transform_geom, calculate_default_transform, reproject, Resampling
from scipy import ndimage as ndi
from shapely.geometry import shape, mapping, box, Polygon, MultiPolygon, LineString, MultiLineString
from shapely.ops import unary_union
from reasoning import mosaic, terrain_masks, keep_anchored, progress, CELL, MAX_CELLS

ALGORITHM='flood-supported-valley/1.0.0'
ALLOWED_FIELDS=('StudyID','StudyName','StudyDescr','MappingMet','Reliabilit','ModifiedDa','StudyScena','AEP','Scale')


def flood_records(path, checksum, study, river):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=checksum:
        raise ValueError('Flood archive checksum changed.')
    selected, polygons, rejected=[], [], {}
    with zipfile.ZipFile(path) as archive:
        entries=archive.infolist()
        if len(entries)>32 or sum(e.file_size for e in entries)>180_000_000 or any(e.file_size>100_000_000 or e.flag_bits & 1 for e in entries):
            raise ValueError('Oversized or encrypted flood archive.')
        files={}
        for ext in ('shp','shx','dbf','prj'):
            names=[e.filename for e in entries if e.filename.lower().endswith('.'+ext)]
            if len(names)!=1:
                raise ValueError('Flood archive needs one complete shapefile.')
            files[ext]=names[0]
        if len({p.rsplit('.',1)[0] for p in files.values()})!=1:
            raise ValueError('Flood archive components do not match.')
        crs=CRS.from_wkt(archive.read(files['prj']).decode('utf8'))
        if crs.to_epsg()!=4283:
            raise ValueError('Unexpected flood archive coordinate reference system.')
        reader=shapefile.Reader(**{k:io.BytesIO(archive.read(files[k])) for k in ('shp','shx','dbf')})
        if reader.shapeType!=5 or len(reader)>10000 or not set(ALLOWED_FIELDS).issubset({f[0] for f in reader.fields[1:]}):
            raise ValueError('Unsupported flood polygon archive schema.')
        native_bounds=shape(transform_geom('EPSG:3577',crs,mapping(study))).bounds
        for record in reader.iterShapeRecords(bbox=native_bounds):
            attrs=record.record.as_dict()
            if attrs['AEP'].strip()!='1%' or attrs['MappingMet'].strip().lower()!='modelled' or attrs['Reliabilit'].strip().lower()!='high':
                rejected['not_high_modelled_1pct']=rejected.get('not_high_modelled_1pct',0)+1
                continue
            geom=shape(transform_geom(crs,'EPSG:3577',record.shape.__geo_interface__))
            if not geom.intersects(river):
                rejected['other_drainage']=rejected.get('other_drainage',0)+1
                continue
            if not geom.is_valid:
                raise ValueError('A selected flood polygon is invalid; no silent geometry repair is permitted.')
            clipped=geom.intersection(study)
            parts=list(clipped.geoms) if clipped.geom_type=='MultiPolygon' else [clipped]
            retained=[p for p in parts if p.geom_type=='Polygon' and p.intersects(river)]
            if not retained:
                continue
            polygons.extend(retained)
            selected.append({'archiveRow':record.record.oid,'recordId':f'{files["shp"]}:row:{record.record.oid}',
                             'properties':{key:attrs[key] for key in ALLOWED_FIELDS},'retainedParts':len(retained)})
    if not polygons:
        raise ValueError('No high-reliability modelled 1% AEP flood polygon is associated with this mapped river reach.')
    return unary_union(polygons), {'records':selected,'excluded':rejected,'sourceCrs':'EPSG:4283',
        'association':'Retain only polygon components that intersect the saved river inside the study area. No proximity buffer or invented flood connection.',
        'selection':'AEP 1%; MappingMet Modelled; source Reliabilit High. These are publisher attributes, not independent validation.'}


def lines(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type=='LineString':
        return [geometry]
    return [line for part in getattr(geometry,'geoms',[]) for line in lines(part)]


def geographic(polygon):
    result=transform_geom('EPSG:3577','EPSG:4326',mapping(polygon))
    if not shape(result).is_valid:
        raise ValueError('Invalid geometry after geographic reprojection.')
    return result


def outlined(polygon,study):
    if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in ('Polygon','MultiPolygon'):
        raise ValueError('Invalid valley interpretation polygon.')
    perimeter=polygon.boundary
    cut_zone=study.boundary.buffer(CELL*1.5)
    cuts=lines(perimeter.intersection(cut_zone))
    estimated=lines(perimeter.difference(cut_zone))
    collection=lambda parts:{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':geographic(line)} for line in parts]}
    cut_length=sum(p.length for p in cuts)
    return {'geometry':geographic(polygon),'boundaryEvidence':{'estimatedEdges':collection(estimated),'studyCuts':collection(cuts),
      'estimatedEdgeKm':sum(p.length for p in estimated)/1000,'studyCutKm':cut_length/1000,
      'studyCutLengthShare':cut_length/perimeter.length if perimeter.length else 0,'cutToleranceMetres':CELL*1.5,
      'meaning':'Study-cut lines are processing limits, not inferred natural edges. Other lines are estimated terrain edges, not verified boundaries.'}}


def polygonise(mask,transform,study):
    from rasterio.features import shapes
    parts=[shape(g) for g,v in shapes(mask.astype('uint8'),mask=mask,transform=transform) if v==1]
    return unary_union(parts).intersection(study)


def derive(manifest_path,request):
    manifest=json.loads(Path(manifest_path).read_text())
    progress('decoding expanded Vicmap study area')
    raw,src_transform=mosaic(manifest)
    bounds=rasterio.transform.array_bounds(*raw.shape,src_transform)
    transform,width,height=calculate_default_transform('EPSG:3857','EPSG:3577',raw.shape[1],raw.shape[0],*bounds,resolution=CELL)
    if width*height>MAX_CELLS:
        raise ValueError('Expanded study exceeds the five-million-cell limit.')
    grid=np.full((height,width),np.nan,dtype='float32')
    reproject(raw,grid,src_transform=src_transform,src_crs='EPSG:3857',dst_transform=transform,dst_crs='EPSG:3577',
              src_nodata=np.nan,dst_nodata=np.nan,resampling=Resampling.bilinear)
    del raw
    study_shape=shape(transform_geom('EPSG:4326','EPSG:3577',mapping(box(*request['scope']))))
    river_shape=shape(transform_geom('EPSG:4326','EPSG:3577',request['riverGeometry'])).intersection(study_shape)
    if river_shape.is_empty or river_shape.geom_type not in ('LineString','MultiLineString'):
        raise ValueError('No saved river geometry crosses the expanded study.')
    raster=lambda geom:rasterize([(mapping(geom),1)],out_shape=grid.shape,transform=transform,dtype='uint8').astype(bool)
    study=raster(study_shape)
    valid=np.isfinite(grid)
    if (ndi.binary_dilation(study,iterations=100)&~valid).any():
        raise ValueError('Expanded study has an incomplete elevation margin.')
    nearest=ndi.distance_transform_edt(~valid,return_distances=False,return_indices=True)
    filled=grid[tuple(nearest)]
    progress('selecting river-associated high-reliability flood records')
    flood,selection=flood_records(request['floodArchive'],request['floodChecksum'],study_shape,river_shape)
    flood_mask=raster(flood)
    central,core,envelope,diagnostics=terrain_masks(filled,raster(river_shape),transform,study,flood=flood_mask)
    floor_mask=diagnostics.pop('_floorMask')
    floor=polygonise(floor_mask,transform,study_shape).union(flood).intersection(study_shape)
    central_polygon=polygonise(central,transform,study_shape).union(floor)
    core_polygon=polygonise(core,transform,study_shape).union(floor)
    outer_polygon=polygonise(envelope,transform,study_shape).union(floor)
    progress('validating polygons and separating artificial study cuts')
    outlines={key:outlined(polygon,study_shape) for key,polygon in [('central',central_polygon),('stableCore',core_polygon),('outerEnvelope',outer_polygon),('valleyFloor',floor)]}
    diagnostics.update({'inputTileCount':len(manifest['entries']),'floodSelection':selection,'floorRule':
        'Retain selected flood mapping; add connected terrain within 300m where slope is at most 3 degrees, modelled height above drainage is at most 10m and 1500m relative elevation is at most 5m. This is an experimental floor interpretation, not a flood prediction.',
        'boundaryLengthShare':outlines['central']['boundaryEvidence']['studyCutLengthShare'],
        'versions':{lib:version(lib) for lib in ['rasterio','numpy','scipy','shapely','scikit-image','lerc','pyflwdir','numba','pyshp']}})
    return {'algorithmVersion':ALGORITHM,'validation':'Shapely-GEOS projected and WGS84 topology',**outlines,'publishedFlood':geographic(flood),'diagnostics':diagnostics}


if __name__=='__main__':
    try:
        print(json.dumps(derive(sys.argv[1],json.loads(Path(sys.argv[2]).read_text())),allow_nan=False))
    except Exception as error:
        print(json.dumps({'error':str(error)}),file=sys.stderr)
        sys.exit(1)
