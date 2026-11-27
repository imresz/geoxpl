import './terrain-reasoning.css';
export type TerrainMode='central'|'stableCore'|'outerEnvelope';
export type TerrainOutline={geometry:GeoJSON.Geometry;bbox:[number,number,number,number];areaKm2:number};
export type TerrainReasoningData={
  version:string;contrast:string;scopeNote:string;scope:number[];rules:string[];limitations:string[];
  stableCore:TerrainOutline;outerEnvelope:TerrainOutline;
  raster:{nominalSourceMetres:number;analysisCellMetres:number;cacheResolutionWebMercatorMetres:number;verticalRmseMetres:number;horizontalRmseMetres:number;sourceEpoch:string;verticalDatum:string;tileCount:number;checksum:string};
  diagnostics:{intersectionOverUnion:number;weakReliefEdgeShare:number;studyCutEdgeShare:number;terrainSeparation:string;medianSlopeDegrees:number;
    heightAboveDrainageMedianMetres:number|null;uncertainFringeKm2:number;scales:{radiusMetres:number;areaKm2:number}[];
    drainage:{mappedCellMatchShare:number;medianAcceptedSnapMetres:number;routingSupportKm2:number}};
};
export function terrainOf(feature:unknown):TerrainReasoningData|undefined{return (feature as {terrainReasoning?:TerrainReasoningData})?.terrainReasoning;}
const pct=(v:number)=>`${Math.round(v*100)}%`;
export function TerrainReasoning({data,mode='central',onMode}:{data:TerrainReasoningData;mode?:TerrainMode;onMode?:(mode:TerrainMode)=>void}){
  const d=data.diagnostics,r=data.raster;
  return <section className="detail-section terrain-reasoning" aria-label="Terrain reasoning">
    <h3>Terrain reasoning</h3><p className="small">{data.contrast}</p>
    {onMode&&<div className="geometry-modes" role="group" aria-label="Terrain interpretation">
      {([['central','Central'],['stableCore','Common area'],['outerEnvelope','Wider envelope']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={mode===value} onClick={()=>onMode(value)}>{label}</button>)}
    </div>}
    <p className="small">The common area occurs in all three interpretations. The wider envelope occurs in at least one. Neither is a verified boundary or a probability range.</p>
    <dl><dt>Source / analysis grid</dt><dd>{r.nominalSourceMetres} m / {r.analysisCellMetres} m</dd>
      <dt>Vertical / horizontal RMSE</dt><dd>{r.verticalRmseMetres} m / {r.horizontalRmseMetres} m</dd>
      <dt>Resampled cache spacing</dt><dd>{r.cacheResolutionWebMercatorMetres.toFixed(1)} projected m</dd>
      <dt>Source dates / heights</dt><dd>{r.sourceEpoch} · {r.verticalDatum}</dd>
      <dt>Settings agreement</dt><dd>{pct(d.intersectionOverUnion)}</dd>
      <dt>Common area</dt><dd>{data.stableCore.areaKm2.toFixed(1)} km²</dd>
      <dt>Wider envelope</dt><dd>{data.outerEnvelope.areaKm2.toFixed(1)} km²</dd>
      <dt>Weak-relief edge</dt><dd>{pct(d.weakReliefEdgeShare)}</dd>
      <dt>Artificial study cuts</dt><dd>{pct(d.studyCutEdgeShare)} of edge cells</dd>
      <dt>Mapped drainage supported</dt><dd>{pct(d.drainage.mappedCellMatchShare)}</dd>
      <dt>Median drainage adjustment</dt><dd>{d.drainage.medianAcceptedSnapMetres.toFixed(0)} m</dd>
    </dl>
    {d.terrainSeparation==='weak'&&<p className="warning">Low relief does not establish a sharp valley edge here, even when the tested settings agree.</p>}
    {d.studyCutEdgeShare>=.3&&<p className="warning">Much of the outline is cut by the study window, not a detected natural valley edge.</p>}
    <h3>Reasoning steps</h3><ol className="small">{data.rules.map(rule=><li key={rule}>{rule}</li>)}</ol>
    <h3>Settings comparison</h3><dl>{d.scales.flatMap(s=>[<dt key={`${s.radiusMetres}-label`}>{s.radiusMetres} m neighbourhood</dt>,<dd key={s.radiusMetres}>{s.areaKm2.toFixed(1)} km²</dd>])}</dl>
    <p className="small muted">Grid-cell estimates; displayed polygon areas can differ slightly.</p>
    <details><summary>Retained elevation snapshot</summary><p className="small">{r.tileCount} numeric elevation tiles. Resampling does not improve the source accuracy.</p><pre>{r.checksum}</pre><p className="small">Processor {data.version}</p></details>
  </section>;
}
