import './valley-evidence.css';
export type ValleyBoundary={estimatedEdges:GeoJSON.FeatureCollection<GeoJSON.LineString>;studyCuts:GeoJSON.FeatureCollection<GeoJSON.LineString>;
  studyCutLengthShare:number;studyCutKm:number;estimatedEdgeKm:number;meaning:string};
export type FloodMapping={geometry?:GeoJSON.Geometry;areaKm2:number;sourceName:string;sourceUrl:string;licence:string;licenceUrl:string;datasetTitle:string;attribution:string;
  scenario:string;archiveDate:string;archiveChecksum:string;selection:string;association:string;limitations:string[];
  excluded?:Record<string,number>;
  records:{recordId:string;properties:{StudyName:string;MappingMet:string;Reliabilit:string;StudyScena:string;ModifiedDa:number;AEP:string}}[]};
export function valleyBoundaryOf(value:unknown):ValleyBoundary|undefined{return (value as {boundaryEvidence?:ValleyBoundary})?.boundaryEvidence;}
export function floodMappingOf(value:unknown):FloodMapping|undefined{return (value as {floodSupport?:FloodMapping})?.floodSupport;}
export function FloodMappingNotes({data,boundary}:{data:FloodMapping;boundary?:Omit<ValleyBoundary,'estimatedEdges'|'studyCuts'>}){
  return <section className="detail-section flood-mapping-notes" aria-label="Flood support">
    <h3>Flood support for the floor candidate</h3>
    <p className="small">The floor candidate retains selected published flood polygons and adds a limited fringe of connected low terrain. It is not the published flood extent or a guaranteed minimum valley.</p>
    <dl><dt>Flood scenario</dt><dd>{data.scenario}</dd><dt>Archive published</dt><dd>{data.archiveDate.slice(0,10)}</dd>
      <dt>Selected flood area</dt><dd>{data.areaKm2.toFixed(1)} km²</dd></dl>
    {data.records.map(record=><div className="flood-study" key={record.recordId}><strong>{record.properties.StudyName}</strong>
      <dl><dt>Source method / reliability</dt><dd>{record.properties.MappingMet} / {record.properties.Reliabilit}</dd><dt>Source scenario</dt><dd>{record.properties.StudyScena}</dd>
        <dt>Record modified</dt><dd>{String(record.properties.ModifiedDa).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3')}</dd></dl></div>)}
    <p className="small warning">This is archived flood evidence, not current flooding or property-safety advice. Areas without selected mapping remain unknown.</p>
    <p className="small">Source-model limits are not supplied separately. Some candidate floor edges may reflect those limits, not a natural landform edge.</p>
    {boundary&&<><h3>Where the study stops</h3><p className="small">{(boundary.studyCutLengthShare*100).toFixed(0)}% of the central outline length follows the study limit. Grey dashed lines are artificial cutoffs; magenta dotted lines are estimated terrain edges.</p></>}
    <details><summary>Selection and retained archive</summary><p className="small">{data.selection}</p><p className="small">{data.association}</p>
      {data.excluded&&<dl>{Object.entries(data.excluded).flatMap(([reason,count])=>[<dt key={reason}>{reason==='other_drainage'?'Other drainage excluded':'Other methods, reliability or scenario excluded'}</dt>,<dd key={reason+'-count'}>{count}</dd>])}</dl>}
      <pre>{data.archiveChecksum}</pre><p className="small">{data.datasetTitle}. {data.attribution}</p><a className="source-link" href={data.licenceUrl} target="_blank" rel="noreferrer">{data.licence}</a></details>
    <a className="source-link" href={data.sourceUrl} target="_blank" rel="noreferrer">Published flood dataset</a>
  </section>;
}
