import {createPlm25Adapter,plm25Endpoint} from './plm25.js';
export const forestEndpoint=plm25Endpoint;
export const forestVersion='victorian-state-forest/2';
export const forestSource={name:'Victorian state forests - PLM25',type:'state_forest',format:'vic-state-forest',url:forestEndpoint,nameField:'name',idField:'plm_id',licence:'CC BY 4.0',attribution:'State of Victoria, Department of Energy, Environment and Climate Action (PLM25)',version:'PLM25; retrieved source snapshot',completeness:'partial',aliases:[],notes:'Official Victorian public land management polygons at 1:25,000. Includes only parcels currently classified STATE FOREST and carrying the requested published name; unnamed land is not inferred. https://discover.data.vic.gov.au/dataset/public-land-management-plm25'};
const adapter=createPlm25Adapter({type:'state_forest',format:'vic-state-forest',version:forestVersion,designation:'STATE FOREST',managementGroup:'STATE FOREST',title:'State Forest',noun:'forest',plural:'forests',slug:'state-forest',metadataKey:'forest'});
export const listStateForests=adapter.list;
export const importStateForest=adapter.importFeature;
export const processStateForest=adapter.process;
