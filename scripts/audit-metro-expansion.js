import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const endpoint = 'https://opendata.maps.vic.gov.au/geoserver/wfs';
const plans = [
  { code: '4', names: ['DAVEY STREET','BAXTER STREET','CRANBOURNE ROAD','CRANBOURNE-FRANKSTON ROAD','SLADEN STREET'], west: 'NEPEAN HIGHWAY', east: 'SOUTH GIPPSLAND HIGHWAY' },
  { code: '14', names: ['SOUTH ROAD','DINGLEY BYPASS','KINGSTON ROAD','HEATHERTON ROAD','ROBINSON ROAD','KING ROAD'], west: 'BEACH ROAD', east: 'HARKAWAY ROAD' },
  { code: '17', names: ['BURKE ROAD N','BURKE ROAD','DANDENONG ROAD','GRANGE ROAD','JASPER ROAD'], west: 'LOWER HEIDELBERG ROAD', east: 'SOUTH ROAD' },
  { code: '19', names: ['GLENFERRIE ROAD','DANDENONG ROAD','HAWTHORN ROAD','NEPEAN HIGHWAY','CUMMINS ROAD','BLUFF ROAD'], west: 'COTHAM ROAD', east: 'BALCOMBE ROAD' },
  { code: '20', names: ['CITY ROAD','ALEXANDRA AVENUE','OLYMPIC BOULEVARD','SWAN STREET','WALLEN ROAD','RIVERSDALE ROAD'], west: 'MONTAGUE STREET', east: 'STATION STREET' },
  { code: '21', names: ['GRANGE ROAD','LOYOLA GROVE','MADDEN GROVE','SWAN STREET','WALLEN ROAD','POWER STREET','DENMARK STREET','PRINCESS STREET','CHANDLER HIGHWAY','GRANGE ROAD','DAREBIN ROAD','STATION STREET','ALBERT STREET','BOLDREWOOD PARADE','BROADWAY'], west: 'TOORAK ROAD', east: 'HIGH STREET' },
  { code: '22', names: ['GLEN EIRA ROAD','BOORAN ROAD','NEERIM ROAD','MURRUMBEENA ROAD','DANDENONG ROAD','FERNTREE GULLY ROAD','BURWOOD HIGHWAY'], west: 'BRIGHTON ROAD', east: 'MOUNT DANDENONG TOURIST ROAD' }
];
const names = [...new Set(plans.flatMap(p => [...p.names,p.west,p.east]))];
const retrievedAt = new Date().toISOString();
const baseline = 'https://www.vicroads.vic.gov.au/~/media/files/technical-documents-new/traffic-engineering-manual-v2/tem-vol-2-part-215--as174215-direction-signs-information-signs-and-route-numbering.pdf#page=158';
const records = [], ids = new Set(), requests = [];
let total;
do {
  const params = new URLSearchParams({
    service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:'open-data-platform:tr_road',
    outputFormat:'application/json',srsName:'EPSG:4326',count:'500',startIndex:String(records.length),
    sortBy:'pfi A',propertyName:'geom,pfi,from_ufi,to_ufi,ezi_road_name,route_no,left_locality,right_locality,feature_type_code',
    cql_filter:`BBOX(geom,144.86,-38.22,145.38,-37.69,'EPSG:4326') AND ezi_road_name IN (${names.map(n=>`'${n}'`).join(',')})`
  });
  const url = `${endpoint}?${params}`;
  requests.push(url);
  const page = JSON.parse(execFileSync('curl.exe',['-fsS','--max-time','30',url],{maxBuffer:20_000_000,encoding:'utf8'}));
  total ??= page.numberMatched;
  if (!Number.isSafeInteger(total) || total < 1 || page.numberMatched !== total || !page.features?.length || page.numberReturned !== page.features.length) throw Error('Incomplete WFS page');
  for (const f of page.features) {
    if (!f.id || ids.has(f.id)) throw Error('Duplicate or missing record ID');
    ids.add(f.id); records.push(f);
  }
} while(records.length < total);
if (records.length !== total) throw Error('WFS count mismatch');
const valid = records.filter(f => f.geometry?.type === 'LineString' && ['road','bridge','tunnel','roundabout','connector'].includes(f.properties.feature_type_code) &&
  [f.properties.from_ufi,f.properties.to_ufi].every(n=>Number.isSafeInteger(n)&&n>0));
const road = f => f.properties.ezi_road_name;
const nodes = f => [f.properties.from_ufi,f.properties.to_ufi];
const cost = f => f.geometry.coordinates.slice(1).reduce((sum,p,i)=>{
  const a = f.geometry.coordinates[i];
  return sum + Math.hypot((a[0]-p[0])*88,(a[1]-p[1])*111);
},0);
for (const plan of plans) {
  const {code,names,west,east} = plan;
  const termini = (a,b) => {
    const ns = new Set(valid.filter(f=>road(f)===b).flatMap(nodes));
    return [...new Set(valid.filter(f=>road(f)===a).flatMap(nodes).filter(n=>ns.has(n)))];
  };
  const point = node => {
    for(const f of valid) {const [a,b]=nodes(f);if(a===node)return f.geometry.coordinates[0];if(b===node)return f.geometry.coordinates.at(-1);}
  };
  const start = termini(names[0],west);
  const end = termini(names.at(-1),east).filter(node => code !== '20' || point(node)[0] > 145.10);
  const edges = new Map();
  for (const f of valid.filter(f=>names.includes(road(f)))) {
    const [a,b] = nodes(f);
    for (const [src,dst] of [[a,b],[b,a]]) {
      if(!edges.has(src)) edges.set(src,[]);
      for (const [index,name] of names.entries()) if (name===road(f)) edges.get(src).push({ dst, f, index, km:cost(f) });
    }
  }
  const key = (node,index) => `${node}:${index}`;
  const pending = start.map(node=>({node,index:0,km:0,path:[]}));
  const best = new Map();
  let match;
  while (pending.length) {
    pending.sort((a,b)=>b.km-a.km);
    const state = pending.pop();
    const id = key(state.node,state.index);
    if (best.has(id)) continue;
    best.set(id,state);
    if (end.includes(state.node) && state.index===names.length-1) {match=state;break;}
    for (const e of edges.get(state.node)||[]) {
      if(e.index!==state.index && e.index!==state.index+1) continue;
      if(!state.path.length && e.index!==0) continue;
      if(!best.has(key(e.dst,e.index))) pending.push({node:e.dst,index:e.index,km:state.km+e.km,path:[...state.path,{f:e.f,from:state.node,to:e.dst}]});
    }
  }
  const sections = [];
  const chosen = match?.path || [];
  for (const item of chosen) {
    const name=road(item.f), last=sections.at(-1);
    if(last?.road===name){last.endNode=item.to;last.records++;}
    else sections.push({road:name,startNode:item.from,endNode:item.to,records:1});
  }
  const pairs = names.slice(1).map((name,i)=>({from:names[i],to:name,sharedNodes:termini(names[i],name)}));
  if (chosen.length) writeFileSync(new URL(`./data/metropolitan-route-${code}-review.geojson`,import.meta.url), JSON.stringify({
    type:'FeatureCollection', audit:{code,status:'candidate_only_current_signing_unverified',retrievedAt,baseline,requests,start,end,pairs,sections,
      publisher:'State of Victoria, Department of Transport and Planning',licence:'CC BY 4.0 (Vicmap geometry)',
      method:'One shortest candidate along ordered road names and shared Vicmap junction IDs. Undirected; not proof of sign placement or permitted turns.'},
    features:chosen.map(({f,from,to})=>({...f,properties:{...f.properties,audit_from_node:from,audit_to_node:to}}))
  }));
  const furthest = Math.max(-1,...[...best.values()].map(s=>s.index));
  console.log(JSON.stringify({code,start,end,actualStart:chosen.length?point(chosen[0].from):null,actualEnd:chosen.length?point(chosen.at(-1).to):null,
    furthest:names[furthest],gaps:pairs.filter(p=>!p.sharedNodes.length),sections,records:chosen.length,approxKm:match?.km}));
}
